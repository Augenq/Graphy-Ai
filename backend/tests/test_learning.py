"""Human-in-the-loop protocol, durable evidence and course isolation."""

import copy
import json
from collections import deque

import pytest
from reference_graphy.agent import Agent
from reference_graphy.context import compact, system_prompt
from reference_graphy.courses import Courses
from reference_graphy.learning_tools import LearningTools
from reference_graphy.providers import payload
from reference_graphy.questions import blank_answer, formal_results, validate_answers, validate_questions
from reference_graphy.session import Session

MODEL = {"id": "test", "context": 128000}
BLOCK = {
    "title": "Три шага",
    "purpose": "diagnosis",
    "questions": [
        {"id": "one", "type": "single_choice", "prompt": "Выбери одно",
         "options": [{"id": "a", "label": "Первое"}, {"id": "b", "label": "Второе"}],
         "grading": {"correct_option_ids": ["a"], "explanation": "HIDDEN_SOLUTION"}},
        {"id": "many", "type": "multiple_choice", "prompt": "Выбери несколько",
         "options": [{"id": "a", "label": "Первое"}, {"id": "b", "label": "Второе"}],
         "grading": {"correct_option_ids": ["a", "b"]}},
        {"id": "text", "type": "free_text", "prompt": "Объясни своими словами"},
    ],
}


def response(content="", calls=None):
    return {"role": "assistant", "content": content, "calls": calls or [], "stop": "stop"}


def question_call(identifier="ask", block=None):
    return {"id": identifier, "name": "ask_questions", "arguments": copy.deepcopy(block or BLOCK)}


def complete_answers(block=BLOCK):
    values = [blank_answer(q) for q in block["questions"]]
    values[0].update(status="answered", selected_option_ids=["a"], reasoning="Я думаю так, потому что…")
    values[1].update(status="answered", selected_option_ids=["b", "a"], reasoning="Оба подходят")
    values[2].update(status="answered", text="Мой ответ\nсо второй строкой", reasoning="Пример рассуждения")
    return values


class Scripted:
    def __init__(self, *responses):
        self.responses = deque(responses)
        self.requests = []

    async def stream(self, model, messages, system, tools, thinking, session_id, emit):
        self.requests.append(copy.deepcopy(messages))
        assert self.responses, "Unexpected request while waiting for human answers"
        return copy.deepcopy(self.responses.popleft())


@pytest.fixture
def lesson(tmp_path):
    course = Courses(tmp_path).create("Математика")
    session = Session(tmp_path, tmp_path, course_id=course["id"])
    yield session
    session.close()


def make_agent(lesson, provider):
    events = []

    async def emit(event):
        events.append(copy.deepcopy(event))

    tools = LearningTools(lesson.path.parent, lesson)
    return Agent(lesson, tools, provider, MODEL, emit), events


def open_question(lesson, identifier="ask"):
    call = question_call(identifier)
    lesson.add(response(calls=[call]))
    lesson.open_question(call)


async def test_question_stops_until_complete_package_then_resumes_without_user_message(lesson):
    provider = Scripted(response(calls=[question_call()]), response("Разбор всех ответов"))
    agent, events = make_agent(lesson, provider)
    await agent.run({"role": "user", "content": "Хочу разобраться"})
    assert len(provider.requests) == 1
    assert lesson.pending_question and lesson.messages[-1]["role"] == "assistant"
    assert not any(m["role"] == "tool" for m in lesson.messages)
    values = complete_answers()
    lesson.save_question_draft("ask", values, 2)
    lesson.save_question_draft("ask", values, 0)
    assert len(provider.requests) == 1
    with pytest.raises(ValueError, match="open question"):
        await agent.run({"role": "user", "content": "do not bypass"})
    result = lesson.resolve_question("ask", values)
    assert lesson.pending_question is None and lesson.needs_continuation
    assert json.loads(result["content"])["answers"] == values
    assert json.loads(result["content"])["formal_results"] == [
        {"question_id": "one", "correct": True}, {"question_id": "many", "correct": True},
        {"question_id": "text", "correct": None}]
    await agent.run()
    assert len(provider.requests) == 2
    assert provider.requests[-1][-1] == lesson.question_projection(result)
    projected = json.loads(provider.requests[-1][-1]["content"])
    assert "answers" not in projected and len(projected["attempts"]) == 3
    assert projected["attempts"][0]["reasoning"] == complete_answers()[0]["reasoning"]
    assert [m["role"] for m in provider.requests[-1] if m["role"] != "context"] == ["user", "assistant", "tool"]
    assert not lesson.needs_continuation
    assert any(e["type"] == "question_opened" for e in events)
    with pytest.raises(ValueError, match="already been resolved"):
        lesson.resolve_question("ask", values)


