import asyncio
import copy
from collections import deque
from pathlib import Path

import pytest
from reference_graphy.agent import Agent
from reference_graphy.context import compact, estimate, split_history
from reference_graphy.session import Session
from reference_graphy.tools import Tools

MODEL = {"id": "test", "context": 128000}


def answer(content="", calls=None, stop="stop"):
    return {"role": "assistant", "content": content, "calls": calls or [], "stop": stop}


def tool(identifier, name, **arguments):
    return {"id": identifier, "name": name, "arguments": arguments}


class FakeProvider:
    def __init__(self, *actions):
        self.actions, self.requests = deque(actions), []

    async def stream(self, model, messages, system, tools, thinking, session_id, emit):
        self.requests.append(copy.deepcopy(messages))
        assert self.actions, "Unexpected extra model request"
        action = self.actions.popleft()
        return await action(messages, emit) if callable(action) else copy.deepcopy(action)


def make_agent(session, provider, tools=None, settings=None):
    events = []

    async def emit(event):
        events.append(copy.deepcopy(event))

    tools = tools or Tools(Path(session.cwd))
    if not hasattr(tools, "cwd"):
        tools.cwd = Path(session.cwd)
    agent = Agent(session, tools, provider, MODEL, emit, settings)
    return agent, events


async def test_real_tools_complete_multiturn_task_and_persist(session, tmp_path):
    provider = FakeProvider(
        answer(calls=[tool("write", "bash", command="printf hello > note")]),
        answer(calls=[tool("read", "read", path="note")]),
        answer("Verified hello"),
    )
    agent, events = make_agent(session, provider)
    await agent.run({"role": "user", "content": "Write and read a note"})
    assert (tmp_path / "note").read_text() == "hello"
    assert [m["role"] for m in session.messages] == [
        "user",
        "assistant",
        "tool",
        "assistant",
        "tool",
        "assistant",
    ]
    assert provider.requests[2][-1]["content"] == "hello"
    assert len([e for e in events if e["type"] == "tool_end"]) == 2
    path = session.path
    session.close()
    restored = Session(tmp_path / "state", tmp_path, path)
    try:
        assert restored.messages[-1]["content"] == "Verified hello"
    finally:
        restored.close()


async def test_single_long_task_can_compact_without_splitting_tool_batch(session):
    session.add({"role": "user", "content": "one coding task"})
    for index in range(6):
        session.add(answer(calls=[tool(f"call_{index}", "read", path="file")]))
        session.add({"role": "tool", "call_id": f"call_{index}", "name": "read", "content": "x" * 4000})
    await compact(session, FakeProvider(answer("Keep working on the same task")), MODEL, keep=1500)
    assert session.boundary > 0
    assert session.context[1]["role"] == "assistant"
    retained_calls = {c["id"] for m in session.context for c in m.get("calls", [])}
    retained_results = {m["call_id"] for m in session.context if m["role"] == "tool"}
    assert retained_calls == retained_results


def test_image_estimate_does_not_treat_base64_as_text_tokens():
    message = {
        "role": "user",
        "content": "Inspect image",
        "images": [{"data": "x" * 1_000_000, "mime": "image/png"}],
    }
    assert 1000 < estimate([message]) < 5000


async def test_document_tools_execute_in_source_order(session):
    calls = []
    class OrderedTools:
        cwd = Path(session.cwd)
        declarations = []
        async def execute(self, call, update):
            calls.append(call["id"])
            return {"content": call["id"]}
    provider = FakeProvider(answer(calls=[tool("one", "read"), tool("two", "read")]), answer("done"))
    agent, events = make_agent(session, provider, OrderedTools())
    await agent.run({"role": "user", "content": "read both"})
    assert calls == ["one", "two"]
    assert [m["call_id"] for m in provider.requests[1] if m["role"] == "tool"] == ["one", "two"]


async def test_steering_precedes_next_request_followup_waits_for_finish(session):
    async def initial(_messages, _emit):
        agent.queue({"role": "user", "content": "steer"})
        agent.queue({"role": "user", "content": "follow"}, followup=True)
        return answer(calls=[tool("list", "ls")])

    provider = FakeProvider(initial, answer("first task done"), answer("follow done"))
    agent, _ = make_agent(session, provider)
    await agent.run({"role": "user", "content": "original"})
    assert provider.requests[1][-1]["content"] == "steer"
    assert not any(m.get("content") == "follow" for m in provider.requests[1])
    assert provider.requests[2][-1]["content"] == "follow"
    assert not agent.steering and not agent.followups


