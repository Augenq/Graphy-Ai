"""Regressions for public contracts, durable batches, recovery, and bounded repair."""

import json

import pytest
from reference_graphy.agent import Agent
from reference_graphy.context import checks_declined, request_context, system_prompt
from reference_graphy.contracts import PUBLIC
from reference_graphy.courses import Courses
from reference_graphy.learning_tools import LearningTools
from reference_graphy.providers import payload, strict_schema
from reference_graphy.questions import blank_answer, normalize_questions, validate_schema
from reference_graphy.session import Session
from test_learning import Scripted, response


class NoSkills:
    def list(self):
        return []


@pytest.fixture
def lesson_tools(tmp_path):
    course = Courses(tmp_path).create("Reliability")
    session = Session(tmp_path, tmp_path, course_id=course["id"])
    tools = LearningTools(tmp_path, session, skills=NoSkills())
    yield session, tools
    session.close()


async def call(tools, name, arguments, identifier="operation"):
    return await tools.execute({"id": identifier, "name": name, "arguments": arguments})


def attempt(session, question="Чему равно 2 + 4?", answer="6"):
    session.add({"role": "assistant", "content": question})
    session.add({"role": "user", "content": answer})
    ref = list(session.evidence)[-1]
    return {"evidence_ref": ref, "outcome": "independent", "assistance": "none", "feedback": "Верно"}


@pytest.mark.parametrize("name,args", [
    ("set_learning_plan", {"steps": 12}),
    ("set_learning_plan", {"goal": "Learn", "steps": []}),
    ("set_learning_phase", {"phase": "practice", "step": -1}),
    ("record_assessment", {"items": [None]}),
])
async def test_bad_arguments_are_results_and_do_not_write_partial_state(lesson_tools, name, args):
    session, tools = lesson_tools
    before = session.path.read_bytes()
    result = await call(tools, name, args)
    assert result["error"]
    assert session.path.read_bytes() == before


async def test_plan_is_one_atomic_record_and_revisions_do_not_reuse_retired_ids(lesson_tools):
    session, tools = lesson_tools
    args = {"goal": "Сложение", "steps": ["Числа", "Сумма"]}
    result = await call(tools, "set_learning_plan", args)
    assert not result.get("error")
    assert session.learning.phase == "teaching" and session.learning.current_step == "s1"
    assert len([e for e in session.events if e["type"] == "learning_transaction"]) == 1
    before = session.path.read_bytes()
    assert await call(tools, "set_learning_plan", args) == result
    assert session.path.read_bytes() == before
    await call(tools, "set_learning_plan", {"goal": "Сложение", "steps": ["Сумма", "Проверка"]}, "revise")
    assert session.learning.steps == [{"id": "s2", "title": "Сумма"}, {"id": "s3", "title": "Проверка"}]


async def test_assessment_is_idempotent_by_evidence_and_corrections_are_explicit(lesson_tools):
    session, tools = lesson_tools
    item = attempt(session)
    assert not (await call(tools, "record_assessment", {"items": [item]})).get("error")
    old_id = session.learning.assessments[0]["id"]
    await call(tools, "record_assessment", {"items": [item]}, "new-call")
    assert len(session.learning.assessments) == 1
    changed = item | {"outcome": "uncertain", "feedback": "Нужно уточнение"}
    assert (await call(tools, "record_assessment", {"items": [changed]}, "conflict"))["error"]
    changed["correction"] = True
    assert not (await call(tools, "record_assessment", {"items": [changed]}, "correct")).get("error")
    assert session.learning.assessments[-1]["supersedes"] == old_id
    assert len(session.learning.context()["observations"]) == 1
    assert len(Courses(session.root).progress(session.course_id)["observations"]) == 2
    path = session.path
    session.close()
    restored = Session(session.root, session.root, path, course_id=session.course_id)
    try:
        assert len(restored.learning.assessments) == 2
        assert item["evidence_ref"] in restored.evidence
        assert restored.operation_results["correct"]["saved"]
    finally:
        restored.close()


async def test_bad_second_item_and_storage_failure_commit_no_assessments(lesson_tools, monkeypatch):
    session, tools = lesson_tools
    item = attempt(session)
    before = session.path.read_bytes()
    result = await call(tools, "record_assessment", {"items": [item, item | {"evidence_ref": "missing"}]})
    assert result["error"] and not session.learning.assessments
    assert session.path.read_bytes() == before

    def unavailable(*args, **kwargs):
        raise OSError("disk unavailable")

    monkeypatch.setattr(session, "append", unavailable)
    result = await call(tools, "record_assessment", {"items": [item]})
    assert result["error"] and "storage_error" in result["content"]
    assert not session.learning.assessments