async def test_mixed_question_and_mutation_execute_nothing_then_retry(lesson):
    plan = {"id": "plan", "name": "set_learning_plan", "arguments": {"steps": [{"id": "x", "title": "X"}]}}
    provider = Scripted(response(calls=[plan, question_call()]), response(calls=[question_call("fixed")]))
    agent, _ = make_agent(lesson, provider)
    await agent.run({"role": "user", "content": "start"})
    assert lesson.learning.steps == []
    errors = provider.requests[1][-2:]
    assert all(m["role"] == "tool" and m["error"] for m in errors)
    assert lesson.pending_question["batch_id"] == "fixed"


async def test_invalid_question_returns_error_and_model_retries(lesson):
    bad = copy.deepcopy(BLOCK)
    bad["questions"][0]["options"][1]["id"] = "a"
    provider = Scripted(response(calls=[question_call(block=bad)]), response(calls=[question_call("fixed")]))
    agent, _ = make_agent(lesson, provider)
    await agent.run({"role": "user", "content": "start"})
    assert provider.requests[1][-1]["error"]
    assert lesson.pending_question["batch_id"] == "fixed"


def test_recovery_open_block_drafts_submission_and_damaged_tail(tmp_path):
    course = Courses(tmp_path).create("Тема")
    session = Session(tmp_path, tmp_path, course_id=course["id"])
    open_question(session)
    values = complete_answers()
    session.save_question_draft("ask", values, 1)
    path = session.path
    session.close()
    other = tmp_path / "different-directory"
    other.mkdir()
    session = Session(tmp_path, other, path, course_id=course["id"])
    assert session.pending_question["step"] == 1 and session.pending_question["answers"] == values
    assert not [m for m in session.messages if m["role"] == "tool"]
    session.resolve_question("ask", values)
    session.close()
    with path.open("ab") as stream:
        stream.write(b'{"type":')
    session = Session(tmp_path, other, path, course_id=course["id"])
    try:
        assert session.warning and session.pending_question is None and session.needs_continuation
        assert len([m for m in session.messages if m["role"] == "tool"]) == 1
        assert session.resolved_questions["ask"]["payload"]["answers"] == values
        assert len([e for e in session.events if e["type"] == "question_resolved"]) == 1
    finally:
        session.close()


def test_recovery_between_assistant_call_and_question_open(tmp_path):
    course = Courses(tmp_path).create("Курс")
    session = Session(tmp_path, tmp_path, course_id=course["id"])
    session.add(response(calls=[question_call()]))
    path = session.path
    session.close()
    session = Session(tmp_path, tmp_path, path, course_id=course["id"])
    try:
        assert session.pending_question["batch_id"] == "ask"
        assert len(session.messages) == 1
    finally:
        session.close()


def test_cancel_keeps_unconfirmed_drafts_and_cannot_be_assessed(lesson):
    open_question(lesson)
    drafts = copy.deepcopy(lesson.pending_question["answers"])
    drafts[0].update(status="answered", selected_option_ids=["b"], reasoning="Не уверен")
    result = lesson.resolve_question("ask", drafts, cancel=True)
    data = json.loads(result["content"])
    assert data["status"] == "cancelled" and data["answers"] == drafts and data["formal_results"] == []
    assert lesson.needs_continuation


