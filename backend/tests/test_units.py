"""Pure helpers and small stores that had no direct tests."""

import json
from types import SimpleNamespace

import httpx
import pytest
from reference_graphy.common import endpoint_url, validate_metadata
from reference_graphy.context import compact, plan_due
from reference_graphy.contracts import PUBLIC, normalize_optional
from reference_graphy.courses import Courses
from reference_graphy.models import _rate
from reference_graphy.session import Session
from reference_graphy.storage import Store, read_json, write_json
from reference_graphy.web import WebResearch
from test_agent import FakeProvider, answer

# --- tolerant tool arguments -------------------------------------------------------------------------------------


def test_normalize_optional_decodes_stringified_json_and_numbers():
    plan = normalize_optional(PUBLIC["set_learning_plan"], {"goal": "g", "steps": '["a", "b"]'})
    assert plan["steps"] == ["a", "b"]
    assert normalize_optional(PUBLIC["set_learning_phase"], {"phase": "teaching", "step": "2"})["step"] == 2
    # not a number, not an integer: left for schema validation to reject with a clear message
    assert normalize_optional(PUBLIC["set_learning_phase"], {"phase": "x", "step": "2.5"})["step"] == "2.5"
    assert normalize_optional(PUBLIC["set_learning_phase"], {"phase": "x", "step": "nan"})["step"] == "nan"


def test_normalize_optional_drops_null_optionals_but_keeps_required_nulls_for_validation():
    assert normalize_optional(PUBLIC["set_learning_phase"], {"phase": "teaching", "step": None}) == {"phase": "teaching"}
    assert normalize_optional(PUBLIC["finish_lesson"], {"summary": None, "next_step": ""}) == {
        "summary": None, "next_step": ""}
    nested = normalize_optional(PUBLIC["record_assessment"], {
        "items": [{"evidence_ref": "E1", "outcome": "gap", "assistance": "none", "feedback": "f",
                   "correction": "true"}], "ignore_refs": None})
    assert nested == {"items": [{"evidence_ref": "E1", "outcome": "gap", "assistance": "none", "feedback": "f",
                                 "correction": True}]}


def test_normalize_optional_leaves_broken_json_and_foreign_types_alone():
    assert normalize_optional(PUBLIC["set_learning_plan"], {"goal": "g", "steps": "[unterminated"})["steps"] == "[unterminated"
    assert normalize_optional(PUBLIC["set_learning_plan"], {"goal": "g", "steps": '{"not": "a list"}'})["steps"] == (
        '{"not": "a list"}')
    assert normalize_optional({"type": "boolean"}, "maybe") == "maybe"
    assert normalize_optional({"type": "integer"}, "1e400") == "1e400"
    assert normalize_optional({}, 5) == 5


# --- when a plan is requested --------------------------------------------------------------------------------------


def plan_session(*texts, steps=()):
    """Texts alternate learner / assistant, starting with the learner."""
    roles = ("user", "assistant")
    return SimpleNamespace(messages=[{"role": roles[i % 2], "content": t} for i, t in enumerate(texts)],
                           learning=SimpleNamespace(steps=list(steps)))


LESSON_TOOLS = SimpleNamespace(session=object())
ASKED = "Для чего вам это нужно?"


