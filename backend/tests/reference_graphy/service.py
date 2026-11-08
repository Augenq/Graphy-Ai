"""Headless application core: lessons, models, providers and settings without a terminal.

`Program` drives one chat through a TUI. `Service` offers the same capabilities to any number of clients:
several chats stay open at once, each with its own agent, and everything that happens is published on one
event bus. The local HTTP server (`server.py`) is a thin shell around this class.
"""

import asyncio
import contextlib
import os
import re
import shutil
import time
import uuid
from pathlib import Path

from . import __version__
from .agent import Agent
from .auth import login_codex
from .common import endpoint_url, identifier
from .context import compact, context_tokens
from .courses import Courses
from .learning_tools import LearningTools
from .migration import purge_coding_sessions
from .models import LOCAL, PRESETS, Catalog, settings
from .providers import Providers
from .session import Session, session_folder
from .skills import Skills
from .storage import Store
from .styles import DEFAULT_STYLE, PREFERENCES, validate_preference, validate_style
from .tools import DEFINITIONS, image_file
from .web import DEFAULT_PROVIDER, PROVIDERS
from .web import DEFINITIONS as WEB_DEFINITIONS
from .wire import (
    history,
    learning_projection,
    public_call,
    public_message,
    public_question,
    public_result,
    resolved_questions,
)

PROTOCOL = 1
SESSION_ID = re.compile(r"^[0-9A-Za-z_-]{1,80}$")
IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")
THINKING_LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh", "max")
CUSTOM_APIS = ("chat", "responses", "anthropic", "google")
TOOL_NAMES = [*DEFINITIONS, *WEB_DEFINITIONS, "load_skill"]
QUEUE_LIMIT = 2000
TITLE_SYSTEM = ("Name this learning session. Reply with only a title: 2–6 words in the learner's language, "
                "without quotes, a final period, or explanations.")
TITLE_MAX = 60


def clean_title(text):
    """A model's reply as a lesson title: its first line, no markup or quotes, a sensible length."""
    line = next((line for line in text.strip().splitlines() if line.strip()), "")
    previous = None
    while line != previous:  # quotes, markup and the closing full stop wrap each other
        previous = line
        line = " ".join(line.strip(" \t\"'`«»“”*#_-:").split()).rstrip(".!?…")
    if len(line) > TITLE_MAX:
        line = line[:TITLE_MAX].rsplit(" ", 1)[0]
    return line.strip()


class ApiError(Exception):
    """An expected failure with a stable code for the client."""

    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


class Subscription:
    def __init__(self):
        self.queue: asyncio.Queue = asyncio.Queue(QUEUE_LIMIT)
        self.lagged = False
        self.closed = False


class EventBus:
    """Fan-out of numbered events. A client that cannot keep up is told to resynchronize, never blocked on."""

    def __init__(self):
        self.seq = 0
        self.subscribers: set[Subscription] = set()

    def publish(self, event):
        self.seq += 1
        event = {"seq": self.seq, "time": time.time(), **event}
        for subscription in self.subscribers:
            try:
                subscription.queue.put_nowait(event)
            except asyncio.QueueFull:
                subscription.lagged = True
        return event

    def subscribe(self):
        subscription = Subscription()
        self.subscribers.add(subscription)
        return subscription

    def unsubscribe(self, subscription):
        self.subscribers.discard(subscription)

    def close(self):
        """Ends every stream: the sentinel wakes a waiting reader, the flag stops one behind a full queue."""
        for subscription in self.subscribers:
            subscription.closed = True
            with contextlib.suppress(asyncio.QueueFull):
                subscription.queue.put_nowait(None)