@pytest.mark.parametrize("change", [
    lambda a: a[0].update(selected_option_ids=["missing"]),
    lambda a: a[0].update(selected_option_ids=["a", "b"]),
    lambda a: a[0].update(text="custom and selected"),
    lambda a: a[0].update(status="skipped"),
    lambda a: a[1].update(question_id="one"),
    lambda a: a[2].update(status="draft"),
    lambda a: a.pop(),
])
def test_invalid_submission_is_transactional(lesson, change):
    open_question(lesson)
    values = complete_answers()
    before = lesson.path.read_bytes()
    change(values)
    with pytest.raises(ValueError):
        lesson.resolve_question("ask", values)
    assert lesson.path.read_bytes() == before and lesson.pending_question


def test_custom_answer_skips_and_order_independent_scoring():
    values = complete_answers()
    values[0].update(selected_option_ids=[], text="Собственная формулировка")
    values[1].update(selected_option_ids=[], status="skipped")
    validate_answers(BLOCK, values, final=True)
    assert formal_results(BLOCK, values)[0]["correct"] is None
    assert formal_results(BLOCK, values)[1]["correct"] is None
    no_custom = copy.deepcopy(BLOCK)
    no_custom["questions"][0]["allow_custom_answer"] = False
    with pytest.raises(ValueError, match="disabled"):
        validate_answers(no_custom, values, final=True)


async def test_assessments_require_evidence_preserve_corrections_and_hints(lesson):
    tools = LearningTools(lesson.path.parent, lesson)
    data = {"id": "first", "batch_id": "ask", "question_id": "one", "outcome": "independent",
            "feedback": "Верный выбор, но рассуждение нужно проверить", "used_hints": False}
    call = {"id": "grade", "name": "record_assessment", "arguments": data}
    assert (await tools.execute(call))["error"]
    open_question(lesson)
    lesson.resolve_question("ask", complete_answers())
    assert not (await tools.execute(call)).get("error")
    assert len(lesson.learning.assessments) == 1
    assert not (await tools.execute(call)).get("error")
    assert len(lesson.learning.assessments) == 1
    correction = data | {"id": "second", "supersedes": "first", "outcome": "with_hints", "used_hints": True}
    assert not (await tools.execute(call | {"id": "correction", "arguments": correction})).get("error")
    wrong = correction | {"id": "third", "outcome": "independent"}
    assert (await tools.execute(call | {"id": "bad", "arguments": wrong}))["error"]
    assert lesson.learning.assessments[-1]["source_message_id"]


async def test_cancelled_drafts_cannot_be_graded(lesson):
    open_question(lesson)
    lesson.resolve_question("ask", complete_answers(), cancel=True)
    tools = LearningTools(lesson.path.parent, lesson)
    result = await tools.execute({"id": "grade", "name": "record_assessment", "arguments": {
        "id": "grade", "batch_id": "ask", "question_id": "one", "outcome": "gap", "feedback": "x", "used_hints": False}})
    assert result["error"] and not lesson.learning.assessments


async def test_plan_phase_validation_and_read_only_tools(lesson, tmp_path):
    tools = LearningTools(tmp_path, lesson)
    assert not {"write", "edit"} & {t["name"] for t in tools.declarations}
    assert (await tools.execute({"id": "write", "name": "write", "arguments": {"path": "x", "content": "x"}}))["error"]
    phase = {"id": "p", "name": "set_learning_phase", "arguments": {"phase": "teaching"}}
    assert (await tools.execute(phase))["error"]
    plan = {"id": "plan", "name": "set_learning_plan", "arguments": {"steps": [{"id": "x", "title": "Тема"}]}}
    assert not (await tools.execute(plan)).get("error")
    assert not (await tools.execute(phase | {"arguments": {"phase": "teaching", "current_step": "x"}})).get("error")
    assert lesson.learning.phase == "teaching"
    bad = copy.deepcopy(BLOCK)
    bad["questions"][0]["topic_id"] = "missing"
    with pytest.raises(ValueError, match="topic_id"):
        validate_questions(bad, {"x"})