@pytest.mark.parametrize("mode", ["parallel", "sequential"])
async def test_cancelled_tools_have_durable_results_and_restore_queued_input(session, tmp_path, mode):
    started = asyncio.Event()

    class BlockingTools:
        declarations = []

        async def execute(self, call, update):
            started.set()
            await asyncio.Event().wait()

    provider = FakeProvider(answer(calls=[tool("one", "bash"), tool("two", "bash")]))
    agent, _ = make_agent(session, provider, BlockingTools(), {"tool_execution": mode})
    task = asyncio.create_task(agent.run({"role": "user", "content": "work"}))
    await asyncio.wait_for(started.wait(), 2)
    agent.queue({"role": "user", "content": "steer"})
    agent.queue({"role": "user", "content": "later"}, followup=True)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    results = [m for m in session.messages if m["role"] == "tool"]
    assert [m["call_id"] for m in results] == ["one", "two"]
    assert all(m["error"] for m in results)
    assert agent.restore() == "steer\n\nlater" and agent.restore() == ""
    count, path = len(session.messages), session.path
    session.close()
    restored = Session(tmp_path / "state", tmp_path, path)
    try:
        assert len(restored.messages) == count
        assert len(provider.requests) == 1
    finally:
        restored.close()


class RetryableError(Exception):
    retryable = True
    retry_after = 0


async def test_retry_before_response_never_duplicates_tool_side_effects(session, tmp_path):
    async def fail(_messages, _emit):
        raise RetryableError("temporary")

    command = "printf x >> counter"
    provider = FakeProvider(fail, answer(calls=[tool("append", "bash", command=command)]), answer("done"))
    agent, events = make_agent(session, provider)
    await agent.run({"role": "user", "content": "append once"})
    assert (tmp_path / "counter").read_text() == "x"
    assert len(provider.requests) == 3
    assert len([m for m in session.messages if m["role"] == "assistant"]) == 2
    assert any(e.get("text", "").startswith("Retry 1/") for e in events)


async def test_partial_stream_failure_is_preserved_and_never_retried(session):
    async def fail(_messages, emit):
        await emit({"type": "text_delta", "delta": "partial answer"})
        raise RetryableError("lost stream")

    provider = FakeProvider(fail, answer("must never run"))
    agent, _ = make_agent(session, provider)
    with pytest.raises(RetryableError):
        await agent.run({"role": "user", "content": "work"})
    assert len(provider.requests) == 1
    assert session.messages[-1]["content"] == "partial answer"
    assert session.messages[-1]["stop"] == "error" and not session.messages[-1]["calls"]


async def test_truncated_tool_arguments_are_never_executed(session, tmp_path):
    provider = FakeProvider(
        answer(calls=[tool("write", "write", path="must-not-exist", content="partial")], stop="length"),
        answer("Need complete arguments"),
    )
    agent, _ = make_agent(session, provider)
    await agent.run({"role": "user", "content": "work"})
    assert not (tmp_path / "must-not-exist").exists()
    assert session.messages[2]["error"] and "Not executed" in session.messages[2]["content"]


@pytest.mark.parametrize("failure", ["exception", "length", "empty"])
async def test_failed_compaction_keeps_durable_context_unchanged(session, failure):
    session.add({"role": "user", "content": "old goal"})
    session.add(answer("old answer"))
    session.add({"role": "user", "content": "new goal"})

    async def fail(_messages, _emit):
        if failure == "exception":
            raise RuntimeError("offline")
        return answer(
            "unfinished" if failure == "length" else "", stop="length" if failure == "length" else "stop"
        )

    before = session.path.read_bytes()
    with pytest.raises((RuntimeError, ValueError)):
        await compact(session, FakeProvider(fail), MODEL, keep=1)
    assert session.path.read_bytes() == before
    assert session.boundary == 0 and session.summary == ""


async def test_compaction_preserves_tool_transaction_and_survives_resume(session, tmp_path):
    session.add({"role": "user", "content": "old goal"})
    session.add(answer(calls=[tool("read", "read", path="file")]))
    session.add({"role": "tool", "call_id": "read", "name": "read", "content": "file data"})
    session.add(answer("old answer"))
    session.add({"role": "user", "content": "recent goal"})
    assert split_history(session.messages, 1) == 4
    provider = FakeProvider(answer("Goal and decisions"))
    await compact(session, provider, MODEL, keep=1)
    assert session.boundary == 4 and len(session.messages) == 5
    assert "file data" in provider.requests[0][0]["content"]
    path = session.path
    session.close()
    restored = Session(tmp_path / "state", tmp_path, path)
    try:
        assert restored.summary == "Goal and decisions"
        assert [m["content"] for m in restored.context] == [
            "Earlier conversation summary:\nGoal and decisions",
            "recent goal",
        ]
    finally:
        restored.close()
