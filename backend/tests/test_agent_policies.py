"""Agent loop guards (retries, overflow, repeated failures) and the rules that decide when to quiz."""

import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest
from reference_graphy.agent import NO_QUESTIONS, learner_declined_questions
from test_agent import FakeProvider, RetryableError, answer, make_agent, tool


class Overflow(Exception):
    status = 413


class Fatal(Exception):
    pass


async def test_non_retryable_provider_error_is_raised_at_once(session):
    async def fail(_messages, _emit):
        raise Fatal("invalid api key")

    provider = FakeProvider(fail, answer("never reached"))
    agent, events = make_agent(session, provider)
    with pytest.raises(Fatal):
        await agent.run({"role": "user", "content": "hi"})
    assert len(provider.requests) == 1
    assert not any(e.get("text", "").startswith("Retry") for e in events)
    assert events[-1] == {"type": "status", "text": ""}  # the busy indicator is always cleared


async def test_retries_are_bounded_and_the_last_error_surfaces(session):
    async def fail(_messages, _emit):
        raise RetryableError("still down")

    provider = FakeProvider(fail, fail, fail)
    agent, events = make_agent(session, provider, settings={"retries": 2})
    with pytest.raises(RetryableError):
        await agent.run({"role": "user", "content": "hi"})
    assert len(provider.requests) == 3
    assert [e["text"][:7] for e in events if e.get("text", "").startswith("Retry")] == ["Retry 1", "Retry 2"]


async def test_retry_waits_for_retry_after_but_never_longer_than_a_minute(session, monkeypatch):
    delays = []

    async def sleep(seconds):
        delays.append(seconds)

    monkeypatch.setattr(asyncio, "sleep", sleep)

    def rate_limited(retry_after):
        async def fail(_messages, _emit):
            error = RetryableError("429")
            error.retry_after = retry_after
            raise error

        return fail

    provider = FakeProvider(rate_limited(7), rate_limited(3600), rate_limited(None), answer("ok"))
    agent, _ = make_agent(session, provider, settings={"retries": 3})
    await agent.run({"role": "user", "content": "hi"})
    assert delays == [7, 60, 4]  # server hint; capped; exponential backoff (2**attempt) without a hint


async def test_httpx_network_errors_are_retried_without_a_retryable_flag(session, monkeypatch):
    async def instant(_seconds):
        pass

    monkeypatch.setattr(asyncio, "sleep", instant)

    async def down(_messages, _emit):
        raise httpx.ConnectError("refused")

    provider = FakeProvider(down, answer("back"))
    agent, _ = make_agent(session, provider)
    await agent.run({"role": "user", "content": "hi"})
    assert session.messages[-1]["content"] == "back"


SMALL_WINDOW = {"id": "test", "context": 400}  # compaction keeps a quarter of it: two long messages


def long_history(session):
    for number, role in enumerate(("user", "assistant", "user", "assistant")):
        session.add({"role": role, "content": f"{number} " + "word " * 40})


async def test_context_overflow_compacts_once_and_retries_the_same_turn(session):
    long_history(session)

    async def overflow(_messages, _emit):
        raise Overflow("prompt is too long")

    summary_request = answer("Summary of the first exchange")
    provider = FakeProvider(overflow, summary_request, answer("Continuing"))
    agent, _ = make_agent(session, provider, settings={"auto_compact": False})
    agent.model = SMALL_WINDOW
    await agent.run({"role": "user", "content": "third goal"})
    assert session.summary == "Summary of the first exchange" and session.boundary > 0
    assert session.messages[-1]["content"] == "Continuing"
    assert len(provider.requests) == 3


async def test_second_consecutive_overflow_is_not_compacted_again(session):
    long_history(session)

    async def overflow(_messages, _emit):
        raise Overflow("too many tokens")

    provider = FakeProvider(overflow, answer("summary"), overflow)
    agent, _ = make_agent(session, provider, settings={"auto_compact": False})
    agent.model = SMALL_WINDOW
    with pytest.raises(Overflow):
        await agent.run({"role": "user", "content": "e"})
    assert len(provider.requests) == 3  # request, one compaction, request; no loop


async def test_repeated_identical_tool_call_is_refused_instead_of_looping(session, tmp_path):
    (tmp_path / "f.txt").write_text("data")
    same = lambda n: answer(calls=[tool(f"c{n}", "read", path="f.txt")])  # noqa: E731
    provider = FakeProvider(same(1), same(2), same(3), answer("explained"))
    agent, _ = make_agent(session, provider)
    await agent.run({"role": "user", "content": "read it"})
    results = [m for m in session.messages if m["role"] == "tool"]
    assert [bool(m.get("error")) for m in results] == [False, False, True]
    assert "Repeated identical operation" in results[2]["content"]


