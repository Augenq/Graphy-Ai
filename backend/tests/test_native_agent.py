"""Exercise real Rust decisions through the Python binding and async adapter."""

import pytest
from reference_graphy import agent as agent_module
from test_agent import FakeProvider, answer, make_agent, tool

from graphy.native import invoke


def test_native_preflight_snapshot_tracks_calls_across_ids_and_argument_order():
    snapshot = {"learning": [1, "practice", "step-1", 0, False], "call_repeats": {}}
    for identifier, arguments in [("a", {"path": "note", "offset": 1}),
                                  ("b", {"offset": 1, "path": "note"}),
                                  ("c", {"path": "note", "offset": 1})]:
        result = invoke("agent.tool_preflight", {
            **snapshot, "call": tool(identifier, "read", **arguments),
        })
        snapshot["call_repeats"] = result["call_repeats"]
        assert (result["result"] is None) == (identifier != "c")
    assert "Repeated identical operation" in result["result"]["content"]
    snapshot["learning"][3] = 1  # recorded evidence makes repeating the action meaningful
    result = invoke("agent.tool_preflight", {**snapshot, "call": tool("d", "read", path="note", offset=1)})
    assert result["result"] is None


def test_native_dependency_guard_only_blocks_lesson_mutations():
    for public, name in [(True, "set_learning_phase"), (False, "read")]:
        result = invoke("agent.tool_preflight", {
            "call": tool("a", name), "blocked": "record_assessment", "public": public,
        })
        if public:
            assert result["result"]["error"]
            assert "record_assessment" in result["result"]["content"]
        else:
            assert result["result"] is None


@pytest.mark.parametrize("streamed,displayed", [(True, False), (False, True)])
def test_native_retry_refuses_to_replay_any_visible_stream(streamed, displayed):
    decision = invoke("agent.retry", {
        "attempt": 0, "retries": 3, "retryable": True, "retry_after": 0,
        "streamed": streamed, "displayed": displayed,
    })
    assert decision["retry"] is False


async def test_async_agent_consults_native_decisions_through_completion(session, tmp_path, monkeypatch):
    """Real tool execution and persisted results pass through native policy at every turn."""
    (tmp_path / "note").write_text("payload")
    operations = []
    real_invoke = agent_module.invoke

    def observe(operation, data):
        operations.append(operation)
        return real_invoke(operation, data)

    monkeypatch.setattr(agent_module, "invoke", observe)
    provider = FakeProvider(answer(calls=[tool("read", "read", path="note")]), answer("done"))
    agent, events = make_agent(session, provider)
    await agent.run({"role": "user", "content": "read the note"})
    assert session.messages[-1]["content"] == "done"
    assert next(m for m in session.messages if m["role"] == "tool")["content"] == "payload"
    assert operations.count("agent.response_action") == 2
    assert "agent.tool_preflight" in operations and "agent.batch_outcome" in operations
    assert events[-1] == {"type": "status", "text": ""}


async def test_native_policy_rejection_prevents_tool_side_effects(session, tmp_path, monkeypatch):
    """The adapter executes the returned decision rather than reproducing a Python guard."""
    real_invoke = agent_module.invoke

    def reject(operation, data):
        result = real_invoke(operation, data)
        if operation == "agent.tool_preflight":
            result["result"] = {"content": "Core denied this operation", "error": True}
        return result

    monkeypatch.setattr(agent_module, "invoke", reject)
    provider = FakeProvider(
        answer(calls=[tool("write", "write", path="denied", content="never")]), answer("explained"),
    )
    agent, _ = make_agent(session, provider)
    await agent.run({"role": "user", "content": "write a note"})
    assert not (tmp_path / "denied").exists()
    assert next(m for m in session.messages if m["role"] == "tool")["content"] == "Core denied this operation"