class Runtime:
    """One open chat: its session file (exclusively locked), tools, and at most one running operation."""

    def __init__(self, service, session):
        self.service, self.session = service, session
        self.tools = LearningTools(service.cwd, session, service.store.prefs.get("learning_tools"),
                                   store=service.store)
        self.agent: Agent | None = None
        self.operation: asyncio.Task | None = None
        self.activity = ""
        self.streaming = ""
        self.titling = False
        self.closed = False
        self.ensure_model()

    @property
    def id(self):
        return self.session.path.stem

    @property
    def model(self):
        return self.service.catalog.get(self.session.model)

    @property
    def busy(self):
        return self.operation is not None and not self.operation.done()

    def ensure_model(self):
        if self.session.model:
            return
        store = self.service.store
        available = self.service.catalog.available()
        selected = (store.prefs.get("last_model") or store.prefs.get("default_model")
                    or (identifier(available[0]) if available else "openai/gpt-5.4"))
        levels = self.service.catalog.get(selected).get("thinking_levels", ["off"])
        thinking = store.prefs.get("default_thinking", "off")
        self.session.select(selected, thinking if thinking in levels else levels[0])

    def publish(self, event):
        return self.service.bus.publish({"session_id": self.id, **event})

    # ---------------------------------------------------------------- projections

    def context(self):
        model = self.model
        used = context_tokens(self.session, self.tools, model)
        limit = model.get("context", 32768)
        return {"used": used, "limit": limit, "percent": round(used / max(1, limit) * 100, 1)}

    def summary(self):
        header = self.session.events[0]
        users = [m for m in self.session.messages if m.get("role") == "user"]
        first = " ".join(users[0].get("display", users[0].get("content", "")).split())[:65] if users else ""
        said = len(users)
        return {"id": self.id, "course_id": self.session.course_id, "name": self.session.name or first,
                "created": header.get("created"), "said": said, "busy": self.busy,
                "model": self.session.model, "thinking": self.session.thinking,
                "explanation_style": self.session.explanation_style}

    def snapshot(self):
        session = self.session
        return self.summary() | {
            "seq": self.service.bus.seq,
            "messages": history(session),
            "learning": learning_projection(session),
            "question": public_question(session.pending_question) if session.pending_question else None,
            "resolved_questions": resolved_questions(session),
            "context": self.context(),
            "usage": session.usage(),
            "activity": self.activity,
            "needs_continuation": session.needs_continuation,
            "warning": session.warning,
            "queued": len(self.agent.steering) + len(self.agent.followups) if self.agent else 0,
        }

    # ---------------------------------------------------------------- agent events

    async def emit(self, event):
        """Agent events -> wire events. Messages get their id before the first delta, so a stream is addressable."""
        kind = event["type"]
        if kind in ("message", "message_end"):
            message = event["message"]
            message.setdefault("id", uuid.uuid4().hex)
            if kind == "message" and message.get("role") == "assistant":
                self.streaming = message["id"]
            self.publish({"type": kind, "message": public_message(self.session, message, at=time.time())})
            if kind == "message" and message.get("role") == "tool" and message.get("name") in (
                    "set_learning_plan", "set_learning_phase", "record_assessment", "finish_lesson"):
                self.publish({"type": "learning", "learning": learning_projection(self.session)})
            if kind == "message_end":
                self.publish({"type": "context", "context": self.context()})
        elif kind in ("text_delta", "thinking_delta"):
            self.publish({"type": kind, "message_id": self.streaming, "delta": event.get("delta", "")})
        elif kind == "message_discarded":
            self.publish({"type": kind, "message_id": event["message"].get("id", "")})
        elif kind == "tool_start":
            self.publish({"type": kind, "call": public_call(event["call"])})
        elif kind == "tool_update":
            self.publish({"type": kind, "call_id": event.get("call_id", ""), "text": event.get("text", "")})
        elif kind == "tool_end":
            call = event["call"]
            self.publish({"type": kind, "call": public_call(call), "result": public_result(call, event.get("result"))})
        elif kind == "question_opened":
            self.publish({"type": kind, "block": public_question(event["block"])})
        elif kind == "status":
            self.activity = event.get("text", "")
            self.publish({"type": kind, "text": self.activity})
        elif kind == "notice":
            self.publish({"type": kind, "text": self.service.store.redact(event.get("text", "")),
                          "error": bool(event.get("error"))})

    def notice(self, text, error=False):
        self.publish({"type": "notice", "text": text, "error": error})

    # ---------------------------------------------------------------- operations

    def launch(self, work, *, with_agent=True, message=None):
        """Run `work` as the chat's single operation; returns at once, the outcome arrives as events."""
        if self.busy:
            raise ApiError(409, "busy", "Another operation is still running in this chat")
        if with_agent:
            self.agent = Agent(self.session, self.tools, self.service.providers, self.model, self.emit,
                               self.service.store.prefs)
            self.attach_memory(message)
        else:
            self.agent = None
        self.operation = asyncio.create_task(self._operation(work))
        if self.agent:
            self.agent.task = self.operation
        self.publish({"type": "busy", "busy": True})

    def attach_memory(self, message=None):
        last = next((m["content"] for m in reversed(self.session.messages) if m.get("role") == "user"), "")
        if message is not None:
            last = message.get("content", last)
        learning = self.session.learning
        query = " ".join([learning.goal, last[:500], *(s["title"] for s in learning.steps)])
        self.tools.memory = self.service.courses.memory(self.session.course_id, query,
                                                        exclude_session=self.session.id)

    async def _operation(self, work):
        try:
            await work()
        except asyncio.CancelledError:
            self.notice("Остановлено. Сохранённая работа не потеряна.")
        except Exception as exc:
            self.notice(self.service.store.redact(str(exc)), error=True)
        finally:
            remaining = self.agent.restore() if self.agent else ""
            self.activity = ""
            self.operation = None
            if remaining:
                self.publish({"type": "queue_restored", "text": remaining})
            self.publish({"type": "status", "text": ""})
            with contextlib.suppress(Exception):
                self.publish({"type": "context", "context": self.context()})
            self.publish({"type": "learning", "learning": learning_projection(self.session)})
            self.publish({"type": "busy", "busy": False, "needs_continuation": self.session.needs_continuation})
            self.service.spawn(self.generate_title())

    async def generate_title(self):
        """Once, after the first answer: the model names the lesson. A failure leaves the name derived from the
        first message; it is never an error for the learner."""
        session = self.session
        if session.name or self.titling or not self.service.auto_title:
            return
        users = [m for m in session.messages if m.get("role") == "user"]
        reply = next((m for m in session.messages if m.get("role") == "assistant" and (m.get("content") or "").strip()), None)
        if not users or reply is None:
            return
        self.titling = True
        try:
            asked = users[0].get("display", users[0].get("content", ""))[:600]
            prompt = f"Learner message:\n{asked}\n\nStart of agent reply:\n{reply['content'][:600]}"
            response = await self.service.providers.stream(
                self.model, [{"role": "user", "content": prompt}], TITLE_SYSTEM, [], "off", session.id, _ignore)
            if response.get("usage"):
                session.append("usage", usage=response["usage"], purpose="title")
            title = clean_title(response.get("content", "")) if response.get("stop", "stop") == "stop" else ""
            if title and not session.name and not self.closed:
                session.append("name", name=title)
                self.publish({"type": "session_updated", "session": self.summary()})
        except Exception:
            pass  # the first words of the lesson stay as its name
        finally:
            self.titling = False

    async def run_agent(self, message=None):
        if not self.model.get("tools", True):
            raise ValueError("This model does not support tool calls; choose an agent-capable model.")
        assert self.agent is not None
        await self.agent.run(message)

    async def attachments(self, text, paths):
        """The user message: inline text files and images; the original wording and chips stay for display."""
        mentions = []
        # @"path with spaces" or @path; unmatched @names remain ordinary text.
        for match in re.finditer(r'(?<!\S)@(?:"([^"\n]+)"|\x27([^\x27\n]+)\x27|([^\s]+))', text):
            mentions.append(next(value for value in match.groups() if value))
        mentions += list(paths)
        images, chunks, chips, seen = [], [], [], set()
        prefs = self.service.store.prefs
        for mention in mentions:
            path = self.tools.path(mention)
            if not path.is_file() or path in seen:
                continue
            seen.add(path)
            if path.suffix.lower() in IMAGE_SUFFIXES:
                if prefs.get("block_images", False):
                    raise ValueError("Изображения отключены в настройках")
                if not self.model.get("vision"):
                    raise ValueError("Эта модель не принимает изображения. Выберите модель с поддержкой vision.")
                images.append(await asyncio.to_thread(image_file, path))
                chips.append({"name": path.name, "path": str(path), "kind": "image", "size": path.stat().st_size})
            else:
                result = await self.tools.execute({"name": "read", "arguments": {"path": str(path)}})
                if result.get("error"):
                    raise ValueError(result["content"])
                chunks.append(f"\n\nAttached file {path}:\n{result['content']}")
                chips.append({"name": path.name, "path": str(path), "kind": "file", "size": path.stat().st_size})
        message = {"role": "user", "content": text + "".join(chunks)}
        if images:
            message["images"] = images
        if chips:
            message |= {"display": text, "attachments": chips}
        return message

    async def send(self, text, followup=False, paths=()):
        if not text.strip() and not paths:
            raise ValueError("Message is empty")
        if self.session.pending_question:
            raise ApiError(409, "question_open", "Сначала отправьте или отмените открытый блок вопросов.")
        message = await self.attachments(text, paths)
        if self.busy:
            if not (self.agent and self.agent.busy):
                raise ApiError(409, "busy", "Another operation is running; stop it first")
            self.agent.queue(message, followup)
            self.publish({"type": "queued", "followup": followup, "text": text})
            return {"started": False, "queued": True, "followup": followup}
        self.launch(lambda: self.run_agent(message), message=message)
        return {"started": True, "queued": False}

    def abort(self):
        if self.busy:
            assert self.operation is not None
            self.operation.cancel()
            return True
        return False

    def restore(self):
        return self.agent.restore() if self.agent else ""

    # ---------------------------------------------------------------- questions

    def save_draft(self, batch_id, answers, step):
        self.session.save_question_draft(batch_id, answers, step)

    async def resolve_questions(self, batch_id, answers, *, cancel=False):
        if self.busy:
            raise ApiError(409, "busy", "Another operation is still running in this chat")
        message = self.session.resolve_question(batch_id, answers, cancel=cancel)
        await self.emit({"type": "message", "message": message})
        self.publish({"type": "question_resolved", "batch_id": batch_id,
                      "status": "cancelled" if cancel else "submitted"})
        self.launch(self.run_agent)
        return {"started": True}

    # ---------------------------------------------------------------- misc commands

    async def compact(self, instructions=""):
        if self.session.pending_question:
            raise ApiError(409, "question_open", "Submit or cancel the open question before compacting")

        async def work():
            await compact(self.session, self.service.providers, self.model, instructions, emit=self.emit)
            self.notice("Ранняя история сжата; исходные сообщения сохранены.")

        self.launch(work, with_agent=False)
        return {"started": True}

    async def run_skill(self, name, request=""):
        if self.session.pending_question:
            raise ApiError(409, "question_open", "Сначала отправьте или отмените открытый блок вопросов")
        if not self.tools.skills_enabled:
            raise ValueError("Skills отключены в настройках")
        skill = self.tools.skills.load(name)
        self.session.append("learning_skill", data={"name": name, "path": skill["path"],
                                                    "instructions": skill["instructions"]})
        content = (f"Use skill {name}. Supporting files are relative to {skill['base_directory']}.\n"
                   f"Skill instructions:\n{skill['instructions']}\n\nLearner request: "
                   f"{request or 'Помоги применить этот skill.'}")
        message = {"role": "user", "content": content, "display": f"/{name} {request}".strip()}
        self.launch(lambda: self.run_agent(message), message=message)
        return {"started": True}

    def rename(self, name):
        name = " ".join(name.split())
        if not name or len(name) > 200:
            raise ValueError("Name must contain 1-200 characters")
        self.session.append("name", name=name)
        self.publish({"type": "session_updated", "session": self.summary()})

    def select_style(self, value):
        style = validate_style(value)
        if style != self.session.explanation_style:
            self.session.append("explanation_style", explanation_style=style)
        self.publish({"type": "session_updated", "session": self.summary()})
        self.publish({"type": "context", "context": self.context()})

    def select_model(self, model_id, thinking=None, make_default=False):
        store = self.service.store
        model = self.service.catalog.get(model_id)
        levels = model.get("thinking_levels", ["off"])
        if thinking is None:
            thinking = self.session.thinking if self.session.thinking in levels else levels[0]
        if thinking not in levels:
            raise ValueError(f"Unsupported reasoning level for this model: {', '.join(levels)}")
        self.session.select(identifier(model), thinking)
        store.prefs["last_model"] = identifier(model)
        if make_default:
            store.prefs.update(default_model=identifier(model), default_thinking=thinking)
        store.save()
        self.publish({"type": "session_updated", "session": self.summary()})
        self.publish({"type": "context", "context": self.context()})

    async def close(self):
        self.closed = True
        self.abort()
        if self.operation is not None:
            await asyncio.gather(self.operation, return_exceptions=True)
        await self.tools.close()
        self.session.close()