async def test_short_yes_can_answer_a_real_task(lesson_tools):
    session, tools = lesson_tools
    item = attempt(session, "Число 2 является простым? Ответь да или нет.", "да")
    result = await call(tools, "record_assessment", {"items": [item]})
    assert not result.get("error")
    assert session.learning.assessments[0]["answer"]["text"] == "да"


async def test_rejected_form_can_fall_back_to_explanation_and_does_not_poison_next_turn(lesson_tools):
    session, tools = lesson_tools
    bad = {"id": "bad", "name": "ask_questions", "arguments": {"title": "Test", "questions": []}}
    provider = Scripted(response(calls=[bad]), response("Объясню на примере."), response("Продолжим."))
    events = []

    async def emit(event):
        events.append(event)

    agent = Agent(session, tools, provider, {"id": "fake", "context": 32768}, emit)
    await agent.run({"role": "user", "content": "Объясни"})
    assert session.messages[-1]["content"] == "Объясню на примере."
    await agent.run({"role": "user", "content": "Дальше"})
    assert not session.pending_question and not agent.question_error


async def test_repeated_invalid_forms_stop_without_relaxing_constraints(lesson_tools):
    session, tools = lesson_tools
    calls = [response(calls=[{"id": f"bad{i}", "name": "ask_questions",
                              "arguments": {"title": "Test", "questions": []}}]) for i in range(3)]
    provider = Scripted(*calls)
    events = []

    async def emit(event):
        events.append(event)

    await Agent(session, tools, provider, {"id": "fake", "context": 32768}, emit).run({"role": "user", "content": "Тест"})
    assert len(provider.requests) == 3 and not session.pending_question
    assert len([m for m in session.messages if m["role"] == "tool"]) == 3
    assert any(e["type"] == "notice" and "Тест не открыт" in e["text"] for e in events)


def test_prompt_is_stable_and_strict_optional_fields_round_trip(lesson_tools):
    session, tools = lesson_tools
    original = system_prompt(session, tools)
    session.learning.goal = "New goal"
    session.learning.phase = "practice"
    assert original == system_prompt(session, tools)
    assert "New goal" in json.dumps(request_context(session, tools), ensure_ascii=False)
    schema = strict_schema(PUBLIC["set_learning_phase"])
    validate_schema(schema, {"phase": "teaching", "step": None})
    assert schema["additionalProperties"] is False


async def test_complete_json_encoded_step_array_is_normalized_without_salvaging_invalid_json(lesson_tools):
    session, tools = lesson_tools
    result = await call(tools, "set_learning_plan", {"goal": "Сложение", "steps": '["Числа", "Сумма"]'})
    assert not result.get("error") and len(session.learning.steps) == 2
    before = session.path.read_bytes()
    result = await call(tools, "set_learning_plan", {"goal": "Сложение", "steps": '["Обрезано"'}, "bad")
    assert result["error"] and session.path.read_bytes() == before


async def test_non_attempt_classification_is_durable_without_a_fake_assessment(lesson_tools):
    session, tools = lesson_tools
    item = attempt(session, "Что ты уже изучал?", "Я знаю основы Python")
    result = await call(tools, "record_assessment", {"items": [], "ignore_refs": [item["evidence_ref"]]})
    assert not result.get("error") and not session.learning.assessments
    assert item["evidence_ref"] in session.learning.ignored_evidence
    from reference_graphy.context import assessment_due
    assert not assessment_due(session, tools)


async def test_empty_assessment_is_a_noop_only_without_pending_attempts(lesson_tools):
    session, tools = lesson_tools
    before = session.path.read_bytes()
    result = await call(tools, "record_assessment", {"items": []})
    assert not result.get("error") and session.path.read_bytes() == before
    attempt(session)
    result = await call(tools, "record_assessment", {"items": []}, "pending")
    assert result.get("error") and not session.learning.assessments


def test_no_chat_checks_persists_but_form_refusal_does_not_disable_chat_practice(lesson_tools):
    session, _ = lesson_tools
    session.add({"role": "user", "content": "Объясни, пока без проверочных вопросов"})
    session.add({"role": "user", "content": "Прочитай документацию"})
    assert checks_declined(session)
    session.add({"role": "user", "content": "Дай задачу, хочу потренироваться"})
    assert not checks_declined(session)
    session.add({"role": "user", "content": "Проверь меня в чате, без формы теста"})
    assert not checks_declined(session)