async def test_courses_memory_cache_isolation_and_rebuild(lesson, tmp_path):
    tools = LearningTools(tmp_path, lesson)
    open_question(lesson)
    lesson.resolve_question("ask", complete_answers())
    await tools.execute({"id": "grade", "name": "record_assessment", "arguments": {
        "id": "first", "batch_id": "ask", "question_id": "one", "outcome": "gap",
        "feedback": "Проверить понимание производной", "used_hints": False}})
    courses = Courses(tmp_path)
    other = courses.create("Другой курс")
    assert not courses.progress(other["id"])["observations"]
    assert courses.memory(lesson.course_id, "производной")[0]["outcome"] == "gap"
    assert not courses.memory(lesson.course_id, "фотосинтез")
    cache = lesson.path.parent.parent / "progress.json"
    cache.write_text("broken")
    assert courses.progress(lesson.course_id)["observations"][0]["source_message_id"]
    await tools.execute({"id": "correct", "name": "record_assessment", "arguments": {
        "id": "second", "supersedes": "first", "batch_id": "ask", "question_id": "one", "outcome": "uncertain",
        "feedback": "Понимание производной ещё не проверено", "used_hints": False}})
    assert [r["outcome"] for r in courses.memory(lesson.course_id, "производной")] == ["uncertain"]
    assert not courses.memory(lesson.course_id, "производной", budget=5)
    with pytest.raises(ValueError):
        Session(tmp_path, tmp_path, lesson.path, course_id=other["id"])


async def test_compaction_never_runs_during_question_or_discards_current_answers(lesson):
    for _i in range(8):
        lesson.add({"role": "user", "content": "old material " * 500})
        lesson.add(response("old explanation " * 500))
    open_question(lesson)
    provider = Scripted(response("summary"))
    with pytest.raises(ValueError, match="open question"):
        await compact(lesson, provider, MODEL)
    assert not provider.requests
    result = lesson.resolve_question("ask", complete_answers())
    await compact(lesson, provider, MODEL, keep=50)
    assert lesson.boundary > 0 and lesson.context[-1] == lesson.question_projection(result)
    assert any(c["id"] == "ask" for m in lesson.context for c in m.get("calls", []))
    assert "reasoning" in lesson.context[-1]["content"]
    from reference_graphy.context import request_context
    assert any("Application lesson state" in m["content"] for m in request_context(lesson, LearningTools(lesson.path.parent, lesson)))


@pytest.mark.parametrize("api", ["chat", "responses", "anthropic", "google", "codex"])
def test_question_result_serializes_for_each_provider(lesson, api):
    open_question(lesson)
    result = lesson.resolve_question("ask", complete_answers())
    model = MODEL | {"api": api, "provider": "test", "max_output": 2000}
    body = payload(model, lesson.context, "teacher", LearningTools(lesson.path.parent, lesson).declarations, "off", lesson.id)
    encoded = json.dumps(body, ensure_ascii=False)
    assert "ask_questions" in encoded and "Пример рассуждения" in encoded
    assert json.loads(result["content"])["answers"] == complete_answers()


async def test_diagnostic_topic_ids_before_plan_pause_resume_and_survive_restart(lesson, tmp_path):
    block = copy.deepcopy(BLOCK)
    for q in block['questions']:
        q['topic_id'] = 'prerequisites'
    provider = Scripted(response(calls=[question_call(block=block)]), response('Теперь составим план'))
    agent, events = make_agent(lesson, provider)
    await agent.run({'role': 'user', 'content': 'Сначала проверь мои знания'})
    assert not lesson.learning.steps
    assert lesson.pending_question and len(provider.requests) == 1
    assert lesson.pending_question['questions'][0]['topic_id'] == 'prerequisites'
    path, root, cwd, course_id = lesson.path, lesson.root, tmp_path, lesson.course_id
    lesson.close()
    restored = Session(root, cwd, path=path, course_id=course_id)
    try:
        assert restored.pending_question and not restored.learning.steps
        restored.resolve_question('ask', complete_answers(block))
        agent, _ = make_agent(restored, provider)
        await agent.run()
        assert len(provider.requests) == 2
        assert restored.messages[-1]['content'] == 'Теперь составим план'
    finally:
        restored.close()