class LoginFlow:
    """Interactive provider login (Codex OAuth): the server runs it, the client answers its prompts."""

    def __init__(self, service, method):
        self.service, self.method = service, method
        self.id = uuid.uuid4().hex
        self.state = "starting"
        self.input: asyncio.Future | None = None
        self.task: asyncio.Task | None = None

    def publish(self, **fields):
        self.service.bus.publish({"type": "login", "flow_id": self.id, "provider": "openai-codex",
                                  "state": self.state, **fields})

    async def ask(self, title, secret=False):
        self.input = asyncio.get_running_loop().create_future()
        self.state = "waiting_input"
        self.publish(prompt=title)
        try:
            return await self.input
        finally:
            self.input = None
            self.state = "running"

    def notify(self, text):
        fields = {"message": text}
        if url := re.search(r"https?://\S+", text):
            fields["url"] = url.group(0)
        if code := re.search(r"code:\s*(\S+)", text):
            fields["user_code"] = code.group(1)
        self.state = "running"
        self.publish(**fields)

    async def run(self):
        store = self.service.store
        try:
            await login_codex(store, self.ask, self.notify, method=self.method)
        except asyncio.CancelledError:
            self.state = "cancelled"
            self.publish()
        except Exception as exc:
            self.state = "error"
            self.publish(message=store.redact(str(exc)))
        else:
            self.state = "done"
            self.publish()
        finally:
            self.service.flows.pop(self.id, None)


