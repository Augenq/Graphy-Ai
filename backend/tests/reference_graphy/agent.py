"""An event-driven agent loop, independent of the terminal."""

import asyncio
import copy
import json
import time
from collections import deque

import httpx

from .context import (
    assessment_due,
    compact,
    context_tokens,
    estimate,
    plan_due,
    request_context,
    system_prompt,
)
from .contracts import PUBLIC, normalize_optional
from .native import invoke
from .questions import validate_schema

# The form is a test tool: a handful of questions belongs in the chat as plain text.
MIN_FORM_QUESTIONS = 3
POLICY_RETRIES = 2  # repairs allowed; product constraints never become optional


class _NativePattern:
    """Keep the exported intent matchers while Rust owns their expressions."""

    def __init__(self, name):
        self.name = name

    def search(self, text):
        return invoke("agent.matches", {"pattern": self.name, "text": text})


NO_QUESTIONS = _NativePattern("NO_QUESTIONS")
REQUEST_QUIZ = _NativePattern("REQUEST_QUIZ")


def _intent_messages(session):
    return [{key: message[key] for key in ("role", "content", "name") if key in message}
            for message in session.messages]


def learner_declined_questions(session):
    """True when the learner's latest intent declined or cancelled a test."""
    return invoke("agent.learner_declined_questions", {"messages": _intent_messages(session)})


def truncation_hint(calls, by_count=True):
    return invoke("agent.truncation_hint", {
        "calls": calls, "by_count": by_count, "min_questions": MIN_FORM_QUESTIONS,
    })


def question_policy(session, call):
    return invoke("agent.question_policy", {
        "messages": _intent_messages(session), "call": call, "phase": session.learning.phase,
        "resolved_questions": bool(session.resolved_questions), "min_questions": MIN_FORM_QUESTIONS,
    })


class _StopTurn(Exception):
    """Ends the run quietly: the model keeps asking what the learner declined."""