async def test_free_text_grading_error_explains_fix_and_questions_can_retry(lesson):
    bad = copy.deepcopy(BLOCK)
    bad['questions'][2]['grading'] = {'correct_option_ids': ['free']}
    provider = Scripted(response(calls=[question_call(block=bad)]), response(calls=[question_call('fixed')]))
    agent, _ = make_agent(lesson, provider)
    await agent.run({'role': 'user', 'content': 'Проверь знания'})
    error = provider.requests[1][-1]
    assert error['error'] and 'NO questions were displayed' in error['content']
    assert 'Question text: free_text has no options' in error['content']
    assert 'Remove grading.correct_option_ids' in error['content']
    assert lesson.pending_question['batch_id'] == 'fixed'


async def test_failed_question_cannot_silently_end_with_claim_it_was_sent(lesson):
    bad = copy.deepcopy(BLOCK)
    bad['questions'][2]['grading'] = {'correct_option_ids': ['free']}
    provider = Scripted(response(calls=[question_call(block=bad)]), response('Вопросы отправлены, жду ответов'))
    agent, _ = make_agent(lesson, provider)
    with pytest.raises(ValueError, match='Вопросы не открыты'):
        await agent.run({'role': 'user', 'content': 'Проверь знания'})
    assert not lesson.pending_question


async def test_plain_chat_exchange_can_be_recorded_as_evidence_without_a_form(lesson, tmp_path):

    tools = LearningTools(lesson.path.parent, lesson)
    lesson.add({"role": "assistant", "content": "Давай проверим.\nЧему равна производная x²?"})
    lesson.add({"role": "user", "content": "Производная x² это 2x"})
    data = {"id": "chat-1", "question": "Чему равна производная x²?", "answer": "Производная x² это 2x",
            "topic_id": "derivative", "outcome": "independent", "feedback": "Верно, применил правило степени",
            "used_hints": False}

    def call(name, arguments):
        return {"id": name, "name": "record_assessment", "arguments": arguments}

    assert not (await tools.execute(call("a", data))).get("error")
    saved = lesson.learning.assessments[-1]
    assert saved["batch_id"] == "" and saved["answer"]["text"] == "Производная x² это 2x"
    assert saved["source_message_id"]
    # A second chat observation is independent of the first, not an "unsuperseded duplicate" of a form answer.
    assert not (await tools.execute(call("b", data | {"id": "chat-2", "question": "А производная x³?"}))).get("error")
    assert not (await tools.execute(call("c", data | {"id": "chat-3", "supersedes": "chat-1", "outcome": "with_hints",
                                                      "used_hints": True}))).get("error")
    assert len(lesson.learning.assessments) == 3
    omitted = {"id": "auto", "outcome": "independent", "feedback": "Верно", "used_hints": False}
    assert not (await tools.execute(call("auto", omitted))).get("error")  # question and answer come from the chat
    auto = lesson.learning.assessments[-1]
    assert auto["question"] == "Чему равна производная x²?" and auto["answer"]["text"] == "Производная x² это 2x"
    # A supersedes that points at nothing (a habit of some models, even at their own new id) is simply ignored.
    ghost = await tools.execute(call("ghost", data | {"id": "ghost", "supersedes": "ghost"}))
    assert not ghost.get("error") and "supersedes" not in lesson.learning.assessments[-1]
    assert not (await tools.execute(call("ghost2", data | {"id": "ghost2", "supersedes": "missing"}))).get("error")
    assert not (await tools.execute(call("stray", data | {"id": "stray", "question_id": "q2"}))).get("error")
    assert lesson.learning.assessments[-1]["question_id"] == ""
    for bad in (data | {"id": "x4", "used_hints": True},
                data | {"id": "chat-1"}):
        assert (await tools.execute(call(bad["id"], bad)))["error"], bad
    assert len(lesson.learning.assessments) == 7
    # And it reloads from disk (the session validator accepts what the tool wrote).
    path = lesson.path
    lesson.close()
    reopened = Session(tmp_path, tmp_path, path, course_id=lesson.course_id)
    assert [a["id"] for a in reopened.learning.assessments] == ["chat-1", "chat-2", "chat-3", "auto", "ghost", "ghost2", "stray"]


