"""Black-box acceptance checks for the real Rust server, independent of Python service classes."""

import asyncio
import json
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]


@asynccontextmanager
async def native_server(tmp_path):
    work = tmp_path / "workspace"
    work.mkdir(exist_ok=True)
    env = os.environ | {"GRAPHY_DIR": str(tmp_path / "data"), "GRAPHY_TOKEN": "rust-http-test",
                        "PYTHONUNBUFFERED": "1"}
    env.pop("GRAPHY_SANDBOX", None)
    command = [os.environ["GRAPHY_TEST_BACKEND"]] if os.environ.get("GRAPHY_TEST_BACKEND") else [
        sys.executable, "-m", "graphy"]
    process = await asyncio.create_subprocess_exec(
        *command, "serve", "--port", "0", "--cwd", str(work),
        "--allow-origin", "http://localhost:5174", "--exit-on-stdin-close",
        cwd=ROOT, env=env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        async with asyncio.timeout(20):
            line = await process.stdout.readline()
        assert line, "Rust server exited before ready"
        ready = json.loads(line)
        assert ready["type"] == "ready" and ready["protocol"] == 1
        async with httpx.AsyncClient(base_url=ready["url"] + "/api/v1", timeout=10) as client:
            yield client
    finally:
        process.stdin.close()
        try:
            await asyncio.wait_for(process.wait(), 10)
        except TimeoutError:
            process.kill()
            await process.wait()
        errors = (await process.stderr.read()).decode()
        assert process.returncode == 0, errors


@pytest.mark.asyncio
async def test_rust_server_guards_and_durable_chat_store(tmp_path):
    headers = {"Authorization": "Bearer rust-http-test", "Origin": "http://localhost:5174"}
    async with native_server(tmp_path) as client:
        health = await client.get("/health")
        assert health.status_code == 200
        assert health.json()["engine"] == "rust", "This test must exercise Rust, never the legacy service"
        assert (await client.get("/settings")).status_code == 401
        assert (await client.get("/settings", headers=headers)).status_code == 200
        assert (await client.get("/settings", headers=headers | {"Origin": "https://evil.invalid"})).status_code == 403
        assert (await client.get("/health", headers={"Host": "evil.invalid"})).status_code == 403
        created = await client.post("/sessions", headers=headers, json={})
        assert created.status_code == 201, created.text
        chat = created.json()
        assert "course_id" not in chat
        renamed = await client.patch(f"/sessions/{chat['id']}", headers=headers, json={"name": "Renamed chat"})
        assert renamed.status_code == 200
        assert renamed.json()["name"] == "Renamed chat"
        assert (await client.get("/courses", headers=headers)).status_code == 404
    async with native_server(tmp_path) as client:
        response = await client.get("/sessions?include_empty=1", headers=headers)
        assert response.status_code == 200
        assert any(row["id"] == chat["id"] and row["name"] == "Renamed chat" for row in response.json()["sessions"])
        deleted = await client.delete(f"/sessions/{chat['id']}", headers=headers)
        assert deleted.status_code == 200
        assert not (await client.get("/sessions?include_empty=1", headers=headers)).json()["sessions"]


@pytest.mark.asyncio
async def test_rust_streams_provider_tokens_before_completion_and_persists_history(tmp_path):
    from aiohttp import web
    from aiohttp.test_utils import TestServer

    finish = asyncio.Event()
    requests = []

    async def provider(request):
        requests.append(await request.json())
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)

        async def frame(delta, reason=None):
            row = {"choices": [{"index": 0, "delta": delta, "finish_reason": reason}]}
            await response.write(("data: " + json.dumps(row) + "\n\n").encode())

        await frame({"content": "Привет"})
        await asyncio.wait_for(finish.wait(), 10)
        await frame({"content": ", мир"})
        await frame({}, "stop")
        await response.write(b"data: [DONE]\n\n")
        return response

    mock = web.Application()
    mock.router.add_post("/v1/chat/completions", provider)
    headers = {"Authorization": "Bearer rust-http-test"}
    async with TestServer(mock) as provider_server:
        data = tmp_path / "data"
        data.mkdir()
        (data / "settings.json").write_text(json.dumps({
            "default_model": "fake/test", "auto_compact": False,
            "providers": {"fake": {"api": "chat", "base_url": str(provider_server.make_url("/v1")),
                                   "models": [{"id": "test", "tools": True, "context": 32768}]}},
        }))
        async with native_server(tmp_path) as client:
            response = await client.post("/sessions", headers=headers, json={"model": "fake/test"})
            assert response.status_code == 201, response.text
            sid = response.json()["id"]
            events = []
            first_delta = asyncio.Event()
            idle = asyncio.Event()
            async with client.stream("GET", "/events?token=rust-http-test") as stream:
                async def pump():
                    async for line in stream.aiter_lines():
                        if line.startswith("data:"):
                            event = json.loads(line[5:].strip())
                            events.append(event)
                            if event["type"] == "text_delta":
                                first_delta.set()
                            if event["type"] == "busy" and event.get("busy") is False:
                                idle.set()

                task = asyncio.create_task(pump())
                try:
                    sent = await client.post(f"/sessions/{sid}/messages", headers=headers, json={"text": "Объясни"})
                    assert sent.status_code == 202, sent.text
                    await asyncio.wait_for(first_delta.wait(), 10)
                    assert not any(e["type"] == "message_end" for e in events)
                    finish.set()
                    await asyncio.wait_for(idle.wait(), 10)
                finally:
                    finish.set()
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
            deltas = [e for e in events if e["type"] == "text_delta"]
            assert [e["delta"] for e in deltas] == ["Привет", ", мир"]
            final = next(e["message"] for e in events if e["type"] == "message_end")
            assert {e["message_id"] for e in deltas} == {final["id"]}
            assert final["content"] == "Привет, мир"
            assert requests[0]["model"] == "test"
            snapshot = (await client.get(f"/sessions/{sid}", headers=headers)).json()
            assert [(m["role"], m["content"]) for m in snapshot["messages"]] == [
                ("user", "Объясни"), ("assistant", "Привет, мир")]
        async with native_server(tmp_path) as client:
            snapshot = (await client.get(f"/sessions/{sid}", headers=headers)).json()
            assert snapshot["messages"][-1]["content"] == "Привет, мир"


