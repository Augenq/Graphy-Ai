"""Prompt contract checks that never run the agent loop, a model or a tool: they only assemble instructions and fold
journal events into lesson state."""

import json
import pathlib
import re
from types import SimpleNamespace

import pytest
from reference_graphy.context import request_context, style_method, style_presentation, system_prompt
from reference_graphy.courses import Courses
from reference_graphy.learning_tools import LearningTools
from reference_graphy.session import Session
from reference_graphy.styles import EXPLANATION_STYLES

PROMPTS = pathlib.Path(__file__).resolve().parents[1] / "graphy" / "prompts"


@pytest.fixture
def lesson(tmp_path):
    course = Courses(tmp_path).create("Математика")
    session = Session(tmp_path, tmp_path, course_id=course["id"])
    yield session
    session.close()


def test_resources_are_english_only():
    for path in PROMPTS.glob("*.md"):
        assert not re.search("[а-яё]", path.read_text(encoding="utf-8"), re.I), path.name


@pytest.mark.parametrize("style", EXPLANATION_STYLES)
def test_each_style_is_one_protocol_that_names_its_first_reply(lesson, tmp_path, style):
    tools = LearningTools(tmp_path, lesson)
    lesson.explanation_style = style
    prompt = system_prompt(lesson, tools)
    assert prompt.count("# EXPLANATION STYLE:") == 1 and "# Reading the turn" in prompt and "# Plans" in prompt
    body = (PROMPTS / f"style-{style}.md").read_text(encoding="utf-8")
    assert body.startswith("# EXPLANATION STYLE:") and "First reply" in body and "Next turns" in body


def test_socratic_replaces_the_default_cadence_and_the_request_outranks_the_style():
    assert "replaces the default" in (PROMPTS / "style-socratic.md").read_text(encoding="utf-8")
    teacher = (PROMPTS / "teacher.md").read_text(encoding="utf-8")
    assert "beats the selected style" in teacher and "explain, then practise" in teacher


@pytest.mark.parametrize("style", EXPLANATION_STYLES)
def test_method_and_presentation_are_separate_in_the_actual_request(lesson, tmp_path, style):
    tools = LearningTools(tmp_path, lesson)
    lesson.explanation_style = style
    lesson.add({"role": "user", "content": "Объясни с формулой и короткой таблицей."})
    context = request_context(lesson, tools)
    state = json.loads(context[-2]["content"].split("\n", 1)[1])
    assert state["style_method"] == style_method(lesson)
    assert state["style_presentation"] == style_presentation(lesson)
    assert state["style_method"].startswith("Method:")
    assert "Depth:" not in state["style_method"] and "Presentation:" not in state["style_method"]
    assert "Depth:" in state["style_presentation"] and "Presentation:" in state["style_presentation"]
    assert "Method:" not in state["style_presentation"]
    assert "Shape:" not in state["style_method"] + state["style_presentation"]
    assert context[-1]["content"] == "Объясни с формулой и короткой таблицей."


def test_question_selection_and_supported_practice_are_core_rules_even_without_anti_slop(lesson):
    tools = SimpleNamespace(store=SimpleNamespace(prefs={"anti_slop_enabled": False}))
    prompt = system_prompt(lesson, tools)
    assert "reveal a useful distinction" in prompt
    assert "use the response to decide what comes next" in prompt
    assert "worked example or a missing step before independent use" in prompt
    assert "not independent evidence" in prompt
    assert "changed situation when ready to check transfer" in prompt


def test_the_anti_slop_switch_only_removes_the_voice_section(lesson, tmp_path):
    on = SimpleNamespace(store=SimpleNamespace(prefs={"anti_slop_enabled": True}))
    off = SimpleNamespace(store=SimpleNamespace(prefs={"anti_slop_enabled": False}))
    assert "# ANTI-SLOP FRAMEWORK" in system_prompt(lesson, on)
    prompt = system_prompt(lesson, off)
    assert "# ANTI-SLOP FRAMEWORK" not in prompt and "# Practice and feedback" in prompt


def _next_action(lesson, tools):
    return json.loads(request_context(lesson, tools)[-2]["content"].split("\n", 1)[1])["next_action"]


def _attempt(lesson, text, outcome, n):
    """An attempt folded into the lesson state exactly as the journal would, without executing any tool."""
    lesson.add({"role": "assistant", "content": f"Задача {n}: чему равно 2 + {n}?"})
    lesson.add({"role": "user", "content": text})
    message = lesson.messages[-1]
    lesson.learning.apply({"type": "learning_assessment", "data": {
        "id": f"a{n}", "evidence_ref": "", "source_message_id": message["id"], "outcome": outcome,
        "assistance": "none", "feedback": "x", "answer": {"status": "answered", "text": text}}})


def test_an_error_gets_one_hint_and_a_repeated_error_gets_a_different_approach(lesson, tmp_path):
    tools = LearningTools(tmp_path, lesson)
    _attempt(lesson, "Ответ 5", "gap", 1)
    first = _next_action(lesson, tools)
    assert "ONE hint" in first and "second error" not in first and "WAIT" in first
    _attempt(lesson, "Ответ 6", "gap", 2)
    second = _next_action(lesson, tools)
    assert "second error in a row" in second and "never the same hint" in second


def test_a_success_still_asks_for_a_changed_case_and_forbids_recap(lesson, tmp_path):
    tools = LearningTools(tmp_path, lesson)
    _attempt(lesson, "Ответ 3", "independent", 1)
    action = _next_action(lesson, tools)
    assert "changed or new-context task" in action and "Do not summarise" in action
    assert "if the task supplied a method or partial solution" in action
    assert "similar independent task before transfer" in action
    assert "A correct completion is not independent use" in action


def test_a_declared_unknown_is_taught_not_hinted_and_the_answer_stays_hidden(lesson, tmp_path):
    tools = LearningTools(tmp_path, lesson)
    _attempt(lesson, "Не знаю", "gap", 1)
    lesson.learning.assessments[-1]["answer"] = {"status": "dont_know", "text": "Не знаю"}
    action = _next_action(lesson, tools)
    assert "Teach the missing prerequisite" in action and "Give ONE hint" not in action
    assert "pending task's answer hidden" in action