def test_system_prompt_reminds_to_record_a_chat_answer_only_at_the_start_of_a_turn(lesson, tmp_path):
    from reference_graphy.context import pending_check, request_context

    tools = LearningTools(tmp_path, lesson)
    lesson.add({"role": "user", "content": "Объясни предел"})
    lesson.add({"role": "assistant", "content": "Предел — это значение, к которому стремится функция.\nПроверь себя: чему равен lim 7 при x→3?"})
    assert pending_check(lesson) == ""  # the learner has not replied yet
    lesson.add({"role": "user", "content": "7"})
    assert "чему равен lim 7" in pending_check(lesson)
    before = system_prompt(lesson, tools)
    assert 'evidence_ref' in request_context(lesson, tools)[-2]['content']
    lesson.add({"role": "tool", "call_id": "x", "name": "record_assessment", "content": "{}"})
    assert pending_check(lesson) == ""
    assert before == system_prompt(lesson, tools)
    lesson.add({"role": "assistant", "content": "Верно."})
    lesson.add({"role": "user", "content": "/progress"})
    assert pending_check(lesson) == ""


def test_a_task_line_without_a_question_mark_still_counts_as_the_question_the_learner_answers():
    from reference_graphy.context import asked_in

    assert asked_in("Пример: lim 7 = 7.\n\nПроверь себя:\nПредел функции y = -4 при x → 10 равен?") == "Предел функции y = -4 при x → 10 равен?"
    assert asked_in("Теория.\nПроверь себя:\nДля f(x) = x найдите lim[x→3⁻] f(x).") .startswith("Для f(x) = x найдите")
    assert asked_in("Для функции найдите предел слева и справа.") == "Для функции найдите предел слева и справа."
    assert asked_in("Это всё про пределы. Дальше будет интереснее.") == ""


def test_bare_agreement_is_recognized_but_a_real_answer_is_not():
    from reference_graphy.context import is_acknowledgement as ack

    for text in ("Ага", "да", "Ок!", "понял", "Да, понятно", "ну да", "всё ясно", "угу."):
        assert ack(text), text
    for text in ("2x", "Да, потому что x² даёт 2x", "5", "нет", "x = 5 и y = 10", "ага, а как установить?", ""):
        assert not ack(text), text


async def test_a_bare_yes_is_rejected_as_evidence_and_gets_no_reminder(lesson, tmp_path):
    from reference_graphy.context import pending_check

    tools = LearningTools(lesson.path.parent, lesson)
    lesson.add({"role": "assistant", "content": "Пример: x = 5.\nПонял, как работают переменные?"})
    lesson.add({"role": "user", "content": "Ага"})
    assert pending_check(lesson) == ""
    data = {"id": "yes-1", "outcome": "independent", "feedback": "Learner confirmed understanding", "used_hints": False}
    result = await tools.execute({"id": "r", "name": "record_assessment", "arguments": data})
    assert result["error"] and "not evidence" in result["content"] and not lesson.learning.assessments
    # An honest "unclear" or a skipped answer may still be recorded; a real answer is evidence.
    assert not (await tools.execute({"id": "r2", "name": "record_assessment",
                                     "arguments": data | {"id": "yes-2", "outcome": "uncertain"}})).get("error")
    lesson.add({"role": "assistant", "content": "Чему равно x + 1, если x = 5?"})
    lesson.add({"role": "user", "content": "6"})
    assert pending_check(lesson).startswith("Чему равно")
    assert not (await tools.execute({"id": "r3", "name": "record_assessment",
                                     "arguments": data | {"id": "six", "feedback": "Верно: 5 + 1 = 6"}})).get("error")


