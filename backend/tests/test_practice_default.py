"""Practice after theory by default, plans only for large or explicitly requested routes, no forced recap."""

import copy
import json
from collections import deque

import pytest
from reference_graphy.agent import Agent
from reference_graphy.context import request_context, system_prompt
from reference_graphy.courses import Courses
from reference_graphy.learning_tools import LearningTools
from reference_graphy.session import Session
from reference_graphy.styles import EXPLANATION_STYLES

MODEL = {"id": "test", "context": 128000}


class Recorder:
    def __init__(self, *responses):
        self.responses, self.models = deque(responses), []
        self.requests = []

    async def stream(self, model, messages, system, tools, thinking, session_id, emit):
        self.models.append(copy.deepcopy(model))
        self.requests.append(copy.deepcopy({"messages": messages, "system": system}))
        return copy.deepcopy(self.responses.popleft())


def reply(content="", calls=None):
    return {"role": "assistant", "content": content, "calls": calls or [], "stop": "stop"}


@pytest.fixture
def lesson(tmp_path):
    course = Courses(tmp_path).create("Математика")
    session = Session(tmp_path, tmp_path, course_id=course["id"])
    yield session
    session.close()


async def run(lesson, tmp_path, text, *responses):
    provider = Recorder(*responses)

    async def emit(_event):
        pass

    agent = Agent(lesson, LearningTools(tmp_path, lesson), provider, MODEL, emit)
    await agent.run({"role": "user", "content": text})
    return provider


@pytest.mark.parametrize("text", [
    "Объясни, что такое матрица. Я знаю арифметику.",
    "Хочу изучить производную, я с нуля.",
    "Хочу с нуля изучить линейную алгебру. Школьную алгебру помню.",
    "Научи меня понимать формулу Байеса. Знаю вероятность.",
])
async def test_a_topic_or_a_goal_with_a_level_does_not_force_the_planner(lesson, tmp_path, text):
    provider = await run(lesson, tmp_path, text, reply("Матрица — это таблица.\nВычисли A·v для ..."))
    assert "tool_choice" not in provider.models[0]
    assert not lesson.learning.steps


async def test_an_explicit_plan_request_is_answered_first_and_the_planner_is_forced_once_after(lesson, tmp_path):
    plan = {"id": "p", "name": "set_learning_plan", "arguments": {"goal": "Линейная алгебра для ML", "steps": ["Векторы"]}}
    first = await run(lesson, tmp_path, "Составь план по линейной алгебре", reply("Расскажите, для чего вам это нужно."))
    assert "tool_choice" not in first.models[0]  # the model may ask what the route depends on
    provider = await run(lesson, tmp_path, "Для машинного обучения", reply(calls=[plan]), reply("Начнём с векторов."))
    assert provider.models[0]["tool_choice"] == "set_learning_plan"
    assert "tool_choice" not in provider.models[1]
    assert [s["title"] for s in lesson.learning.steps] == ["Векторы"]


async def test_a_route_for_a_big_goal_may_have_more_than_twelve_steps(lesson, tmp_path):
    titles = [f"Тема {n}" for n in range(1, 21)]
    tools = LearningTools(tmp_path, lesson)
    call = {"id": "plan", "name": "set_learning_plan", "arguments": {"goal": "Линейная алгебра для ML", "steps": titles}}
    result = await tools.execute(call)
    assert not result.get("error"), result
    assert [s["title"] for s in lesson.learning.steps] == titles
    assert next(d for d in tools.declarations if d["name"] == "set_learning_plan")["parameters"]["properties"]["steps"]["maxItems"] >= 20
    lesson.close()


def test_every_style_prompt_is_assembled_alone_with_the_practice_default(lesson, tmp_path):
    tools = LearningTools(tmp_path, lesson)
    for style in EXPLANATION_STYLES:
        lesson.explanation_style = style
        prompt = system_prompt(lesson, tools)
        assert prompt.count("# EXPLANATION STYLE:") == 1
        assert "explain, then practise" in prompt and "# Plans" in prompt
    assert next(d for d in tools.declarations if d["name"] == "finish_lesson")


async def _record_independent(lesson, tmp_path, text):
    tools = LearningTools(tmp_path, lesson)
    lesson.add({"role": "assistant", "content": "Матрица — таблица чисел.\nЗадача: найди элемент во 2-й строке, 1-м столбце матрицы [[1,2],[3,4]]."})
    lesson.add({"role": "user", "content": text})
    call = {"id": "r", "name": "record_assessment", "arguments": {
        "items": [{"evidence_ref": "", "outcome": "independent", "assistance": "none", "feedback": "Верно"}]}}
    from reference_graphy.evidence import pending

    call["arguments"]["items"][0]["evidence_ref"] = pending(lesson)[-1]
    assert not (await tools.execute(call)).get("error")
    return tools