@pytest.mark.asyncio
async def test_question_draft_survives_reopen_and_submit(tmp_path):
    from aiohttp import web
    from aiohttp.test_utils import TestServer

    calls = []
    questions = {"title": "Проверка", "questions": [
        {"prompt": "2+2?", "type": "single_choice", "options": ["3", "4"], "correct": [2], "rubric": "SECRET RUBRIC"},
        {"prompt": "Опишите ход", "type": "free_text", "rubric": "SECRET RUBRIC"},
        {"prompt": "Что верно?", "type": "multiple_choice", "options": ["a", "b", "c"], "correct": [1, 3]},
    ]}

    async def provider(request):
        calls.append(await request.json())
        if len(calls) == 1:
            delta = {"tool_calls": [{"index": 0, "id": "q-call", "type": "function", "function": {"name": "ask_questions", "arguments": json.dumps(questions, ensure_ascii=False)}}]}
            reason = "tool_calls"
        else:
            delta, reason = {"content": "Разберём ответы"}, "stop"
        frames = [{"choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                  {"choices": [{"index": 0, "delta": {}, "finish_reason": reason}]}]
        return web.Response(body=("".join("data: " + json.dumps(x, ensure_ascii=False) + "\n\n" for x in frames) + "data: [DONE]\n\n").encode(), content_type="text/event-stream")

    mock = web.Application()
    mock.router.add_post("/v1/chat/completions", provider)
    headers = {"Authorization": "Bearer rust-http-test"}
    async with TestServer(mock) as server:
        data = tmp_path / "data"
        data.mkdir()
        (data / "settings.json").write_text(json.dumps({"default_model": "fake/test", "auto_compact": False,
            "providers": {"fake": {"api": "chat", "base_url": str(server.make_url("/v1")),
                                   "models": [{"id": "test", "tools": True, "context": 32768}]}}}))
        async with native_server(tmp_path) as client:
            created = await client.post("/sessions", headers=headers, json={"model": "fake/test"})
            sid = created.json()["id"]
            assert (await client.post(f"/sessions/{sid}/messages", headers=headers, json={"text": "Дай тест"})).status_code == 202
            async with asyncio.timeout(10):
                while True:
                    snapshot = (await client.get(f"/sessions/{sid}", headers=headers)).json()
                    if snapshot.get("question") and not snapshot["busy"]:
                        break
                    await asyncio.sleep(.02)
            assert "SECRET RUBRIC" not in json.dumps(snapshot, ensure_ascii=False)
            ids = [q["id"] for q in snapshot["question"]["questions"]]
            answers = [{"question_id": ids[0], "status": "answered", "selected_option_ids": ["b"], "text": "", "reasoning": ""},
                       {"question_id": ids[1], "status": "answered", "selected_option_ids": [], "text": "складываю", "reasoning": ""},
                       {"question_id": ids[2], "status": "dont_know", "selected_option_ids": [], "text": "", "reasoning": ""}]
            draft = await client.put(f"/sessions/{sid}/questions/q-call/draft", headers=headers, json={"answers": answers, "step": 1})
            assert draft.status_code == 200, draft.text
        async with native_server(tmp_path) as client:
            snapshot = (await client.get(f"/sessions/{sid}", headers=headers)).json()
            assert snapshot["question"]["step"] == 1
            assert snapshot["question"]["answers"][0]["selected_option_ids"] == ["b"]
            sent = await client.post(f"/sessions/{sid}/questions/q-call/submit", headers=headers, json={"answers": answers})
            assert sent.status_code == 202, sent.text
            async with asyncio.timeout(10):
                while True:
                    snapshot = (await client.get(f"/sessions/{sid}", headers=headers)).json()
                    if not snapshot["busy"]:
                        break
                    await asyncio.sleep(.02)
            assert snapshot["question"] is None
            assert snapshot["resolved_questions"]["q-call"]["status"] == "submitted"
            assert snapshot["messages"][-1]["content"] == "Разберём ответы"
            assert "SECRET RUBRIC" not in json.dumps(snapshot, ensure_ascii=False)
            assert any("key_verdict" in json.dumps(call, ensure_ascii=False) for call in calls[1:]), calls


@pytest.mark.asyncio
async def test_aborted_provider_stream_persists_partial_response(tmp_path):
    from aiohttp import web
    from aiohttp.test_utils import TestServer

    released = asyncio.Event()
    async def provider(request):
        await request.json()
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)
        await response.write(b'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n')
        await released.wait()
        return response

    mock = web.Application()
    mock.router.add_post("/v1/chat/completions", provider)
    headers = {"Authorization": "Bearer rust-http-test"}
    async with TestServer(mock) as server:
        data = tmp_path / "data"
        data.mkdir()
        (data / "settings.json").write_text(json.dumps({"default_model": "fake/test", "auto_compact": False,
            "providers": {"fake": {"api": "chat", "base_url": str(server.make_url("/v1")),
                                   "models": [{"id": "test", "tools": True, "context": 32768}]}}}))
        try:
            async with native_server(tmp_path) as client:
                sid = (await client.post("/sessions", headers=headers, json={"model": "fake/test"})).json()["id"]
                async with client.stream("GET", "/events?token=rust-http-test") as stream:
                    async def wait_delta():
                        async for line in stream.aiter_lines():
                            if line.startswith("data:") and json.loads(line[5:]).get("type") == "text_delta":
                                return
                    task = asyncio.create_task(wait_delta())
                    assert (await client.post(f"/sessions/{sid}/messages", headers=headers, json={"text": "Hello"})).status_code == 202
                    await asyncio.wait_for(task, 10)
                    abort = await client.post(f"/sessions/{sid}/abort", headers=headers)
                    assert abort.json()["aborted"] is True
                async with asyncio.timeout(10):
                    while True:
                        snapshot = (await client.get(f"/sessions/{sid}", headers=headers)).json()
                        if not snapshot["busy"]:
                            break
                        await asyncio.sleep(.02)
                assert snapshot["messages"][-1]["content"] == "partial"
                assert snapshot["messages"][-1]["stop"] == "aborted"
            async with native_server(tmp_path) as client:
                snapshot = (await client.get(f"/sessions/{sid}", headers=headers)).json()
                assert snapshot["messages"][-1]["content"] == "partial"
                assert snapshot["messages"][-1]["stop"] == "aborted"
        finally:
            released.set()



@pytest.mark.asyncio
async def test_aborting_running_bash_kills_descendant_side_effect(tmp_path):
    from aiohttp import web
    from aiohttp.test_utils import TestServer

    async def provider(request):
        await request.json()
        call = {"index": 0, "id": "shell", "type": "function", "function": {"name": "bash", "arguments": json.dumps({"command": "echo first; touch started; (sleep 1; touch forbidden) & wait"})}}
        frames = [{"choices": [{"index": 0, "delta": {"tool_calls": [call]}, "finish_reason": None}]},
                  {"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]}]
        return web.Response(body=("".join("data: " + json.dumps(x) + "\n\n" for x in frames) + "data: [DONE]\n\n").encode(), content_type="text/event-stream")
    mock = web.Application()
    mock.router.add_post("/v1/chat/completions", provider)
    headers = {"Authorization": "Bearer rust-http-test"}
    async with TestServer(mock) as server:
        data = tmp_path / "data"
        data.mkdir()
        (data / "settings.json").write_text(json.dumps({"default_model": "fake/test", "auto_compact": False,
            "providers": {"fake": {"api": "chat", "base_url": str(server.make_url("/v1")),
                                   "models": [{"id": "test", "tools": True, "context": 32768}]}}}))
        async with native_server(tmp_path) as client:
            sid = (await client.post("/sessions", headers=headers, json={"model": "fake/test"})).json()["id"]
            async with client.stream("GET", "/events?token=rust-http-test") as stream:
                async def wait_progress():
                    async for line in stream.aiter_lines():
                        if line.startswith("data:"):
                            event = json.loads(line[5:])
                            if event.get("type") == "tool_update":
                                return event
                task = asyncio.create_task(wait_progress())
                assert (await client.post(f"/sessions/{sid}/messages", headers=headers, json={"text": "Run it"})).status_code == 202
                progress = await asyncio.wait_for(task, 10)
                assert progress["call_id"] == "shell" and "first" in progress["text"]
                assert (await client.post(f"/sessions/{sid}/abort", headers=headers)).json()["aborted"]
            async with asyncio.timeout(10):
                while True:
                    snapshot = (await client.get(f"/sessions/{sid}", headers=headers)).json()
                    if not snapshot["busy"]:
                        break
                    await asyncio.sleep(.02)
            result = next(m for m in snapshot["messages"] if m.get("call_id") == "shell")
            assert result["error"] is True
            assert "Interrupted" in result["content"]
            await asyncio.sleep(1.2)
            assert not (tmp_path / "workspace" / "forbidden").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["close", "delete"])
async def test_pending_title_does_not_hold_or_recreate_session(tmp_path, operation):
    from aiohttp import web
    from aiohttp.test_utils import TestServer

    title_started = asyncio.Event()
    release_title = asyncio.Event()
    async def provider(request):
        body = await request.json()
        is_title = "Name this learning session" in str(body.get("messages", []))
        if is_title:
            title_started.set()
            await release_title.wait()
        delta = {"content": "Title" if is_title else "Answer"}
        frames = [{"choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                  {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                   "usage": {"prompt_tokens": 1, "completion_tokens": 1}}]
        return web.Response(body=("".join("data: " + json.dumps(x) + "\n\n" for x in frames) + "data: [DONE]\n\n").encode(), content_type="text/event-stream")
    mock = web.Application()
    mock.router.add_post("/v1/chat/completions", provider)
    headers = {"Authorization": "Bearer rust-http-test"}
    async with TestServer(mock) as server:
        data = tmp_path / "data"
        data.mkdir()
        (data / "settings.json").write_text(json.dumps({"default_model": "fake/test", "auto_compact": False,
            "providers": {"fake": {"api": "chat", "base_url": str(server.make_url("/v1")),
                                   "models": [{"id": "test", "tools": True, "context": 32768}]}}}))
        try:
            async with native_server(tmp_path) as client:
                sid = (await client.post("/sessions", headers=headers, json={"model": "fake/test"})).json()["id"]
                assert (await client.post(f"/sessions/{sid}/messages", headers=headers, json={"text": "Hello"})).status_code == 202
                await asyncio.wait_for(title_started.wait(), 10)
                journal = next(data.rglob(f"{sid}.jsonl"))
                if operation == "close":
                    response = await client.post(f"/sessions/{sid}/close", headers=headers)
                    assert response.status_code == 200, response.text
                    reopened = await client.get(f"/sessions/{sid}", headers=headers)
                    assert reopened.status_code == 200, reopened.text
                    before = journal.read_bytes()
                else:
                    response = await client.delete(f"/sessions/{sid}", headers=headers)
                    assert response.status_code == 200, response.text
                    assert not journal.exists()
                release_title.set()
                await asyncio.sleep(.2)
                if operation == "close":
                    assert journal.read_bytes() == before
                else:
                    assert not journal.exists()
        finally:
            release_title.set()


@pytest.mark.asyncio
async def test_message_during_manual_compaction_is_rejected(tmp_path):
    from aiohttp import web
    from aiohttp.test_utils import TestServer

    compact_started, release_compact = asyncio.Event(), asyncio.Event()
    async def provider(request):
        body = await request.json()
        if "Summarize the conversation data" in str(body.get("messages", [])):
            compact_started.set()
            await release_compact.wait()
        frames = [{"choices": [{"index": 0, "delta": {"content": "Response"}, "finish_reason": None}]},
                  {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}]
        return web.Response(body=("".join("data: " + json.dumps(x) + "\n\n" for x in frames) + "data: [DONE]\n\n").encode(), content_type="text/event-stream")
    mock = web.Application()
    mock.router.add_post("/v1/chat/completions", provider)
    headers = {"Authorization": "Bearer rust-http-test"}
    async with TestServer(mock) as server:
        data = tmp_path / "data"
        data.mkdir()
        (data / "settings.json").write_text(json.dumps({"default_model": "fake/test", "auto_compact": False,
            "providers": {"fake": {"api": "chat", "base_url": str(server.make_url("/v1")),
                                   "models": [{"id": "test", "tools": True, "context": 32768}]}}}))
        try:
            async with native_server(tmp_path) as client:
                sid = (await client.post("/sessions", headers=headers, json={"model": "fake/test"})).json()["id"]
                for n in range(2):
                    sent = await client.post(f"/sessions/{sid}/messages", headers=headers, json={"text": f"{n} " + "x" * 40000})
                    assert sent.status_code == 202, sent.text
                    async with asyncio.timeout(10):
                        while True:
                            snapshot = (await client.get(f"/sessions/{sid}", headers=headers)).json()
                            if not snapshot["busy"]:
                                break
                            await asyncio.sleep(.02)
                compact = await client.post(f"/sessions/{sid}/compact", headers=headers, json={})
                assert compact.status_code == 202, compact.text
                await asyncio.wait_for(compact_started.wait(), 10)
                rejected = await client.post(f"/sessions/{sid}/messages", headers=headers, json={"text": "keep this"})
                assert rejected.status_code == 409, rejected.text
                release_compact.set()
        finally:
            release_compact.set()


@pytest.mark.asyncio
async def test_startup_migration_and_disabled_capabilities(tmp_path):
    from aiohttp import web
    from aiohttp.test_utils import TestServer

    requests = []
    async def provider(request):
        requests.append(await request.json())
        return web.Response(status=500)
    mock = web.Application()
    mock.router.add_post("/v1/chat/completions", provider)
    headers = {"Authorization": "Bearer rust-http-test"}
    async with TestServer(mock) as server:
        data = tmp_path / "data"
        legacy = data / "sessions" / "legacy"
        legacy.mkdir(parents=True)
        old = legacy / "old.jsonl"
        old.write_text(json.dumps({"type": "header", "version": 1}) + "\n")
        (data / "settings.json").write_text(json.dumps({"default_model": "fake/test", "skills_enabled": False,
            "providers": {"fake": {"api": "chat", "base_url": str(server.make_url("/v1")),
                                   "models": [{"id": "test", "tools": False, "context": 32768}]}}}))
        async with native_server(tmp_path) as client:
            assert not old.exists()
            sid = (await client.post("/sessions", headers=headers, json={"model": "fake/test"})).json()["id"]
            skill = await client.post(f"/sessions/{sid}/skill", headers=headers, json={"name": "anything"})
            assert skill.status_code == 400 and "Skills" in skill.text
            sent = await client.post(f"/sessions/{sid}/messages", headers=headers, json={"text": "Hello"})
            assert sent.status_code == 202
            async with asyncio.timeout(10):
                while True:
                    snapshot = (await client.get(f"/sessions/{sid}", headers=headers)).json()
                    if not snapshot["busy"]:
                        break
                    await asyncio.sleep(.02)
            assert not snapshot["messages"] and not requests