def test_submitted_result_tells_the_model_whose_answers_these_are_in_words(lesson):
    from reference_graphy.questions import question_summary

    open_question(lesson)
    message = lesson.resolve_question("ask", complete_answers())
    payload = json.loads(message["content"])
    assert "LEARNER" in payload["note"] and "not system-generated" in payload["note"]
    rows = payload["learner_answers"]
    assert [r["question_id"] for r in rows] == [q["id"] for q in BLOCK["questions"]]
    first = rows[0]
    assert first["question"] == BLOCK["questions"][0]["prompt"] and first["learner_answer"]  # words, not just ids
    assert first["answer_key_says"] in ("correct", "incorrect")
    # The human-facing line is compact and never echoes the test, options or keys.
    call = {"arguments": BLOCK}
    line = question_summary(call, {"content": message["content"]})
    assert line.startswith("Тест «Три шага» · ответы отправлены (3 из 3)")
    for question in BLOCK["questions"]:
        assert question["prompt"] not in line
    assert "HIDDEN_SOLUTION" not in line
    assert question_summary(call, None) == "Тест «Три шага» · ожидает ответов"
    refused = question_summary(call, {"content": "Not executed: Choice questions require options", "error": True})
    assert refused == "Тест «Три шага» · форма не принята, модель исправляет её"


async def test_no_evidence_without_a_learner_reply_and_the_model_cannot_invent_the_answer(lesson, tmp_path):
    tools = LearningTools(lesson.path.parent, lesson)
    fake = {"id": "fake-1", "question": "Понял ли ученик переменные?", "answer": "Да, понял",
            "outcome": "independent", "feedback": "Ученик понял основы переменных", "used_hints": False}

    def call(name, arguments):
        return {"id": name, "name": "record_assessment", "arguments": arguments}

    lesson.add({"role": "user", "content": "Научи меня питону"})  # the very first message answers nothing
    refused = await tools.execute(call("a", fake))
    assert refused["error"] and "has not answered" in refused["content"] and not lesson.learning.assessments
    lesson.add({"role": "assistant", "content": "Переменная — имя для значения.\nЧему равно x + 1, если x = 5?"})
    lesson.add({"role": "user", "content": "6"})
    saved = await tools.execute(call("b", fake | {"id": "real-1", "answer": "ВЫДУМАННЫЙ ОТВЕТ УЧЕНИКА",
                                                  "feedback": "Верно: 5 + 1 = 6"}))
    assert not saved.get("error")
    assert lesson.learning.assessments[-1]["answer"]["text"] == "6"  # what the learner really wrote


async def test_evidence_is_recorded_even_when_the_check_task_has_no_question_mark(lesson, tmp_path):
    tools = LearningTools(lesson.path.parent, lesson)
    lesson.add({"role": "assistant", "content": "Проверка: какие из них квадратные?\n1. 4x - 7 = 0\n2. x² + 5x = 0\n3. x² - 3x + 2 = 0"})
    lesson.add({"role": "user", "content": "1 и 3"})
    data = {"id": "quad-1", "outcome": "gap", "feedback": "Не считает x²+5x=0 квадратным (нет свободного члена)",
            "used_hints": False}
    result = await tools.execute({"id": "r", "name": "record_assessment", "arguments": data})
    assert not result.get("error")
    saved = lesson.learning.assessments[-1]
    assert "x² + 5x = 0" in saved["question"] and saved["answer"]["text"] == "1 и 3"


def test_model_writes_a_simple_form_and_the_agent_builds_the_internal_block():
    from reference_graphy.questions import normalize_questions, validate_questions

    simple = {"title": "Тест", "questions": [
        {"prompt": "Что выведет print(2+3)?", "type": "single_choice", "options": ["5", "23", "ошибку"], "correct": [1]},
        {"prompt": "Выберите чётные", "type": "multiple_choice", "options": ["2", "3", "4"], "correct": [1, 3]},
        {"prompt": "Объясните цикл for", "type": "free_text"},
        {"prompt": "Какой тип у 3.5?", "type": "single_choice", "options": ["int", "float"], "correct": [2]}]}
    block = normalize_questions(simple)
    validate_questions(block)  # the strict internal validator accepts it unchanged
    first, second, third, fourth = block["questions"]
    assert [q["id"] for q in block["questions"]] == ["q1", "q2", "q3", "q4"] and block["purpose"] == "check"
    assert first["type"] == "single_choice" and first["options"][0] == {"id": "a", "label": "5"}
    assert first["grading"]["correct_option_ids"] == ["a"]
    assert second["type"] == "multiple_choice" and second["grading"]["correct_option_ids"] == ["a", "c"]
    assert third["type"] == "free_text" and "grading" not in third
    assert fourth["grading"]["correct_option_ids"] == ["b"]  # 2 means the second option
    assert normalize_questions(block) == block  # idempotent: an internal block is left alone