async def test_after_a_success_the_next_action_asks_for_a_changed_case_and_forbids_recap(lesson, tmp_path):
    tools = await _record_independent(lesson, tmp_path, "3")
    action = json.loads(request_context(lesson, tools)[-2]["content"].split("\n", 1)[1])["next_action"]
    assert "changed or new-context task" in action and "Do not summarise" in action
    lesson.close()


async def test_a_help_request_after_a_success_still_reports_the_success_but_never_a_final_test(lesson, tmp_path):
    tools = await _record_independent(lesson, tmp_path, "Ответ 3, а как это связано с системой уравнений?")
    action = json.loads(request_context(lesson, tools)[-2]["content"].split("\n", 1)[1])["next_action"]
    assert "final test" in action
    lesson.close()


async def test_completion_support_survives_assessment_and_reopen_before_transfer(lesson, tmp_path):
    """The task gives part of the method; its correct answer must not force immediate transfer."""
    from reference_graphy.evidence import pending

    tools = LearningTools(tmp_path, lesson)
    lesson.add({"role": "assistant", "content":
                "Задача: решаем 2x + 3 = 11. Вычли 3 из обеих частей: 2x = 8. Найди x?"})
    lesson.add({"role": "user", "content": "4"})
    result = await tools.execute({"id": "completion", "name": "record_assessment", "arguments": {
        "items": [{"evidence_ref": pending(lesson)[-1], "outcome": "with_hints", "assistance": "hints",
                   "feedback": "Верно выполнен оставшийся шаг; начало решения было дано."}]}})
    assert not result.get("error"), result
    path = lesson.path
    lesson.close()
    restored = Session(lesson.root, lesson.root, path, course_id=lesson.course_id)
    try:
        provider = Recorder(reply("Теперь реши похожую задачу самостоятельно."))

        async def emit(_event):
            pass

        await Agent(restored, LearningTools(tmp_path, restored), provider, MODEL, emit).run()
        states = [json.loads(m["content"].split("\n", 1)[1])
                  for m in provider.requests[0]["messages"] if m["role"] == "context"]
        assert len(states) == 1
        assert "completion of a missing step" in states[0]["next_action"]
        assert "before transfer" in states[0]["next_action"]
        assert restored.learning.assessments[-1]["assistance"] == "hints"
        assert "worked example or a missing step before independent use" in provider.requests[0]["system"]
    finally:
        restored.close()


async def test_a_rejected_assessment_is_retried_before_any_feedback(lesson, tmp_path):
    """The model wrote outcome=with_hints without assistance; the learner's error must still be recorded."""
    from reference_graphy.context import assessment_due
    from reference_graphy.evidence import pending

    tools = LearningTools(tmp_path, lesson)
    lesson.add({"role": "assistant", "content": "Задача: какой размер у матрицы с двумя строками и тремя столбцами?"})
    lesson.add({"role": "user", "content": "3×2"})
    ref = pending(lesson)[-1]
    bad = {"id": "r1", "name": "record_assessment", "arguments": {
        "items": [{"evidence_ref": ref, "outcome": "with_hints", "assistance": "none", "feedback": "Размер перепутан"}]}}
    result = await tools.execute(bad)
    assert result["error"]
    lesson.add({"role": "tool", "call_id": "r1", "name": "record_assessment", **result})
    assert assessment_due(lesson, tools)  # forced again: the hint depends on a recorded gap
    good = bad | {"id": "r2", "arguments": {"items": [{"evidence_ref": ref, "outcome": "gap", "assistance": "none",
                                                     "feedback": "Размер перепутан"}]}}
    assert not (await tools.execute(good)).get("error")
    assert lesson.learning.assessments[-1]["outcome"] == "gap"
    lesson.close()


@pytest.mark.parametrize(("reply_text", "attempt"), [
    ("Понял, всё ясно.", False), ("Ок, понятно, давай дальше", False), ("Ясно, спасибо!", False),
    ("да", True), ("-3sin(3x)", True), ("Понял: ответ 5", True), ("Понял, что это 2x?", True),
])
def test_an_opinion_that_it_is_understood_is_not_an_attempt_but_an_answer_is(lesson, reply_text, attempt):
    from reference_graphy.evidence import pending

    lesson.add({"role": "assistant", "content": "Найди производную e^(5x)?"})
    lesson.add({"role": "user", "content": reply_text})
    assert bool(pending(lesson)) is attempt
