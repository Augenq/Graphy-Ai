"""High-level Python application API for the native Graphy backend.

The Rust process owns execution and persistence. This module owns the product-facing
workflow: request construction, response decoding, stateful course/session handles,
SSE event collection, retry policy, and small domain objects used by the web and
CLI integrations. Keeping this layer explicit makes Python useful to callers without
reimplementing agent logic.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class GraphyError(RuntimeError):
    """An API or transport failure returned by Graphy."""

    def __init__(self, message: str, *, status: int | None = None, code: str = "error") -> None:
        super().__init__(message)
        self.status, self.code = status, code


class BusyError(GraphyError):
    """The selected session is already processing another operation."""


class AuthenticationError(GraphyError):
    """The API token was rejected."""


class Phase(StrEnum):
    DIAGNOSIS = "diagnosis"
    PLANNING = "planning"
    TEACHING = "teaching"
    PRACTICE = "practice"
    REVIEW = "review"


@dataclass(frozen=True, slots=True)
class BackendConfig:
    """Connection settings for the local Rust API."""

    base_url: str = "http://127.0.0.1:8765/api/v1"
    token: str = ""
    origin: str | None = None
    timeout: float = 30.0
    retries: int = 2

    def __post_init__(self) -> None:
        object.__setattr__(self, "base_url", self.base_url.rstrip("/"))
        if self.timeout <= 0 or self.retries < 0:
            raise ValueError("timeout must be positive and retries must be nonnegative")

    def url(self, path: str) -> str:
        return self.base_url + "/" + path.lstrip("/")

    def headers(self, *, json_body: bool = False) -> dict[str, str]:
        values = {"Accept": "application/json"}
        if self.token:
            values["Authorization"] = f"Bearer {self.token}"
        if self.origin:
            values["Origin"] = self.origin
        if json_body:
            values["Content-Type"] = "application/json"
        return values


@dataclass(frozen=True, slots=True)
class Health:
    ok: bool
    protocol: int
    version: str
    engine: str

    @classmethod
    def from_json(cls, value: Mapping[str, Any]) -> Health:
        return cls(
            bool(value.get("ok")),
            int(value.get("protocol", 0)),
            str(value.get("version", "")),
            str(value.get("engine", "")),
        )

    @property
    def native(self) -> bool:
        return self.engine == "rust"


@dataclass(frozen=True, slots=True)
class Course:
    id: str
    name: str
    modified: float = 0.0
    sessions: int = 0

    @classmethod
    def from_json(cls, value: Mapping[str, Any]) -> Course:
        return cls(
            str(value["id"]),
            str(value.get("name", "")),
            float(value.get("modified", 0)),
            int(value.get("sessions", 0)),
        )


@dataclass(frozen=True, slots=True)
class Message:
    role: str
    content: str
    id: str = ""
    name: str = ""
    calls: tuple[Mapping[str, Any], ...] = ()

    @classmethod
    def from_json(cls, value: Mapping[str, Any]) -> Message:
        calls = tuple(value.get("calls", ())) if isinstance(value.get("calls", ()), list) else ()
        return cls(
            str(value.get("role", "")),
            str(value.get("content", "")),
            str(value.get("id", "")),
            str(value.get("name", "")),
            calls,
        )

    @property
    def is_assistant(self) -> bool:
        return self.role == "assistant"


@dataclass(frozen=True, slots=True)
class SessionSummary:
    id: str
    course_id: str
    name: str
    model: str
    busy: bool = False
    message_count: int = 0
    explanation_style: str = "structured_reference"

    @classmethod
    def from_json(cls, value: Mapping[str, Any]) -> SessionSummary:
        return cls(
            str(value.get("id", "")),
            str(value.get("course_id", "")),
            str(value.get("name", "")),
            str(value.get("model", "")),
            bool(value.get("busy", False)),
            int(value.get("message_count", len(value.get("messages", [])))),
            str(value.get("explanation_style", "structured_reference")),
        )


@dataclass(frozen=True, slots=True)
class Conversation:
    summary: SessionSummary
    messages: tuple[Message, ...]
    learning: Mapping[str, Any] | None = None
    pending_question: Mapping[str, Any] | None = None
    usage: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_json(cls, value: Mapping[str, Any]) -> Conversation:
        return cls(
            SessionSummary.from_json(value),
            tuple(Message.from_json(m) for m in value.get("messages", [])),
            value.get("learning"),
            value.get("question"),
            value.get("usage", {}),
        )

    @property
    def last_assistant(self) -> Message | None:
        return next((m for m in reversed(self.messages) if m.is_assistant), None)

    @property
    def phase(self) -> Phase | None:
        raw = (self.learning or {}).get("phase")
        try:
            return Phase(raw) if raw else None
        except ValueError:
            return None


@dataclass(frozen=True, slots=True)
class Event:
    type: str
    payload: Mapping[str, Any]
    sequence: int = 0

    @classmethod
    def from_json(cls, value: Mapping[str, Any]) -> Event:
        return cls(str(value.get("type", "")), value, int(value.get("seq", 0)))

    @property
    def text(self) -> str:
        return str(self.payload.get("delta", self.payload.get("text", "")))


class GraphyClient:
    """Typed product client for the Rust HTTP API."""

    def __init__(self, config: BackendConfig):
        self.config = config

    def _request(
        self, method: str, path: str, body: Mapping[str, Any] | None = None, *, retry: bool = True
    ) -> Any:
        encoded = None if body is None else json.dumps(body, ensure_ascii=False).encode()
        request = urllib.request.Request(
            self.config.url(path),
            data=encoded,
            headers=self.config.headers(json_body=body is not None),
            method=method,
        )
        attempts = self.config.retries + 1 if retry and method in {"GET", "PUT", "PATCH"} else 1
        for attempt in range(attempts):
            try:
                with urllib.request.urlopen(request, timeout=self.config.timeout) as response:
                    raw = response.read()
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as exc:
                try:
                    payload = json.loads(exc.read())
                except (ValueError, TypeError):
                    payload = {}
                error = payload.get("error", {}) if isinstance(payload, dict) else {}
                message, code = str(error.get("message", exc.reason)), str(error.get("code", "http_error"))
                if exc.code == 401:
                    raise AuthenticationError(message, status=exc.code, code=code) from exc
                if exc.code == 409:
                    raise BusyError(message, status=exc.code, code=code) from exc
                raise GraphyError(message, status=exc.code, code=code) from exc
            except (urllib.error.URLError, TimeoutError) as exc:
                if attempt + 1 >= attempts:
                    raise GraphyError(str(exc), code="transport") from exc
                time.sleep(min(2**attempt, 4))

    def health(self) -> Health:
        return Health.from_json(self._request("GET", "health"))

    def bootstrap(self) -> Mapping[str, Any]:
        return self._request("GET", "bootstrap")

    def settings(self) -> Mapping[str, Any]:
        return self._request("GET", "settings")

    def update_settings(self, **patch: Any) -> Mapping[str, Any]:
        return self._request("PATCH", "settings", patch)

    def courses(self) -> tuple[Course, ...]:
        return tuple(Course.from_json(row) for row in self._request("GET", "courses").get("courses", []))

    def create_course(self, name: str) -> Course:
        if not name.strip():
            raise ValueError("course name cannot be empty")
        return Course.from_json(self._request("POST", "courses", {"name": name}))

    def rename_course(self, course_id: str, name: str) -> Course:
        return Course.from_json(
            self._request("PATCH", f"courses/{urllib.parse.quote(course_id)}", {"name": name})
        )

    def delete_course(self, course_id: str) -> None:
        self._request("DELETE", f"courses/{urllib.parse.quote(course_id)}")

    def sessions(self, course_id: str | None = None) -> tuple[SessionSummary, ...]:
        path = (
            "sessions"
            if course_id is None
            else "sessions?" + urllib.parse.urlencode({"course_id": course_id})
        )
        return tuple(SessionSummary.from_json(row) for row in self._request("GET", path).get("sessions", []))

    def open_session(
        self, course_id: str, *, model: str = "", thinking: str = "off", style: str | None = None
    ) -> SessionHandle:
        body: dict[str, Any] = {"course_id": course_id, "model": model, "thinking": thinking}
        if style:
            body["explanation_style"] = style
        value = self._request("POST", "sessions", body)
        return SessionHandle(self, str(value["id"]))

    def session(self, session_id: str) -> SessionHandle:
        return SessionHandle(self, session_id)

    def events(self, *, token: str | None = None) -> Iterator[Event]:
        query = "?" + urllib.parse.urlencode({"token": token}) if token else ""
        request = urllib.request.Request(self.config.url("events") + query, headers=self.config.headers())
        with urllib.request.urlopen(request, timeout=None) as response:
            for raw in response:
                line = raw.decode("utf-8").rstrip("\n")
                if line.startswith("data:"):
                    yield Event.from_json(json.loads(line[5:].strip()))


@dataclass(slots=True)
class SessionHandle:
    client: GraphyClient
    id: str

    def get(self) -> Conversation:
        return Conversation.from_json(self.client._request("GET", f"sessions/{urllib.parse.quote(self.id)}"))

    def send_message(
        self, text: str, *, paths: Sequence[str] = (), followup: bool = False
    ) -> Mapping[str, Any]:
        if not text.strip():
            raise ValueError("message cannot be empty")
        return self.client._request(
            "POST",
            f"sessions/{urllib.parse.quote(self.id)}/messages",
            {"text": text, "paths": list(paths), "followup": followup},
            retry=False,
        )

    def abort(self) -> bool:
        return bool(
            self.client._request("POST", f"sessions/{urllib.parse.quote(self.id)}/abort", retry=False).get(
                "aborted"
            )
        )

    def close(self) -> None:
        self.client._request("POST", f"sessions/{urllib.parse.quote(self.id)}/close", retry=False)

    def compact(self, instructions: str = "") -> Mapping[str, Any]:
        return self.client._request(
            "POST",
            f"sessions/{urllib.parse.quote(self.id)}/compact",
            {"instructions": instructions},
            retry=False,
        )

    def set_style(self, style: str) -> Mapping[str, Any]:
        return self.client._request(
            "PUT", f"sessions/{urllib.parse.quote(self.id)}/style", {"explanation_style": style}
        )

    def set_model(
        self, model: str, *, thinking: str = "off", make_default: bool = False
    ) -> Mapping[str, Any]:
        return self.client._request(
            "PUT",
            f"sessions/{urllib.parse.quote(self.id)}/model",
            {"model": model, "thinking": thinking, "make_default": make_default},
        )

    def load_skill(self, name: str, request: str = "") -> Mapping[str, Any]:
        return self.client._request(
            "POST",
            f"sessions/{urllib.parse.quote(self.id)}/skill",
            {"name": name, "request": request},
            retry=False,
        )

    def draft_question(
        self, batch_id: str, answers: Sequence[Mapping[str, Any]], *, step: str = ""
    ) -> Mapping[str, Any]:
        return self.client._request(
            "PUT",
            f"sessions/{urllib.parse.quote(self.id)}/questions/{urllib.parse.quote(batch_id)}/draft",
            {"answers": list(answers), "step": step},
            retry=False,
        )

    def submit_questions(self, batch_id: str, answers: Sequence[Mapping[str, Any]]) -> Mapping[str, Any]:
        return self.client._request(
            "POST",
            f"sessions/{urllib.parse.quote(self.id)}/questions/{urllib.parse.quote(batch_id)}/submit",
            {"answers": list(answers)},
            retry=False,
        )

    def cancel_questions(self, batch_id: str) -> Mapping[str, Any]:
        return self.client._request(
            "POST",
            f"sessions/{urllib.parse.quote(self.id)}/questions/{urllib.parse.quote(batch_id)}/cancel",
            retry=False,
        )


@dataclass(slots=True)
class MessageComposer:
    """Builds consistent learner messages for CLI, web and scripted lessons."""

    parts: list[str] = field(default_factory=list)
    attachments: list[str] = field(default_factory=list)

    def add(self, text: str) -> MessageComposer:
        if text.strip():
            self.parts.append(text.strip())
        return self

    def attach(self, path: str) -> MessageComposer:
        self.attachments.append(path)
        return self

    def build(self) -> tuple[str, tuple[str, ...]]:
        if not self.parts:
            raise ValueError("a message needs at least one text part")
        return "\n\n".join(self.parts), tuple(self.attachments)


@dataclass(slots=True)
class EventCollector:
    """Collects a turn's SSE events and exposes incremental assistant text."""

    events: list[Event] = field(default_factory=list)

    def add(self, event: Event) -> None:
        self.events.append(event)

    @property
    def text(self) -> str:
        return "".join(event.text for event in self.events if event.type in {"text_delta", "thinking_delta"})

    @property
    def completed(self) -> bool:
        return any(event.type == "message_end" for event in self.events)

    @property
    def errors(self) -> tuple[Event, ...]:
        return tuple(event for event in self.events if event.payload.get("error"))

    def by_type(self, kind: str) -> tuple[Event, ...]:
        return tuple(event for event in self.events if event.type == kind)


def send_message(
    client: GraphyClient, session_id: str, text: str, *, attachments: Iterable[str] = ()
) -> Mapping[str, Any]:
    """Product-level convenience function used by small integrations."""
    return client.session(session_id).send_message(text, paths=tuple(attachments))


def wait_for_completion(events: Iterable[Event], *, timeout: float = 300.0) -> EventCollector:
    """Consume events until completion, retaining all deltas for UI and diagnostics."""
    started = time.monotonic()
    collector = EventCollector()
    for event in events:
        collector.add(event)
        if collector.completed:
            return collector
        if time.monotonic() - started > timeout:
            raise TimeoutError("Graphy turn did not complete")
    raise GraphyError("Graphy event stream ended before message_end", code="stream_closed")