async def test_observations_are_not_duplicated_but_return_after_compaction(lesson_tools):
    session, tools = lesson_tools
    item = attempt(session)
    operation = {"id": "grade", "name": "record_assessment", "arguments": {"items": [item]}}
    session.add(response(calls=[operation]))
    result = await tools.execute(operation)
    session.add({"role": "tool", "name": "record_assessment", "call_id": "grade", **result})
    before = next(m for m in request_context(session, tools) if m["role"] == "context")
    assert "observations" not in json.loads(before["content"].split("\n", 1)[1])
    session.append("compact", summary="Предыдущее задание выполнено.", boundary=len(session.messages))
    after = next(m for m in request_context(session, tools) if m["role"] == "context")
    assert json.loads(after["content"].split("\n", 1)[1])["observations"][0]["feedback"] == "Верно"


@pytest.mark.parametrize("answer,hint_only", [("5", True), ("5. Покажи полное решение, пожалуйста", False)])
async def test_wrong_attempt_sets_hint_only_action_without_blocking_requested_solution(lesson_tools, answer, hint_only):
    session, tools = lesson_tools
    item = attempt(session, answer=answer) | {"outcome": "gap", "feedback": "Проверь сложение"}
    await call(tools, "record_assessment", {"items": [item]})
    state = next(m for m in request_context(session, tools) if m["role"] == "context")
    assert ("Do NOT reveal the answer" in state["content"]) is hint_only
    session.add({"role": "user", "content": "Покажи полное решение, пожалуйста"})
    state = next(m for m in request_context(session, tools) if m["role"] == "context")
    assert "Do NOT reveal the answer" not in state["content"]


async def test_declared_unknown_gets_teaching_instead_of_wrong_answer_hint(lesson_tools):
    session, tools = lesson_tools
    question = {"prompt": "Чему равно 2 + 4?", "type": "single_choice",
                "options": ["5", "6"], "correct": [2]}
    operation = {"id": "unknown-quiz", "name": "ask_questions", "arguments": {
        "title": "Проверка", "questions": [question, question, question]}}
    session.add(response(calls=[operation]))
    block = session.open_question(operation)
    answers = [blank_answer(q) | {"status": "dont_know"} for q in block["questions"]]
    session.resolve_question(block["batch_id"], answers)
    items = [{"evidence_ref": ref, "outcome": "gap", "assistance": "none", "feedback": "Нужно объяснение"}
             for ref in session.evidence]
    result = await call(tools, "record_assessment", {"items": items})
    assert not result.get("error")
    state = next(m for m in request_context(session, tools) if m["role"] == "context")
    action = json.loads(state["content"].split("\n", 1)[1])["next_action"]
    assert "Teach the missing prerequisite" in action
    assert "Give ONE targeted hint" not in action
    assert "pending task's answer hidden" in action


@pytest.mark.parametrize("api", ["chat", "responses", "codex", "anthropic", "google"])
def test_required_bookkeeping_tool_is_serialized_for_each_protocol(api):
    model = {"id": "test", "provider": "test", "api": api, "tool_choice": "set_learning_plan"}
    tools = [{"name": "set_learning_plan", "description": "Save plan", "parameters": PUBLIC["set_learning_plan"]}]
    _, _, body = payload(model, [{"role": "context", "content": "Lesson data"},
                                 {"role": "user", "content": "Teach me"}], "Tutor", tools, "off", "session")
    expected = {"chat": {"type": "function", "function": {"name": "set_learning_plan"}},
                "responses": {"type": "function", "name": "set_learning_plan"},
                "codex": {"type": "function", "name": "set_learning_plan"},
                "anthropic": {"type": "tool", "name": "set_learning_plan"}}
    if api == "google":
        assert body["toolConfig"]["functionCallingConfig"] == {"mode": "ANY", "allowedFunctionNames": ["set_learning_plan"]}
    else:
        assert body["tool_choice"] == expected[api]
    assert '"role": "context"' not in json.dumps(body)


async def test_committed_operation_without_tool_result_recovers_without_reexecution(lesson_tools):
    session, tools = lesson_tools
    arguments = {"goal": "Сложение", "steps": ["Числа", "Сумма"]}
    session.add(response(calls=[{"id": "committed", "name": "set_learning_plan", "arguments": arguments}]))
    await call(tools, "set_learning_plan", arguments, "committed")
    path = session.path
    session.close()
    restored = Session(session.root, session.root, path, course_id=session.course_id)
    try:
        assert restored.learning.plan_version == 1
        assert restored.messages[-1]["role"] == "tool"
        assert json.loads(restored.messages[-1]["content"])["recorded"] == "learning_plan"
        assert len([e for e in restored.events if e["type"] == "learning_transaction"]) == 1
    finally:
        restored.close()