class Agent:
    def __init__(self, session, tools, provider, model, emit, settings=None):
        self.session, self.tools, self.provider = session, tools, provider
        self.model, self.emit = model, emit
        self.settings = settings if settings is not None else {}
        self.steering: deque[dict] = deque()
        self.followups: deque[dict] = deque()
        self.task = None
        self.question_error = ""
        self.policy_rejections = 0
        self.failed_operations = 0
        self.call_repeats = {}

    @property
    def busy(self):
        return self.task is not None and not self.task.done()

    def queue(self, message, followup=False):
        (self.followups if followup else self.steering).append(message)

    def restore(self):
        messages = [*self.steering, *self.followups]
        self.steering.clear()
        self.followups.clear()
        return "\n\n".join(m.get("content", "") for m in messages)

    async def _add(self, message):
        self.session.add(message)
        await self.emit({"type": "message", "message": message})

    async def _request(self):
        retries = self.settings.get("retries", 3)
        for attempt in range(retries + 1):
            partial: dict = {"role": "assistant", "content": "", "thinking": ""}
            displayed = False

            thinking_since = 0.0

            async def delta(event, partial=partial):
                nonlocal displayed, thinking_since
                if not displayed:
                    await self.emit({"type": "message", "message": partial})
                    displayed = True
                key = "thinking" if event["type"] == "thinking_delta" else "content"
                partial[key] += event.get("delta", "")
                if key == "thinking":
                    # how long the reasoning ran, from its first to its latest words; kept with the message
                    now = time.monotonic()
                    thinking_since = thinking_since or now
                    partial["thinking_ms"] = round((now - thinking_since) * 1000)
                await self.emit(event)

            try:
                choice = "record_assessment" if assessment_due(self.session, self.tools) else (
                    "set_learning_plan" if plan_due(self.session, self.tools) else None)
                request_model = self.model | ({"tool_choice": choice} if choice else {})
                response = await self.provider.stream(
                    request_model,
                    request_context(self.session, self.tools),
                    system_prompt(self.session, self.tools),
                    self.tools.declarations,
                    self.session.thinking,
                    self.session.id,
                    delta,
                )
                partial.update(response)
                measured_context = request_context(self.session, self.tools)
                partial["context_measurement"] = {"characters": sum(len(json.dumps(
                    {k: v for k, v in m.items() if k not in ("images", "native")}, ensure_ascii=False))
                    for m in measured_context) + len(system_prompt(self.session, self.tools))
                    + len(json.dumps(self.tools.declarations, ensure_ascii=False)),
                    "images": sum(len(m.get("images", [])) for m in measured_context)}
                outcome = invoke("agent.request_outcome", {
                    "response": partial, "attempt": attempt, "retries": retries,
                })
                if outcome["retry"]:
                    # No answer at all (or only reasoning, which may be an inner monologue, not a reply): sample
                    # the same request again; the failed attempt is neither saved nor shown.
                    if displayed:
                        await self.emit({"type": "message_discarded", "message": partial})
                    if partial.get("usage"):
                        self.session.append("usage", usage=partial["usage"], purpose="empty_response")
                    await self.emit({"type": "status", "text": f"Пустой ответ модели, повтор {attempt + 1}/{retries}…"})
                    continue
                if outcome["empty"]:
                    partial["stop"] = "empty"
                if not displayed:
                    await self.emit({"type": "message", "message": partial})
                # Persist only once after a complete response, before tool preflight.
                self.session.add(partial)
                if partial.get("usage"):
                    self.session.append("usage", usage=partial["usage"], purpose="response")
                await self.emit({"type": "message_end", "message": partial})
                return partial
            except asyncio.CancelledError as exc:
                if displayed:
                    partial.update(getattr(exc, "partial", None) or {})
                    partial.update(stop="aborted", calls=[])
                    self.session.add(partial)
                    if partial.get("usage"):
                        self.session.append("usage", usage=partial["usage"], purpose="aborted")
                    await self.emit({"type": "message_end", "message": partial})
                raise
            except Exception as exc:
                if displayed:
                    partial.update(getattr(exc, "partial", None) or {})
                    partial.update(stop="error", calls=[])
                    self.session.add(partial)
                    if partial.get("usage"):
                        self.session.append("usage", usage=partial["usage"], purpose="error")
                    await self.emit({"type": "message_end", "message": partial})
                status = getattr(exc, "status", None)
                retryable = getattr(exc, "retryable", False) or isinstance(
                    exc, (httpx.TimeoutException, httpx.NetworkError)
                )
                decision = invoke("agent.retry", {
                    "displayed": displayed, "streamed": bool(getattr(exc, "streamed", False)),
                    "retryable": bool(retryable), "attempt": attempt, "retries": retries,
                    "retry_after": getattr(exc, "retry_after", None),
                })
                if not decision["retry"]:
                    raise
                delay = decision["delay"]
                await self.emit(
                    {
                        "type": "status",
                        "text": f"Retry {attempt + 1}/{retries} ({status or 'network'}) in {delay:g}s",
                    }
                )
                await asyncio.sleep(delay)

    async def _call(self, call, truncated=False, blocked=None):
        started = time.monotonic()
        result = await self._timed_call(call, truncated, blocked)
        return result | {"ms": round((time.monotonic() - started) * 1000)}

    async def _timed_call(self, call, truncated=False, blocked=None):
        await self.emit({"type": "tool_start", "call": call})

        async def update(text):
            await self.emit({"type": "tool_update", "call_id": call["id"], "text": text})

        try:
            state = self.session.learning
            preflight = invoke("agent.tool_preflight", {
                "call": call, "learning": [state.plan_version, state.phase, state.current_step,
                                            len(state.assessments), state.finished] if state else None,
                "call_repeats": self.call_repeats, "blocked": blocked,
                "public": call["name"] in PUBLIC, "truncated": truncated,
            })
            self.call_repeats = preflight["call_repeats"]
            if preflight["result"] is not None:
                result = preflight["result"]
            else:
                result = await self.tools.execute(call, update)
        except asyncio.CancelledError:
            result = {
                "content": "Interrupted; inspect state before repeating. Side effects may have occurred.",
                "error": True,
            }
            await self.emit({"type": "tool_end", "call": call, "result": result})
            return {"role": "tool", "call_id": call["id"], "name": call["name"], **result}
        except Exception as exc:
            message = f"{type(exc).__name__}: {exc}"
            store = getattr(self.tools, "store", None)
            result = {"content": store.redact(message) if store else message, "error": True}
        await self.emit({"type": "tool_end", "call": call, "result": result})
        return {"role": "tool", "call_id": call["id"], "name": call["name"], **result}

    async def _tools(self, response):
        calls = response.get("calls", [])
        if self.session.learning and any(c["name"] == "ask_questions" for c in calls):
            try:
                error = invoke("agent.question_preflight", {"response": response})
                if error:
                    raise ValueError(error)
                reason = question_policy(self.session, calls[0])
                if reason:
                    raise ValueError(reason)
                arguments = normalize_optional(PUBLIC["ask_questions"], calls[0].get("arguments", {}))
                if not any(isinstance(q, dict) and "id" in q for q in arguments.get("questions", [])):
                    validate_schema(PUBLIC["ask_questions"], arguments)
                if "ask_questions" not in {t["name"] for t in self.tools.declarations}:
                    raise ValueError("ask_questions is unavailable")
                else:
                    block = self.session.open_question(calls[0])
                    self.question_error = ""
                    self._batch_outcome(question=True)
                    await self.emit({"type": "question_opened", "block": block})
                    return
            except (ValueError, TypeError, KeyError) as exc:
                error = str(exc)
            self.question_error = error
            stop = self._batch_outcome(question=True, error=True)
            for call in calls:
                await self._add({"role": "tool", "call_id": call["id"], "name": call["name"],
                                 "content": "Not executed: NO questions were displayed. " + error
                                            + ". Fix this call or continue teaching without a form.", "error": True})
            if stop:
                raise _StopTurn(stop)
            return
        jobs = []
        results = []
        try:
            blocked = None
            for call in calls:
                job = asyncio.create_task(self._call(call, response.get("stop") == "length", blocked))
                jobs.append(job)
                results.append(await job)
                if results[-1].get("error"):
                    blocked = blocked or call["name"]
                current = asyncio.current_task()
                if current is not None and current.cancelling():
                    raise asyncio.CancelledError
        except asyncio.CancelledError:
            for job in jobs:
                job.cancel()
            finished = await asyncio.gather(*jobs, return_exceptions=True)
            results = [
                r
                if isinstance(r, dict)
                else {
                    "role": "tool",
                    "call_id": c["id"],
                    "name": c["name"],
                    "content": "Interrupted; outcome unknown. Inspect state before repeating.",
                    "error": True,
                }
                for c, r in zip(calls, finished, strict=False)
            ]
            # Sequential mode may not have started the remaining calls.
            for call in calls[len(results) :]:
                results.append(
                    {
                        "role": "tool",
                        "call_id": call["id"],
                        "name": call["name"],
                        "content": "Not executed: cancelled before this call.",
                        "error": True,
                    }
                )
            for result in results:
                await self._add(result)
            raise
        for result in results:
            await self._add(result)
        stop = self._batch_outcome(results=results)
        if stop:
            raise _StopTurn(stop)

    def _batch_outcome(self, **outcome):
        state = invoke("agent.batch_outcome", {
            "failed_operations": self.failed_operations, "policy_rejections": self.policy_rejections,
            "policy_retries": POLICY_RETRIES, **outcome,
        })
        self.failed_operations = state["failed_operations"]
        self.policy_rejections = state["policy_rejections"]
        return state["stop"]

    async def run(self, message=None):
        if self.session.pending_question:
            raise ValueError("Answer or cancel the open question block first")
        await self.emit({"type": "status", "text": "Working…"})
        self.policy_rejections = 0
        self.question_error = ""
        self.failed_operations = 0
        self.call_repeats = {}
        try:
            if message is not None:
                await self._add(copy.deepcopy(message))
            overflow_compacted = False
            while True:
                if self.steering:
                    await self._add(self.steering.popleft())
                auto_compact = self.settings.get("auto_compact", True)
                budget = invoke("agent.context_policy", {
                    "model": self.model, "auto_compact": auto_compact,
                    "tokens": context_tokens(self.session, self.tools, self.model) if auto_compact else 0,
                })
                limit = budget["limit"]
                overhead = ((len(system_prompt(self.session, self.tools))
                             + len(json.dumps(self.tools.declarations, ensure_ascii=False))) // 4
                            if self.session.learning else 0)
                if budget["compact"]:
                    try:
                        await compact(
                            self.session, self.provider, self.model, keep=budget["keep"], emit=self.emit
                        )
                    except ValueError as exc:
                        # The size is only an estimate: with nothing safe to compact, let the server decide
                        # instead of silently ending the lesson turn.
                        if not self.session.learning or self.session.pending_question:
                            raise
                        await self.emit({"type": "status", "text": str(exc)})
                    else:
                        # The estimate is rough (chars/4); fail only when the prompt alone cannot fit.
                        if self.session.learning and estimate(self.session.context) + overhead > limit - 256:
                            raise ValueError("Текущий блок ответов и инструкции не помещаются в контекст. "
                                             "Выберите модель с большим контекстом; ответы сохранены.")
                try:
                    response = await self._request()
                except Exception as exc:
                    status = getattr(exc, "status", None)
                    if invoke("agent.overflow", {
                        "compacted": overflow_compacted, "status": status,
                        "context_overflow": bool(getattr(exc, "context_overflow", False)),
                    }):
                        await compact(
                            self.session,
                            self.provider,
                            self.model,
                            keep=budget["keep"],
                            emit=self.emit,
                        )
                        overflow_compacted = True
                        continue
                    raise
                overflow_compacted = False
                decision = invoke("agent.response_action", {
                    "response": response, "question_error": self.question_error,
                    "steering": bool(self.steering), "followups": bool(self.followups),
                })
                action = decision["action"]
                if action in ("provider_error", "aborted"):
                    await self.emit({"type": "status", "text": "Provider stopped without a complete response."})
                    if action == "provider_error":
                        raise ValueError(decision["error"])
                    break
                if action == "error":
                    raise ValueError(decision["error"])
                if action == "tools":
                    await self._tools(response)
                    if self.session.pending_question:
                        break
                    continue
                self.question_error = ""
                if action == "continue":
                    continue
                if action == "followup":
                    await self._add(self.followups.popleft())
                    continue
                break
        except _StopTurn as exc:
            await self.emit({"type": "notice", "text": str(exc), "error": True})
        finally:
            await self.emit({"type": "status", "text": ""})