@pytest.mark.parametrize(
    ("texts", "due"),
    [
        # The first turn of an explicit request is the model's: it may ask the purpose before saving a route.
        (("Составь план по алгебре",), False),
        (("Давай составим учебный план на месяц", ASKED, "Для экзамена"), True),
        (("Save a plan for learning Rust", ASKED, "To get a job"), True),
        (("Сделай мне учебный план по линейной алгебре, я с нуля", "Вот набросок вопросов", "ок"), True),
        (("Составь план", ASKED, "не надо план"), False),
        (("Составь план", ASKED, "Без плана, просто расскажи"), False),
        # A goal, a level, or "I want to understand" never starts a course by itself: the model judges the scope.
        (("Хочу научиться программировать, я с нуля", ASKED, "Для работы"), False),
        (("Хочу изучить физику, я с нуля", ASKED, "для школы"), False),
        (("Хочу с нуля изучить линейную алгебру. Школьную алгебру помню.", ASKED, "Для ML"), False),
        (("Объясни, что такое матрица. Я знаю арифметику.", "Матрица — это таблица.", "а зачем?"), False),
        (("Хочу понять формулу Байеса. Знаю вероятность и дроби. Покажи один пример.", "Вот.", "ещё"), False),
        ((), False),
    ],
)
def test_plan_is_forced_only_after_an_explicit_request_has_been_answered_once(texts, due):
    assert plan_due(plan_session(*texts), LESSON_TOOLS) is due


def test_plan_is_never_forced_twice_or_for_plain_tools():
    saved = plan_session("Составь план", ASKED, "для экзамена", steps=[{"id": "s1", "title": "t"}])
    assert not plan_due(saved, LESSON_TOOLS)
    assert not plan_due(plan_session("Составь план", ASKED, "для экзамена"), SimpleNamespace())


# --- user-supplied endpoint and model metadata -----------------------------------------------------------------


@pytest.mark.parametrize("url", ["https://u:p@host/v1", "ftp://host", "http://host/v1?key=1", "http://host#frag",
                                 "http://host:99999/v1", "localhost:8080", ""])
def test_endpoint_url_rejects_credentials_queries_and_foreign_schemes(url):
    with pytest.raises(ValueError):
        endpoint_url(url)


def test_endpoint_url_normalizes_trailing_slash_and_accepts_ipv6():
    assert endpoint_url("http://localhost:8080/v1/") == "http://localhost:8080/v1"
    assert endpoint_url("http://[::1]:8080/v1") == "http://[::1]:8080/v1"


@pytest.mark.parametrize(
    "values",
    [{"context": 0}, {"context": True}, {"max_output": -5}, {"vision": 1}, {"thinking_levels": []},
     {"thinking_levels": ["ultra"]}, {"cost": {"input": -1}}, {"cost": {"input": float("nan")}},
     {"cost": {"tokens": 1}}, {"cost": {}}, {"unknown": 1}, [], {"sampling": []}],
)
def test_model_metadata_rejects_malformed_values(values):
    with pytest.raises(ValueError):
        validate_metadata(values)


def test_model_metadata_accepts_a_complete_valid_description():
    validate_metadata({"context": 8192, "max_output": 2048, "vision": False, "tools": True, "reasoning": True,
                       "thinking_levels": ["off", "high"], "cost": {"input": 1, "output": 2.5},
                       "sampling": {"temperature": 0.2}, "strict_tools": False})
    validate_metadata({"cost": None})


@pytest.mark.parametrize(("value", "rate"), [("0.000002", 0.000002), (0, 0.0), ("-1", None), (-0.5, None),
                                              ("free", None), (None, None), ("nan", None), ("inf", None)])
def test_price_parser_treats_sentinels_as_unknown(value, rate):
    assert _rate(value) == rate


# --- small stores --------------------------------------------------------------------------------------------------


def test_read_json_rejects_wrong_shape_and_damage_but_defaults_when_missing(tmp_path):
    assert read_json(tmp_path / "missing.json", {"a": 1}) == {"a": 1}
    (tmp_path / "list.json").write_text("[1, 2]")
    with pytest.raises(ValueError, match="list.json"):
        read_json(tmp_path / "list.json", {})
    (tmp_path / "broken.json").write_text("{not json")
    with pytest.raises(ValueError, match="broken.json"):
        read_json(tmp_path / "broken.json", {})
    (tmp_path / "bytes.json").write_bytes(b"\xff\xfe\x00")
    with pytest.raises(ValueError, match="bytes.json"):
        read_json(tmp_path / "bytes.json", {})