async def test_simple_tool_calls_get_ids_flags_and_links_from_the_agent(lesson, tmp_path):
    tools = LearningTools(lesson.path.parent, lesson)

    async def run(name, arguments):
        return await tools.execute({"id": f"{name}-{len(lesson.events)}", "name": name, "arguments": arguments})

    plan = await run("set_learning_plan", {"goal": "Решать квадратные уравнения",
                                           "steps": [{"title": "Что это"}, {"title": "Дискриминант"}]})
    assert not plan.get("error") and [s["id"] for s in lesson.learning.steps] == ["s1", "s2"]
    revised = await run("set_learning_plan", {"steps": [{"title": "Дискриминант"}, {"title": "Виета"}]})
    assert not revised.get("error") and [s["id"] for s in lesson.learning.steps] == ["s2", "s3"]  # kept / fresh
    for step, expected in (("1", "s2"), ("Виета", "s3"), ("s2", "s2")):
        done = await run("set_learning_phase", {"phase": "teaching", "step": step})
        assert not done.get("error") and lesson.learning.current_step == expected, step
    assert lesson.learning.goal == "Решать квадратные уравнения"
    lesson.add({"role": "assistant", "content": "Чему равно 2+2?"})
    lesson.add({"role": "user", "content": "4"})
    ok = await run("record_assessment", {"outcome": "independent", "feedback": "Верно"})
    assert not ok.get("error")
    hinted = await run("record_assessment", {"outcome": "with_hints", "feedback": "С подсказкой"})
    assert not hinted.get("error")
    first, second = lesson.learning.assessments
    assert first["id"] != second["id"] and first["used_hints"] is False and second["used_hints"] is True


def test_the_model_sees_only_simple_parameters_for_lesson_tools(lesson, tmp_path):
    tools = LearningTools(lesson.path.parent, lesson)
    shown = {d["name"]: set(d["parameters"]["properties"]) for d in tools.declarations if "properties" in d["parameters"]}
    assert shown["record_assessment"] == {"items", "ignore_refs"}
    assert shown["set_learning_plan"] == {"goal", "steps"} and shown["set_learning_phase"] == {"phase", "step"}
    assert shown["ask_questions"] == {"title", "questions"}
    assert shown["web_search"] == {"query"} and "find_sources" not in shown and "recommend_sources" not in shown


def test_fallback_question_is_whole_lines_not_a_slice_cut_mid_word(lesson):
    from reference_graphy.context import chat_exchange

    body = "\n".join(f"{n}. уравнение номер {n} со словами для длины строки" for n in range(1, 12))
    lesson.add({"role": "assistant", "content": "Проверь себя: какие квадратные?\n" + body})
    lesson.add({"role": "user", "content": "1 и 3"})
    tail = chat_exchange(lesson)[4]
    assert len(tail) <= 300 and tail.startswith(("5.", "6.", "7.", "8.", "9.", "10.", "11.")) and tail.endswith("длины строки")


def test_load_skill_is_declared_only_when_a_skill_exists(lesson, tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))  # no user-level skills
    tools = LearningTools(tmp_path, lesson)
    assert "load_skill" not in {d["name"] for d in tools.declarations}
    skill = tmp_path / ".agents/skills/my-tutor"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: my-tutor\ndescription: Помогает\n---\nИнструкции")
    assert "load_skill" in {d["name"] for d in LearningTools(tmp_path, lesson).declarations}