SETTING_BOOLS = ("skills_enabled", "auto_compact", "block_images", "anti_slop_enabled")


async def _ignore(_event):
    pass


class Service:
    def __init__(self, store=None, cwd=None, providers=None, auto_title=True):
        self.auto_title = auto_title
        self.tasks: set[asyncio.Task] = set()
        self.store = store or Store()
        self.cwd = (cwd or Path.cwd()).resolve()
        self.cleanup = purge_coding_sessions(self.store.root)
        self.catalog = Catalog(self.store)
        self.courses = Courses(self.store.root)
        self.providers = providers or Providers(self.store)
        self.bus = EventBus()
        self.runtimes: dict[str, Runtime] = {}
        self.flows: dict[str, LoginFlow] = {}

    def publish(self, event):
        return self.bus.publish(event)

    def spawn(self, coroutine):
        """Background work that must not outlive the service (a reference keeps the task from being collected)."""
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    # ---------------------------------------------------------------- courses and sessions

    def list_courses(self):
        rows = []
        for course in self.courses.list():
            sessions = Session.list(self.store.root, self.cwd, course["id"])
            rows.append({"id": course["id"], "name": course["name"], "created": course.get("created", 0),
                         "sessions": sum(1 for s in sessions if s["said"])})
        return rows

    def create_course(self, name):
        course = self.courses.create(name)
        self.store.prefs["last_course"] = course["id"]
        self.store.save()
        row = {"id": course["id"], "name": course["name"], "created": course["created"], "sessions": 0}
        self.publish({"type": "course_created", "course": row})
        return row

    def rename_course(self, course_id, name):
        self.course(course_id)
        course = self.courses.rename(course_id, name)
        row = {"id": course["id"], "name": course["name"], "created": course.get("created", 0)}
        self.publish({"type": "course_renamed", "course": row})
        return row

    def course(self, course_id):
        try:
            return self.courses.get(course_id)
        except ValueError as exc:
            raise ApiError(404, "unknown_course", "Unknown course") from exc

    def progress(self, course_id):
        self.course(course_id)
        data = self.courses.progress(course_id)
        replaced = {(o["session_id"], o["supersedes"]) for o in data["observations"] if o.get("supersedes")}
        return {"observations": [o for o in data["observations"] if (o["session_id"], o["id"]) not in replaced],
                "lessons": data["lessons"]}

    def list_sessions(self, course_id=None, include_empty=False):
        rows = []
        courses = [self.course(course_id)] if course_id else self.courses.list()
        for course in courses:
            for row in Session.list(self.store.root, self.cwd, course["id"]):
                session_id = row["path"].stem
                runtime = self.runtimes.get(session_id)
                if not (row["said"] or include_empty or runtime):
                    continue
                rows.append({"id": session_id, "course_id": course["id"], "name": row["name"],
                             "modified": row["modified"], "said": row["said"], "open": runtime is not None,
                             "busy": bool(runtime and runtime.busy),
                             "explanation_style": row["explanation_style"]})
        return sorted(rows, key=lambda r: r["modified"], reverse=True)

    def _locate(self, session_id):
        if not SESSION_ID.match(session_id):
            raise ApiError(404, "unknown_session", "Unknown session")
        for course in self.courses.list():
            path = session_folder(self.store.root, self.cwd, course["id"]) / f"{session_id}.jsonl"
            if path.is_file():
                return path, course["id"]
        raise ApiError(404, "unknown_session", "Unknown session")

    def runtime(self, session_id):
        """The open chat, opening (and locking) its file on first use."""
        if session_id in self.runtimes:
            return self.runtimes[session_id]
        path, course_id = self._locate(session_id)
        try:
            session = Session(self.store.root, self.cwd, path, course_id=course_id)
        except ValueError as exc:
            code = "session_locked" if "another process" in str(exc) else "bad_session"
            raise ApiError(409, code, str(exc)) from exc
        return self._adopt(session)

    def _adopt(self, session):
        runtime = Runtime(self, session)
        self.runtimes[runtime.id] = runtime
        if self.store.prefs.get("last_course") != session.course_id:
            self.store.prefs["last_course"] = session.course_id
            self.store.save()
        return runtime

    def create_session(self, course_id, model=None, thinking=None, explanation_style=DEFAULT_STYLE):
        validate_style(explanation_style)
        self.course(course_id)
        session = Session(self.store.root, self.cwd, course_id=course_id)
        try:
            runtime = self._adopt(session)
            runtime.select_style(explanation_style)
            if model:
                runtime.select_model(model, thinking)
        except BaseException:
            self.runtimes.pop(session.path.stem, None)
            session.close()
            raise
        self.publish({"type": "session_created", "session": runtime.summary()})
        return runtime

    async def close_session(self, session_id):
        runtime = self.runtimes.pop(session_id, None)
        if runtime is None:
            return False
        await runtime.close()
        self.publish({"type": "session_closed", "session_id": session_id})
        return True

    async def delete_session(self, session_id):
        path, course_id = self._locate(session_id)
        runtime = self.runtimes.get(session_id)
        if runtime is not None and runtime.busy:
            raise ApiError(409, "busy", "Stop the running operation before deleting the chat")
        await self.close_session(session_id)
        try:
            lock = Session(self.store.root, self.cwd, path, course_id=course_id)  # refuses a chat open elsewhere
        except ValueError as exc:
            raise ApiError(409, "session_locked", str(exc)) from exc
        lock.close()
        for leftover in (path, path.with_name(path.name + ".lock")):
            leftover.unlink(missing_ok=True)
        self.publish({"type": "session_deleted", "session_id": session_id, "course_id": course_id})

    async def delete_course(self, course_id):
        self.course(course_id)
        folder = session_folder(self.store.root, self.cwd, course_id).parent
        open_here = [r for r in self.runtimes.values() if r.session.course_id == course_id]
        if any(r.busy for r in open_here):
            raise ApiError(409, "busy", "Stop the running operation before deleting the course")
        for runtime in open_here:
            await self.close_session(runtime.id)
        for path in folder.glob("sessions/*.jsonl"):
            try:
                Session(self.store.root, self.cwd, path, course_id=course_id).close()
            except ValueError as exc:
                raise ApiError(409, "session_locked", str(exc)) from exc
        shutil.rmtree(folder)
        if self.store.prefs.get("last_course") == course_id:
            self.store.prefs["last_course"] = ""
            self.store.save()
        self.publish({"type": "course_deleted", "course_id": course_id})

    # ---------------------------------------------------------------- models, providers, settings

    def model_row(self, model):
        keys = ("provider", "name", "context", "max_output", "vision", "tools", "reasoning", "thinking_levels",
                "cost", "metadata_estimated")
        return {"id": identifier(model)} | {k: model.get(k) for k in keys}

    def list_models(self):
        return [self.model_row(m) for m in self.catalog.available()]

    async def refresh_models(self, provider):
        if provider not in PRESETS and provider not in self.store.prefs.get("providers", {}):
            raise ApiError(404, "unknown_provider", "Unknown provider")
        try:
            await self.catalog.refresh(provider)
        except Exception as exc:
            raise ApiError(502, "discovery_failed", self.store.redact(str(exc))) from exc
        return self.list_models()

    def _provider_names(self):
        custom = [n for n in self.store.prefs.get("providers", {}) if n not in PRESETS]
        return [*PRESETS, *custom]

    def provider_row(self, name):
        config = settings(self.store, name)
        credential = self.store.credential(name)
        env = config.get("env") or config.get("api_key_env") or ""
        from_env = bool(env and os.environ.get(env))
        stored_key = bool(credential.get("key"))
        if name == "openai-codex":
            configured = bool(credential.get("refresh"))
        else:
            saved_endpoint = name in self.store.prefs.get("providers", {}) and (name in LOCAL or not env)
            configured = from_env or stored_key or saved_endpoint
        kind = ("oauth" if config["api"] == "codex" else "local" if name in LOCAL
                else "api" if name in PRESETS else "custom")
        return {"name": name, "kind": kind, "api": config["api"], "base_url": config["base_url"],
                "key_env": env, "configured": bool(configured),
                "key_source": "env" if from_env else "stored" if stored_key else "",
                "models": sum(1 for m in self.catalog.models if m["provider"] == name)}

    def list_providers(self):
        rows = []
        for name in self._provider_names():
            with contextlib.suppress(ValueError):
                rows.append(self.provider_row(name))
        return rows

    async def connect_provider(self, name, *, key=None, base_url=None, api=None):
        """Save credentials and endpoint of an API or local provider, then try model discovery."""
        if name == "openai-codex":
            raise ValueError("Use the OAuth login for openai-codex")
        prefs_providers = self.store.prefs.get("providers", {})
        pending = None
        if name in LOCAL:
            default = settings(self.store, name)["base_url"]
            pending = {**prefs_providers.get(name, {}), "base_url": endpoint_url(base_url or default)}
        elif name not in PRESETS:
            if name not in prefs_providers:
                if not re.fullmatch(r"[\w-]+", name):
                    raise ValueError("Use letters, numbers, hyphens or underscores in the provider name")
                if api not in CUSTOM_APIS or not base_url:
                    raise ValueError(f"A new provider needs api ({', '.join(CUSTOM_APIS)}) and base_url")
            if api or base_url or name not in prefs_providers:
                current = prefs_providers.get(name, {})
                pending = {**current, "api": api or current.get("api"),
                           "base_url": endpoint_url(base_url or current.get("base_url", ""))}
        elif base_url:
            pending = {**prefs_providers.get(name, {}), "base_url": endpoint_url(base_url)}
        if key is not None:
            self.store.set_credential(name, self.store.credential(name) | {"key": key})
        if pending is not None:
            self.store.prefs.setdefault("providers", {})[name] = pending
        self.store.save()
        self.catalog = Catalog(self.store)
        discovery = {"ok": True, "error": ""}
        try:
            await self.catalog.refresh(name)
        except Exception as exc:
            discovery = {"ok": False, "error": self.store.redact(str(exc))}
        self.publish({"type": "providers_changed"})
        return {"provider": self.provider_row(name), "discovery": discovery, "models": self.list_models()}

    def disconnect_provider(self, name):
        if name not in self._provider_names():
            raise ApiError(404, "unknown_provider", "Unknown provider")
        self.store.set_credential(name, None)
        self.publish({"type": "providers_changed"})
        return self.provider_row(name)

    def start_login(self, method):
        if method not in ("browser", "device"):
            raise ValueError("method must be browser or device")
        if self.flows:
            raise ApiError(409, "login_in_progress", "A login is already in progress")
        flow = LoginFlow(self, method)
        self.flows[flow.id] = flow
        flow.task = asyncio.create_task(flow.run())
        flow.publish()
        return flow.id

    def login_input(self, flow_id, value):
        flow = self.flows.get(flow_id)
        if flow is None:
            raise ApiError(404, "unknown_flow", "No such login")
        if flow.input is None or flow.input.done():
            raise ApiError(409, "no_prompt", "This login is not waiting for input")
        flow.input.set_result(value)

    async def cancel_login(self, flow_id):
        flow = self.flows.get(flow_id)
        if flow is None or flow.task is None:
            raise ApiError(404, "unknown_flow", "No such login")
        flow.task.cancel()
        await asyncio.gather(flow.task, return_exceptions=True)

    def get_settings(self):
        prefs = self.store.prefs
        web_key = bool(self.store.credential("web-search").get("key") or os.environ.get("BRAVE_SEARCH_API_KEY"))
        return {
            "anti_slop_enabled": prefs.get("anti_slop_enabled", True),
            **{key: prefs.get(key, "adaptive") if prefs.get(key, "adaptive") in choices else "adaptive"
               for key, (_, choices) in PREFERENCES.items()},
            "skills_enabled": prefs.get("skills_enabled", True),
            "auto_compact": prefs.get("auto_compact", True),
            "block_images": prefs.get("block_images", False),
            "default_model": prefs.get("default_model", ""),
            "default_thinking": prefs.get("default_thinking", "off"),
            "web_provider": prefs.get("web_provider", DEFAULT_PROVIDER),
            "web_key_set": web_key,
            "sandbox": os.environ.get("GRAPHY_SANDBOX") == "docker",
            "tools": [t for t in (prefs.get("learning_tools") or TOOL_NAMES) if t in TOOL_NAMES],
            "available_tools": TOOL_NAMES,
        }

    def update_settings(self, patch):
        prefs = self.store.prefs
        if not isinstance(patch, dict):
            raise ValueError("Expected an object")
        unknown = set(patch) - {*SETTING_BOOLS, *PREFERENCES, "default_model", "default_thinking", "web_provider", "tools"}
        if unknown:
            raise ValueError(f"Unknown settings: {', '.join(sorted(unknown))}")
        changes = {}
        for key, value in patch.items():
            if key in SETTING_BOOLS:
                if type(value) is not bool:
                    raise ValueError(f"{key} must be true or false")
            elif key in PREFERENCES:
                validate_preference(key, value)
            elif key == "default_thinking":
                if value not in THINKING_LEVELS:
                    raise ValueError(f"default_thinking must be one of {', '.join(THINKING_LEVELS)}")
            elif key == "default_model":
                if not isinstance(value, str) or (value and "/" not in value):
                    raise ValueError("default_model must be provider/model-id or empty")
            elif key == "web_provider":
                if value not in PROVIDERS:
                    raise ValueError("web_provider must be " + ", ".join(PROVIDERS))
            elif key == "tools":
                if not isinstance(value, list) or any(t not in TOOL_NAMES for t in value):
                    raise ValueError("tools must be a list of known tool names")
                key = "learning_tools"
                value = list(dict.fromkeys(value))
            changes[key] = value
        prefs.update(changes)
        self.store.save()
        if "learning_tools" in changes:
            for runtime in self.runtimes.values():
                runtime.tools.enabled = [t for t in changes["learning_tools"] if t in
                                         [*DEFINITIONS, *WEB_DEFINITIONS, "load_skill"]]
        self.publish({"type": "settings_changed"})
        return self.get_settings()

    def set_web_key(self, key):
        if not isinstance(key, str) or not key.strip():
            raise ValueError("key must be a nonempty string")
        self.store.set_credential("web-search", {"key": key.strip()})
        self.publish({"type": "settings_changed"})
        return self.get_settings()

    def list_skills(self):
        skills = Skills(self.store.root, self.cwd)
        return {"skills": skills.list(), "warnings": list(skills.warnings)}

    def bootstrap(self):
        models = self.list_models()
        return {
            "protocol": PROTOCOL, "version": __version__, "cwd": str(self.cwd), "root": str(self.store.root),
            "seq": self.bus.seq, "last_course": self.store.prefs.get("last_course", ""),
            "courses": self.list_courses(), "models": models, "ready": bool(models),
            "settings": self.get_settings(), "providers": self.list_providers(),
        }

    # ---------------------------------------------------------------- lifecycle

    async def close(self):
        for flow in list(self.flows.values()):
            if flow.task:
                flow.task.cancel()
        for flow in list(self.flows.values()):
            if flow.task:
                await asyncio.gather(flow.task, return_exceptions=True)
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        for session_id in list(self.runtimes):
            await self.close_session(session_id)
        await self.providers.close()