def test_failed_json_write_keeps_the_previous_file_and_removes_its_temp_file(tmp_path):
    target = tmp_path / "state" / "data.json"
    write_json(target, {"ok": True, "text": "Привет"})
    with pytest.raises(ValueError):
        write_json(target, {"bad": float("nan")})
    assert json.loads(target.read_text(encoding="utf-8")) == {"ok": True, "text": "Привет"}
    assert [p.name for p in target.parent.iterdir()] == ["data.json"]


def test_redact_hides_every_stored_secret_and_bearer_tokens(tmp_path):
    store = Store(tmp_path)
    store.set_credential("a", {"key": "sk-secret-value", "nested": {"token": "another-secret"}, "short": "abc"})
    text = store.redact("failed: sk-secret-value / another-secret / Bearer eyJ.abc-def_ghi / abc")
    assert "sk-secret-value" not in text and "another-secret" not in text and "eyJ.abc-def_ghi" not in text
    assert text.endswith("/ abc")  # values of six characters or fewer would mangle ordinary words


def test_credentials_are_reread_so_another_process_can_refresh_them(tmp_path):
    first, second = Store(tmp_path), Store(tmp_path)
    first.set_credential("openai-codex", {"refresh": "r1"})
    assert second.credential("openai-codex") == {"refresh": "r1"}
    first.set_credential("openai-codex", None)
    assert second.credential("openai-codex") == {}
    assert oct((tmp_path / "auth.json").stat().st_mode & 0o777) == oct(0o600)


# --- courses and web cache survive damaged files ---------------------------------------------------------------


def test_one_damaged_course_file_does_not_hide_the_other_courses(tmp_path):
    courses = Courses(tmp_path)
    first, second = courses.create("Математика"), courses.create("Физика")
    (tmp_path / "learning" / "courses" / first["id"] / "course.json").write_text("{broken")
    assert [row["name"] for row in courses.list()] == ["Физика"]
    assert courses.get(second["id"])["name"] == "Физика"
    with pytest.raises(ValueError):
        courses.get(first["id"])


@pytest.mark.parametrize("name", ["", "   ", "x" * 201])
def test_course_name_must_be_one_to_two_hundred_characters(tmp_path, name):
    with pytest.raises(ValueError):
        Courses(tmp_path).create(name)


def test_course_ids_cannot_escape_the_courses_folder(tmp_path):
    for bad in ("../x", "..", "A" * 32, "", None):
        with pytest.raises(ValueError):
            Courses(tmp_path).get(bad)


async def test_damaged_web_cache_entry_is_refetched_instead_of_failing_forever(tmp_path):
    requests = []

    def page(request):
        requests.append(request)
        return httpx.Response(200, headers={"content-type": "text/plain"}, text="Lesson text")

    cache = tmp_path / "cache"
    async with httpx.AsyncClient(transport=httpx.MockTransport(page)) as client:
        assert (await WebResearch(client=client, cache_dir=cache).read("https://example.edu/a"))["text"] == "Lesson text"
        for entry in cache.iterdir():
            entry.write_text("{truncated")
        again = await WebResearch(client=client, cache_dir=cache).read("https://example.edu/a")
    assert again["text"] == "Lesson text" and len(requests) == 2


# --- performance guard -------------------------------------------------------------------------------------------


async def test_compaction_builds_the_evidence_index_once_not_once_per_message(session, monkeypatch):
    for number in range(60):
        session.add({"role": "user" if number % 2 == 0 else "assistant",
                     "content": f"message {number}? " + "word " * 30})
    builds = 0
    original = Session.evidence.fget

    def counting(self):
        nonlocal builds
        builds += 1
        return original(self)

    monkeypatch.setattr(Session, "evidence", property(counting))
    await compact(session, FakeProvider(answer("summary")), {"id": "test", "context": 128000}, keep=200)
    assert session.boundary > 0
    assert builds <= 4, f"evidence was rebuilt {builds} times for 60 messages"