async def test_expected_answer_requests_named_assessment_and_empty_retries_are_counted(lesson_tools):
    session, tools = lesson_tools
    attempt(session)
    models = []
    usage = {"input": 20, "output": 1, "cache_read": 0, "cache_write": 0, "cost": 0.001}

    class Observed:
        async def stream(self, model, *args):
            models.append(model)
            return response("" if len(models) == 1 else "Объяснение") | {"usage": usage}

    async def emit(event):
        pass

    await Agent(session, tools, Observed(), {"id": "test", "context": 32768}, emit, {"retries": 1}).run()
    assert all(model["tool_choice"] == "record_assessment" for model in models)
    assert session.usage()["cost"] == 0.002


async def test_failed_assessment_blocks_dependent_finish_in_same_response(lesson_tools):
    session, tools = lesson_tools
    calls = [{"id": "bad", "name": "record_assessment", "arguments": {"items": [{
        "evidence_ref": "missing", "outcome": "gap", "assistance": "none", "feedback": "Wrong"}]}},
        {"id": "finish", "name": "finish_lesson", "arguments": {"summary": "Done", "next_step": ""}}]
    provider = Scripted(response(calls=calls), response("Попробуем иначе."))

    async def emit(event):
        pass

    await Agent(session, tools, provider, {"id": "test", "context": 32768}, emit).run({"role": "user", "content": "Finish"})
    assert not session.learning.finished
    results = [m for m in session.messages if m["role"] == "tool"]
    assert len(results) == 2 and all(m["error"] for m in results)


async def test_skill_directory_does_not_steal_a_learner_material_path(lesson_tools):
    session, tools = lesson_tools
    notes = tools.cwd / "notes.md"
    notes.write_text("Actual learner material")
    skill = tools.cwd / ".graphy/skills/example/SKILL.md"
    session.append("learning_skill", data={"name": "example", "path": str(skill)})
    session.add({"role": "user", "content": "Прочитай notes.md"})
    result = await call(tools, "read", {"path": str(skill.parent / "notes.md")})
    assert not result.get("error") and "Actual learner material" in result["content"]
    assert "Resolved learner material" in result["content"]


@pytest.mark.parametrize("learner_request", [
    "Найди документацию https://docs.python.org/3/tutorial/ и объясни правило, до 80 слов.",
    "Без новых тестов. Заверши занятие и сохрани итог по уже отправленным ответам.",
])
async def test_document_requests_are_not_scored_as_skipped_exercises(lesson_tools, learner_request):
    session, tools = lesson_tools
    item = attempt(session, "Первый индекс — 0. Готов продолжить?", learner_request)
    from reference_graphy.context import assessment_due
    assert not assessment_due(session, tools)
    result = await call(tools, "record_assessment", {"items": [item | {"outcome": "skipped"}]})
    assert not result.get("error") and not session.learning.assessments
    assert item["evidence_ref"] in session.learning.ignored_evidence


def test_numeric_choice_labels_never_override_public_key_positions(lesson_tools):
    session, _ = lesson_tools
    question = {"prompt": "Выбери чётные", "type": "multiple_choice",
                "options": ["2", "3", "4", "5"], "correct": [1, 3]}
    arguments = {"title": "Числа", "questions": [question, question | {"prompt": "Ещё раз"},
                                                  {"prompt": "Объясни", "type": "free_text"}]}
    operation = {"id": "quiz", "name": "ask_questions", "arguments": arguments}
    session.add(response(calls=[operation]))
    block = session.open_question(operation)
    assert block["questions"][0]["grading"]["correct_option_ids"] == ["a", "c"]
    answers = [blank_answer(q) for q in block["questions"]]
    for answer in answers[:2]:
        answer.update(status="answered", selected_option_ids=["a", "c"])
    answers[2].update(status="answered", text="Делятся на два без остатка")
    result = session.resolve_question(block["batch_id"], answers)
    projected = session.question_projection(result)
    attempts = json.loads(projected["content"])["attempts"]
    assert attempts[0]["key_verdict"] is True and attempts[0]["selected_option_numbers"] == [1, 3]
    assert session.messages[0]["calls"][0]["arguments"] == arguments
    coerced = normalize_questions({"questions": [question | {"correct": ["3"]}]})
    assert coerced["questions"][0]["grading"]["correct_option_ids"] == ["c"]
