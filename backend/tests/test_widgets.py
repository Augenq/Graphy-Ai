"""Inline visuals: guidelines on request, show_widget gated on having read them."""

import pytest
from reference_graphy.courses import Courses
from reference_graphy.learning_tools import LearningTools
from reference_graphy.session import Session
from reference_graphy.widgets import MODULES, guidelines
from test_reliability import NoSkills, call


@pytest.fixture
def lesson_tools(tmp_path):
    course = Courses(tmp_path).create("Widgets")
    session = Session(tmp_path, tmp_path, course_id=course["id"])
    tools = LearningTools(tmp_path, session, skills=NoSkills())
    yield session, tools
    session.close()


def test_declared_even_when_the_saved_tool_list_omits_them(tmp_path):
    course = Courses(tmp_path).create("Widgets")
    session = Session(tmp_path, tmp_path, course_id=course["id"])
    try:
        tools = LearningTools(tmp_path, session, ["read"], skills=NoSkills())
        names = [d["name"] for d in tools.declarations]
        assert "visualize_read_me" in names and "show_widget" in names
    finally:
        session.close()


def test_guidelines_always_start_with_the_core_and_add_only_requested_modules():
    text = guidelines(["chart"])
    assert text.startswith("# Inline visuals: core rules") and "Chart.js" in text and "# Diagrams (SVG)" not in text
    assert all(f"# {title}" in guidelines(MODULES) for title in ("Diagrams (SVG)", "Charts and data", "Interactive explainers"))


async def test_show_widget_needs_the_guidelines_first_then_succeeds(lesson_tools):
    session, tools = lesson_tools
    code = '<svg width="100%" viewBox="0 0 680 100"><text class="t" x="10" y="20">A</text></svg>'
    early = await call(tools, "show_widget", {"title": "a_to_b", "widget_code": code})
    assert early["error"] and "visualize_read_me" in early["content"]

    read = await call(tools, "visualize_read_me", {"modules": ["diagram"]}, "read1")
    assert not read.get("error") and "c-blue" in read["content"]
    session.add({"role": "assistant", "content": "", "calls": [{"id": "read1", "name": "visualize_read_me", "arguments": {}}]})
    session.add({"role": "tool", "call_id": "read1", "name": "visualize_read_me", "content": read["content"]})

    shown = await call(tools, "show_widget", {"title": "a_to_b", "widget_code": code}, "show1")
    assert not shown.get("error") and "a_to_b" in shown["content"]


@pytest.mark.parametrize("arguments", [
    {"title": "x", "widget_code": ""},
    {"title": "x", "widget_code": "<p>hi</p>" * 10000},
    {"title": "x"},
    {"widget_code": "<p>hi</p>"},
])
async def test_show_widget_rejects_bad_arguments(lesson_tools, arguments):
    _, tools = lesson_tools
    assert (await call(tools, "show_widget", arguments))["error"]


async def test_read_me_accepts_modules_as_json_text_and_rejects_unknown(lesson_tools):
    _, tools = lesson_tools
    result = await call(tools, "visualize_read_me", {"modules": '["chart","interactive"]'})
    assert not result.get("error") and "Chart.js" in result["content"]
    assert (await call(tools, "visualize_read_me", {"modules": ["art"]}))["error"]
