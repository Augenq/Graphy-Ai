"""Append-only, linear JSONL sessions with crash recovery and an exclusive writer."""

import copy
import json
import os
import time
import uuid
from pathlib import Path

from filelock import FileLock, Timeout

from .evidence import collect, reference
from .learning import LearningState
from .questions import (
    SUBMITTED_NOTE,
    TEXT,
    blank_answer,
    formal_results,
    learner_answers,
    normalize_questions,
    obj,
    validate_answers,
    validate_questions,
    validate_schema,
)
from .styles import DEFAULT_STYLE, validate_style

DEFAULT_COURSE = "00000000000000000000000000000000"


def session_folder(root, cwd, course_id=DEFAULT_COURSE):
    if not isinstance(course_id, str) or not course_id or any(c not in "0123456789abcdef-" for c in course_id):
        raise ValueError("Invalid course ID")
    return root / "learning" / "courses" / course_id / "sessions"


class Session:
    def __init__(self, root: Path, cwd: Path, path: Path | None = None, *, course_id=DEFAULT_COURSE):
        self.root = root
        self.cwd = str(cwd.resolve())
        self.course_id = course_id
        self.learning = LearningState()
        self.pending_question: dict | None = None
        self.resolved_questions: dict[str, dict] = {}
        folder = session_folder(root, cwd, course_id)
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = path or folder / f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}.jsonl"
        if path and path.resolve().parent != folder.resolve():
            raise ValueError("Session does not belong to this working directory")
        self.lock = FileLock(str(self.path) + ".lock")
        try:
            self.lock.acquire(timeout=0)
        except Timeout as exc:
            raise ValueError("This session is open in another process") from exc
        self.events: list[dict] = []
        self.messages: list[dict] = []
        self.model = ""
        self.thinking = "off"
        self.explanation_style = DEFAULT_STYLE
        self.name = ""
        self.summary = ""
        self.boundary = 0
        self.warning = ""
        self.operation_results: dict[str, dict] = {}
        self._write_failed = False
        try:
            self._load()
            if not self.events:
                self.append("header", version=2, id=uuid.uuid4().hex,
                            cwd=self.cwd, created=time.time(), course_id=course_id)
            else:
                self._repair_tools()
        except BaseException:
            self.close()
            raise

    def _load(self):
        if not self.path.exists():
            return
        data = self.path.read_bytes()
        lines = data.splitlines(keepends=True)
        good = 0
        for index, line in enumerate(lines):
            try:
                event = json.loads(line)
                if not isinstance(event, dict) or "type" not in event:
                    raise ValueError("Invalid session record")
                self._validate_event(event)
            except (ValueError, KeyError, TypeError):
                if index != len(lines) - 1:
                    raise ValueError(f"Invalid session record at line {index + 1}") from None
                # Preserve the damaged tail before making the file appendable again.
                backup = self.path.with_suffix(f".damaged-{time.time_ns()}")
                backup.write_bytes(data[good:])
                with self.path.open("r+b") as stream:
                    stream.truncate(good)
                self.warning = "Recovered session; damaged tail was preserved separately."
                break
            self._apply(event)
            good += len(line)
        if self.events:
            header = self.events[0]
            valid = header.get("version") == 2 and header.get("course_id") == self.course_id
            if not valid:
                raise ValueError("Unsupported session version or working directory")
            if good and not data[:good].endswith(b"\n"):
                with self.path.open("ab") as stream:
                    stream.write(b"\n")

    def _apply(self, event):
        self.events.append(event)
        if event["type"] == "learning_transaction":
            for operation in event["operations"]:
                self.learning.apply(operation)
            if event.get("source_call"):
                self.operation_results[event["source_call"]] = event["result"]
            return
        match event["type"]:
            case "message":
                self.messages.append(event["message"])
            case "model":
                self.model, self.thinking = event["model"], event["thinking"]
            case "explanation_style":
                self.explanation_style = event["explanation_style"]
            case "name":
                self.name = event["name"]
            case "compact":
                self.summary, self.boundary = event["summary"], event["boundary"]
            case "question_opened":
                self.pending_question = event["block"]
            case "question_draft":
                if self.pending_question and self.pending_question["batch_id"] == event["batch_id"]:
                    self.pending_question = self.pending_question | {
                        "answers": event["answers"], "step": event["step"]}
            case "question_resolved":
                block = self.pending_question
                self.resolved_questions[event["batch_id"]] = {
                    "block": block, "payload": event["payload"], "message_id": event["message"]["id"]}
                self.pending_question = None
                self.messages.append(event["message"])
        if self.learning:
            self.learning.apply(event)

    def append(self, kind: str, **fields):
        if self._write_failed:
            raise OSError("Previous session write failed; reopen this session to recover before continuing")
        event = {"type": kind, "time": time.time(), **fields}
        self._validate_event(event)
        line = json.dumps(event, ensure_ascii=False, allow_nan=False) + "\n"
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(line)
                stream.flush()
                os.fsync(stream.fileno())
        except OSError:
            self._write_failed = True
            raise
        self._apply(event)

    def _validate_event(self, event):
        kind = event["type"]
        if not isinstance(kind, str):
            raise ValueError("Invalid event type")
        if kind == "explanation_style":
            validate_style(event.get("explanation_style"))
        if not kind.startswith(("question_", "learning_")):
            return
        if self.learning is None:
            raise ValueError("Learning events require a learning session")
        if kind == "learning_transaction":
            if event.get("version") != 1 or not isinstance(event.get("operations"), list):
                raise ValueError("Unsupported learning transaction")
            if not isinstance(event.get("result"), dict) or not event.get("source_call"):
                raise ValueError("Transaction needs its operation ID and result")
            saved = self.learning
            self.learning = copy.deepcopy(saved)
            try:
                for operation in event["operations"]:
                    if operation.get("type") not in ("learning_plan", "learning_phase", "learning_assessment", "learning_finished", "learning_evidence_ignored"):
                        raise ValueError("Unsupported transaction operation")
                    self._validate_event(operation)
                    self.learning.apply(operation)
            finally:
                self.learning = saved
        elif kind == "question_opened":
            block = event["block"]
            if self.pending_question or block["batch_id"] in self.resolved_questions:
                raise ValueError("A question is already open or resolved")
            raw = {k: v for k, v in block.items() if k not in ("batch_id", "answers", "step")}
            validate_questions(raw, {s["id"] for s in self.learning.steps})
            owner = next((m for m in self.messages if any(
                c["id"] == block["batch_id"] for c in m.get("calls", []))), None)
            if (not owner or len(owner.get("calls", [])) != 1 or owner["calls"][0]["name"] != "ask_questions"
                    or normalize_questions(owner["calls"][0]["arguments"]) != raw
                    or owner.get("stop") in ("length", "error", "aborted", "empty")):
                raise ValueError("A question must match a complete, standalone assistant call")
            if block["answers"] != [blank_answer(q) for q in block["questions"]] or block["step"] != 0:
                raise ValueError("New questions must start with empty drafts")
        elif kind in ("question_draft", "question_resolved"):
            block = self.pending_question
            if not block or block["batch_id"] != event["batch_id"]:
                raise ValueError("Question event does not match an open block")
            if kind == "question_draft":
                validate_answers(block, event["answers"])
                if type(event["step"]) is not int or not 0 <= event["step"] <= len(block["questions"]):
                    raise ValueError("Invalid step")
            else:
                payload, message = event["payload"], event["message"]
                if payload["status"] not in ("submitted", "cancelled") or payload["batch_id"] != event["batch_id"]:
                    raise ValueError("Invalid question resolution")
                values = validate_answers(block, payload["answers"], final=payload["status"] == "submitted")
                scores = formal_results(block, values) if payload["status"] == "submitted" else []
                if payload.get("formal_results") != scores:
                    raise ValueError("Invalid formal results")
                if (message.get("role") != "tool" or message.get("name") != "ask_questions" or not message.get("id")
                        or message.get("call_id") != event["batch_id"] or json.loads(message["content"]) != payload):
                    raise ValueError("Invalid question tool result")
        elif kind.startswith("learning_"):
            from .learning_tools import DEFINITIONS

            schemas = {"learning_plan": "set_learning_plan", "learning_phase": "set_learning_phase",
                       "learning_assessment": "record_assessment", "learning_finished": "finish_lesson"}
            data = event["data"]
            if kind == "learning_goal":
                validate_schema(obj({"goal": TEXT}, ["goal"]), data)
            elif kind == "learning_evidence_ignored":
                validate_schema(obj({"refs": {"type": "array", "maxItems": 8, "items": {"type": "string"}}}, ["refs"]), data)
                for ref in data["refs"]:
                    if ref not in self.evidence or not self.evidence[ref].get("candidate"):
                        raise ValueError("Only chat candidates can be marked as non-attempts; submitted tests must be assessed")
            elif kind == "learning_skill":
                validate_schema(obj({"name": TEXT | {"maxLength": 64},
                                     "path": TEXT | {"maxLength": 4096},
                                     "instructions": {"type": "string", "maxLength": 49152}}, ["name", "path"]), data)
            elif kind in ("learning_sources", "learning_source_notes"):
                pass  # legacy events of the removed source search; kept readable, never written
            elif kind in schemas:
                schema = DEFINITIONS[schemas[kind]][1]
                values = {k: v for k, v in data.items() if k in schema["properties"]}
                validate_schema(schema, values)
                if kind == "learning_plan" and len({s["id"] for s in data["steps"]}) != len(data["steps"]):
                    raise ValueError("Duplicate plan IDs")
                if kind == "learning_phase" and data.get("current_step") not in (
                        None, "", *[s["id"] for s in self.learning.steps]):
                    raise ValueError("Unknown current step")
                if kind == "learning_assessment" and not data.get("batch_id"):
                    answer = data.get("answer")
                    if (data.get("question_id") or not data.get("question") or not isinstance(answer, dict)
                            or not isinstance(answer.get("text"), str) or not answer["text"]):
                        raise ValueError("Chat assessment needs question and answer text")
                    if data["used_hints"] and data["outcome"] == "independent":
                        raise ValueError("An answer with hints cannot be independent")
                    if any(a["id"] == data["id"] for a in self.learning.assessments):
                        raise ValueError("Duplicate assessment ID")
                    if data.get("supersedes") and not any(a["id"] == data["supersedes"]
                                                          for a in self.learning.assessments):
                        raise ValueError("No earlier assessment to supersede")
                    if data.get("evidence_ref"):
                        evidence = self.evidence.get(data["evidence_ref"])
                        if (not evidence or evidence["source_message_id"] != data.get("source_message_id")
                                or evidence["answer"]["text"] != answer["text"]):
                            raise ValueError("Assessment must reference the original learner reply")
                elif kind == "learning_assessment":
                    resolved = self.resolved_questions.get(data["batch_id"])
                    if (not resolved or resolved["payload"]["status"] != "submitted"
                            or not any(a["question_id"] == data["question_id"] for a in resolved["payload"]["answers"])
                            or data.get("source_message_id") != resolved["message_id"]):
                        raise ValueError("Assessment requires the exact submitted answer")
                    answer = next(a for a in resolved["payload"]["answers"] if a["question_id"] == data["question_id"])
                    question = next(q for q in resolved["block"]["questions"] if q["id"] == data["question_id"])
                    if (data.get("answer") != answer or data.get("question") != question["prompt"]
                            or data.get("topic_id") != question.get("topic_id", "")):
                        raise ValueError("Assessment evidence must match the original question and answer")
                    if (answer["status"] == "skipped") != (data["outcome"] == "skipped"):
                        raise ValueError("Skipped answers require the skipped outcome")
                    if data["used_hints"] and data["outcome"] == "independent":
                        raise ValueError("An answer with hints cannot be independent")
                    if any(a["id"] == data["id"] for a in self.learning.assessments):
                        raise ValueError("Duplicate assessment ID")
                    previous = [a for a in self.learning.assessments if a["batch_id"]
                                and (a["batch_id"], a["question_id"]) == (data["batch_id"], data["question_id"])]
                    if previous and data.get("supersedes") != previous[-1]["id"]:
                        raise ValueError("Use supersedes to correct the latest assessment of this answer")
                    if not previous and data.get("supersedes"):
                        raise ValueError("No earlier assessment to supersede")
            else:
                raise ValueError("Unsupported learning event")

    def add(self, message: dict):
        message.setdefault("id", uuid.uuid4().hex)
        self.append("message", message=message)

    def _repair_tools(self):
        # A tool with no durable result may already have had side effects; never replay it.
        answered = {m.get("call_id") for m in self.messages if m["role"] == "tool"}
        pending = [c for m in self.messages for c in m.get("calls", []) if c["id"] not in answered]
        for call in pending:
            owner = next(m for m in self.messages if call in m.get("calls", []))
            if call["id"] in self.operation_results:
                self.add({"role": "tool", "call_id": call["id"], "name": call["name"],
                          "content": json.dumps(self.operation_results[call["id"]], ensure_ascii=False)})
                continue
            if (self.learning and call["name"] == "ask_questions" and len(owner.get("calls", [])) == 1
                    and owner.get("stop") not in ("length", "error", "aborted", "empty")):
                if self.pending_question and self.pending_question["batch_id"] == call["id"]:
                    continue
                if self.pending_question is None:
                    try:
                        from .agent import question_policy

                        reason = question_policy(self, call)
                        if reason:
                            raise ValueError(reason)
                        self.open_question(call)
                        continue
                    except ValueError:
                        pass
            self.add(
                {
                    "role": "tool",
                    "call_id": call["id"],
                    "name": call["name"],
                    "content": "Interrupted. Outcome unknown; inspect state before repeating.",
                    "error": True,
                }
            )

    @property
    def needs_continuation(self):
        if not self.learning or self.pending_question or not self.messages:
            return False
        last = self.messages[-1]
        return last["role"] in ("tool", "user") or last.get("stop") in ("error", "aborted", "empty")

    def open_question(self, call):
        if not self.learning:
            raise ValueError("Questions require a learning session")
        if self.pending_question or call["id"] in self.resolved_questions:
            raise ValueError("A question is already open or has already been answered")
        topics = {s["id"] for s in self.learning.steps}
        block = validate_questions(normalize_questions(call.get("arguments")), topics)
        block.update(batch_id=call["id"], step=0,
                     answers=[blank_answer(q) for q in block["questions"]])
        self.append("question_opened", block=block)
        return self.pending_question

    def save_question_draft(self, batch_id, answers, step):
        block = self.pending_question
        if not block or block["batch_id"] != batch_id:
            raise ValueError("This question block is no longer open")
        if type(step) is not int or not 0 <= step <= len(block["questions"]):
            raise ValueError("Invalid question step")
        values = validate_answers(block, answers)
        if values != block["answers"] or step != block["step"]:
            self.append("question_draft", batch_id=batch_id, answers=values, step=step)

    def resolve_question(self, batch_id, answers, *, cancel=False):
        block = self.pending_question
        if not block or block["batch_id"] != batch_id:
            raise ValueError("This block has already been resolved or is no longer open")
        values = validate_answers(block, answers, final=not cancel)
        payload = {"batch_id": batch_id, "status": "cancelled" if cancel else "submitted",
                   "answers": values, "formal_results": [] if cancel else formal_results(block, values)}
        if not cancel:
            payload["note"] = SUBMITTED_NOTE
            payload["learner_answers"] = learner_answers(block, values, payload["formal_results"])
        if cancel:
            payload["note"] = ("The learner deliberately cancelled this block; it was not a technical failure. "
                               "Do NOT resend or rephrase these questions. Briefly acknowledge and ask in one "
                               "sentence what they would like instead (simpler, another topic, a break).")
        message = {"id": uuid.uuid4().hex, "role": "tool", "call_id": batch_id,
                   "name": "ask_questions", "content": json.dumps(payload, ensure_ascii=False)}
        self.append("question_resolved", batch_id=batch_id, payload=payload, message=message)
        return message

    @property
    def evidence(self):
        return collect(self)

    def transact(self, operations, source_call, result):
        if source_call in self.operation_results:
            return self.operation_results[source_call]
        self.append("learning_transaction", version=1, operations=operations,
                    source_call=source_call, result=result)
        return result

    def question_projection(self, message):
        """Only the model projection is compact; the durable payload and UI stay complete."""
        resolved = self.resolved_questions.get(message.get("call_id"))
        if not resolved:
            return message
        payload = resolved["payload"]
        if payload["status"] == "cancelled":
            value: dict = {"status": "cancelled", "note": "The learner cancelled this test. Do not reopen it unless requested."}
        else:
            scores = {row["question_id"]: row["correct"] for row in payload["formal_results"]}
            attempts = []
            for question, answer in zip(resolved["block"]["questions"], payload["answers"], strict=True):
                labels = {option["id"]: option["label"] for option in question.get("options", [])}
                attempt = {"evidence_ref": reference(message["id"], question["id"]),
                           "question": question["prompt"], "status": answer["status"],
                           "answer": answer["text"] or [labels[i] for i in answer["selected_option_ids"]],
                           "reasoning": answer["reasoning"], "key_verdict": scores[question["id"]]}
                if answer["selected_option_ids"]:
                    attempt["selected_option_numbers"] = [i for i, option in enumerate(question["options"], 1)
                                                          if option["id"] in answer["selected_option_ids"]]
                attempts.append(attempt)
            value = {"status": "submitted", "attempts": attempts,
                     "note": "Choice answers contain selected option TEXTS. selected_option_numbers are validated UI selections, not typed answers. Assess their meaning and reasoning; never mark a correct selection wrong for its transport format. Grade against the key you committed in your call; status dont_know is a declared gap, not an error."}
        return message | {"content": json.dumps(value, ensure_ascii=False, separators=(",", ":"))}

    @property
    def context(self) -> list[dict]:
        prefix = (
            [{"role": "user", "content": f"Earlier conversation summary:\n{self.summary}"}]
            if self.summary
            else []
        )
        return prefix + [self.question_projection(m) if m.get("name") == "ask_questions" else m
                         for m in self.messages[self.boundary :] if m.get("stop") != "empty"]

    @property
    def id(self):
        return self.events[0]["id"]

    def select(self, model: str, thinking: str):
        self.append("model", model=model, thinking=thinking)

    def usage(self):
        values = [e.get("usage", {}) for e in self.events if e["type"] == "usage"]
        totals = {
            k: sum(v.get(k, 0) for v in values) for k in ("input", "output", "cache_read", "cache_write")
        }
        totals["cost"] = sum(v["cost"] for v in values if v.get("cost") is not None)
        totals["unknown_cost"] = any(v.get("cost") is None for v in values)
        return totals

    def close(self):
        self.lock.release()

    @staticmethod
    def list(root: Path, cwd: Path, course_id=DEFAULT_COURSE) -> list[dict]:
        rows = []
        for path in session_folder(root, cwd, course_id).glob("*.jsonl"):
            name, said = "", 0
            preferences = {"explanation_style": DEFAULT_STYLE}
            try:
                for line in path.read_text(encoding="utf-8").splitlines():
                    try:
                        event = json.loads(line)
                        if event.get("type") == "name":
                            name = event["name"]
                        if event.get("type") == "explanation_style":
                            preferences["explanation_style"] = validate_style(event.get("explanation_style"))
                        if event.get("type") == "message" and event["message"]["role"] == "user":
                            said += 1
                            if not name:
                                message = event["message"]
                                name = " ".join(message.get("display", message["content"]).split())[:65]
                    except (ValueError, KeyError, TypeError, AttributeError):
                        continue  # a stray line is not a reason to hide the other chats
                rows.append({"path": path, "name": name or path.stem, "modified": path.stat().st_mtime,
                             "said": said, **preferences})
            except (OSError, ValueError):  # unreadable, or not UTF-8 at all
                continue
        return sorted(rows, key=lambda row: row["modified"], reverse=True)