async def test_three_failing_tool_batches_in_a_row_end_the_turn_with_a_notice(session):
    failing = lambda n: answer(calls=[tool(f"c{n}", "read", path=f"missing{n}.txt")])  # noqa: E731
    provider = FakeProvider(failing(1), failing(2), failing(3), answer("must not be requested"))
    agent, events = make_agent(session, provider)
    await agent.run({"role": "user", "content": "go"})
    assert len(provider.requests) == 3
    notices = [e for e in events if e["type"] == "notice"]
    assert len(notices) == 1 and notices[0]["error"] and "Повторяющаяся ошибка" in notices[0]["text"]
    assert all(m["call_id"] for m in session.messages if m["role"] == "tool")  # every call has its result


async def test_a_successful_tool_resets_the_failure_counter(session, tmp_path):
    (tmp_path / "ok.txt").write_text("fine")
    provider = FakeProvider(
        answer(calls=[tool("c1", "read", path="a")]), answer(calls=[tool("c2", "read", path="b")]),
        answer(calls=[tool("c3", "read", path="ok.txt")]),
        answer(calls=[tool("c4", "read", path="c")]), answer(calls=[tool("c5", "read", path="d")]),
        answer("done"))
    agent, events = make_agent(session, provider)
    await agent.run({"role": "user", "content": "go"})
    assert session.messages[-1]["content"] == "done"
    assert not [e for e in events if e["type"] == "notice"]


async def test_one_failed_call_does_not_prevent_the_remaining_independent_calls(session, tmp_path):
    (tmp_path / "ok.txt").write_text("fine")
    provider = FakeProvider(
        answer(calls=[tool("bad", "read", path="missing"), tool("good", "read", path="ok.txt")]),
        answer("both handled"))
    agent, _ = make_agent(session, provider)
    await agent.run({"role": "user", "content": "go"})
    results = {m["call_id"]: m for m in session.messages if m["role"] == "tool"}
    assert results["bad"]["error"] and "fine" in results["good"]["content"]


async def test_empty_stop_after_all_retries_is_reported_to_the_learner(session):
    empty = answer("")
    provider = FakeProvider(empty, empty, empty, empty)
    agent, _ = make_agent(session, provider, settings={"retries": 3})
    with pytest.raises(ValueError, match="пустой ответ"):
        await agent.run({"role": "user", "content": "hi"})
    assert len(provider.requests) == 4
    assert session.context[-1]["content"] == "hi"  # the empty reply never reaches the next request


async def test_run_refuses_to_start_while_a_question_block_is_open(session):
    session.pending_question = {"batch_id": "q"}
    agent, _ = make_agent(session, FakeProvider())
    with pytest.raises(ValueError, match="open question"):
        await agent.run({"role": "user", "content": "hi"})


def test_queue_and_restore_return_unsent_messages_in_order(session):
    agent, _ = make_agent(session, FakeProvider())
    agent.queue({"role": "user", "content": "steer"})
    agent.queue({"role": "user", "content": "later"}, followup=True)
    assert agent.restore() == "steer\n\nlater"
    assert agent.restore() == ""


# --- when is the learner "declining" tests? ---------------------------------------------------------------------

def declined(*messages):
    return learner_declined_questions(SimpleNamespace(messages=list(messages)))


def user(text):
    return {"role": "user", "content": text}


@pytest.mark.parametrize(
    "text",
    [
        "Объясни без формул",
        "объясни это без сложных формул",
        "Не надо формул, пожалуйста",
        "хочу формально, без формальностей",
        "У меня вопрос про формулу площади",
        "Что такое информация?",
        "Проверь мои формулы",
    ],
)
def test_talking_about_formulas_is_not_a_refusal_of_tests(text):
    assert not NO_QUESTIONS.search(text), text
    assert not declined(user(text))


@pytest.mark.parametrize(
    "text",
    [
        "без вопросов",
        "Объясни без тестов",
        "давай без этих проверок",
        "не надо вопросов",
        "не хочу тест",
        "Не надо форму, просто объясни",
        "без формы",
        "No questions please",
        "stop asking",
    ],
)
def test_real_refusals_are_still_recognized(text):
    assert NO_QUESTIONS.search(text), text
    assert declined(user(text))


def test_a_formula_request_does_not_cancel_an_earlier_refusal_but_a_test_request_does():
    assert declined(user("без вопросов"), user("объясни формулу площади круга"))
    assert not declined(user("без вопросов"), user("давай тест по формулам"))
    assert not declined(user("без вопросов"), user("открой форму"))
    assert not declined(user("не надо тестов"), user("quiz me"))


def test_cancelled_form_counts_only_when_the_payload_says_so():
    def form(content):
        return {"role": "tool", "name": "ask_questions", "content": content}

    assert declined(user("go"), form(json.dumps({"status": "cancelled"})))
    assert not declined(user("go"), form(json.dumps({"status": "submitted"})))
    assert not declined(user("go"), form("Not executed: NO questions were displayed."))
    assert not declined(user("go"), form("not json at all"))
    assert not declined()
