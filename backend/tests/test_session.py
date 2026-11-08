import json
import os

import pytest
from reference_graphy.session import Session
from reference_graphy.storage import Store, read_json, write_json


def test_resume_restores_history_model_usage_and_compaction(tmp_path):
    session = Session(tmp_path / "state", tmp_path)
    session.select("openai/test", "high")
    session.append("name", name="A named chat")
    session.add({"role": "user", "content": "first"})
    session.add({"role": "assistant", "content": "answer"})
    session.append("usage", usage={"input": 15, "output": 8, "cost": 0.2})
    session.append("usage", usage={"input": 5, "cache_read": 3})
    session.append("compact", summary="old turns", boundary=2)
    session.add({"role": "user", "content": "new question"})
    path, identity = session.path, session.id
    session.close()
    resumed = Session(tmp_path / "state", tmp_path, path)
    try:
        assert (resumed.id, resumed.model, resumed.thinking, resumed.name) == (
            identity,
            "openai/test",
            "high",
            "A named chat",
        )
        assert len(resumed.messages) == 3
        assert [m["content"] for m in resumed.context] == [
            "Earlier conversation summary:\nold turns",
            "new question",
        ]
        assert resumed.usage() == {
            "input": 20,
            "output": 8,
            "cache_read": 3,
            "cache_write": 0,
            "cost": 0.2,
            "unknown_cost": True,
        }
    finally:
        resumed.close()


def test_writer_lock_and_independent_chats(tmp_path):
    root = tmp_path / "state"
    first, second = Session(root, tmp_path), Session(root, tmp_path)
    try:
        first.add({"role": "user", "content": "private first"})
        second.add({"role": "user", "content": "private second"})
        with pytest.raises(ValueError, match="another process"):
            Session(root, tmp_path, first.path)
        assert first.path != second.path and first.id != second.id
        assert "private second" not in first.path.read_text()
        assert "private first" not in second.path.read_text()
        assert len(Session.list(root, tmp_path)) == 2
        with pytest.raises(ValueError, match="working directory"):
            Session(root, tmp_path / "other", first.path, course_id="a" * 32)
    finally:
        first.close()
        second.close()


@pytest.mark.parametrize("tail", [b'{"type":', b"not json\n"])
def test_crashed_tail_is_backed_up_and_future_appends_are_readable(tmp_path, tail):
    session = Session(tmp_path / "state", tmp_path)
    session.add({"role": "user", "content": "durable"})
    path = session.path
    session.close()
    with path.open("ab") as stream:
        stream.write(tail)
    recovered = Session(tmp_path / "state", tmp_path, path)
    try:
        assert recovered.warning
        assert next(path.parent.glob("*.damaged-*")).read_bytes() == tail
        recovered.add({"role": "assistant", "content": "after crash"})
        assert len([json.loads(line) for line in path.read_text().splitlines()]) == 3
    finally:
        recovered.close()


def test_missing_tool_result_is_repaired_once_without_replay(tmp_path):
    root = tmp_path / "state"
    session = Session(root, tmp_path)
    session.add(
        {
            "role": "assistant",
            "content": "",
            "calls": [
                {"id": "done", "name": "write", "arguments": {}},
                {"id": "pending", "name": "bash", "arguments": {"command": "touch never"}},
            ],
        }
    )
    session.add({"role": "tool", "call_id": "done", "name": "write", "content": "ok"})
    path = session.path
    session.close()
    for _ in range(2):
        session = Session(root, tmp_path, path)
        try:
            repairs = [m for m in session.messages if m.get("call_id") == "pending"]
            assert len(repairs) == 1 and repairs[0]["error"]
            assert "unknown" in repairs[0]["content"]
            assert not (tmp_path / "never").exists()
        finally:
            session.close()


def test_corrupt_middle_is_not_silently_discarded(tmp_path):
    session = Session(tmp_path / "state", tmp_path)
    path = session.path
    session.close()
    original = path.read_bytes() + b'broken\n{"type":"name","name":"later"}\n'
    path.write_bytes(original)
    with pytest.raises(ValueError, match="line 2"):
        Session(tmp_path / "state", tmp_path, path)
    assert path.read_bytes() == original


def test_valid_last_record_without_newline_stays_appendable(tmp_path):
    root = tmp_path / "state"
    session = Session(root, tmp_path)
    session.add({"role": "user", "content": "persisted"})
    path = session.path
    session.close()
    path.write_bytes(path.read_bytes().rstrip(b"\n"))
    recovered = Session(root, tmp_path, path)
    try:
        assert not recovered.warning
        recovered.add({"role": "assistant", "content": "continued"})
    finally:
        recovered.close()
    again = Session(root, tmp_path, path)
    try:
        assert [m["content"] for m in again.messages] == ["persisted", "continued"]
    finally:
        again.close()


def test_secret_store_atomic_failure_permissions_and_redaction(tmp_path):
    store = Store(tmp_path)
    fake = "test-secret-never-a-real-token"
    store.set_credential("example", {"access_token": fake, "nested": {"refresh": fake + "-refresh"}})
    assert Store(tmp_path).credential("example")["access_token"] == fake
    assert fake not in store.redact(f"Token {fake}; Bearer abc.def-ghi")
    assert "abc.def-ghi" not in store.redact("Bearer abc.def-ghi")
    store.prefs["model"] = "example/test"
    store.save()
    assert fake not in (tmp_path / "settings.json").read_text()
    if os.name != "nt":
        assert (tmp_path / "auth.json").stat().st_mode & 0o077 == 0
    before = (tmp_path / "auth.json").read_bytes()
    with pytest.raises(ValueError):
        write_json(tmp_path / "auth.json", {"invalid": float("nan")})
    assert (tmp_path / "auth.json").read_bytes() == before
    store.set_credential("example", None)
    assert store.credential("example") == {}
    (tmp_path / "bad.json").write_text("broken")
    with pytest.raises(ValueError, match="Sessions are intact"):
        read_json(tmp_path / "bad.json", {})


def test_chat_list_survives_damaged_files_and_shows_one_line_names(tmp_path):
    from reference_graphy.session import session_folder

    root = tmp_path / "state"
    good = Session(root, tmp_path)
    good.add({"role": "user", "content": "Как решать\nквадратные   уравнения?"})
    good.close()
    folder = session_folder(root, tmp_path)
    (folder / "19990101-000000-aaaaaaaa.jsonl").write_text('{"type": "header", "version": 2}\n123\n[]\nnull\n')
    (folder / "19990101-000000-bbbbbbbb.jsonl").write_bytes(b"\xff\xfe not utf-8")
    (folder / "19990101-000000-cccccccc.jsonl").write_text('{"type": "message", "message": {"role": "user"}}\n')
    rows = {row["path"].name: row for row in Session.list(root, tmp_path)}
    assert rows[good.path.name]["name"] == "Как решать квадратные уравнения?"
    assert rows[good.path.name]["said"] == 1
    assert "19990101-000000-bbbbbbbb.jsonl" not in rows  # unreadable files are skipped, not fatal
    assert rows["19990101-000000-aaaaaaaa.jsonl"]["said"] == 0


def test_session_names_come_from_the_last_name_event_not_the_first_message(tmp_path):
    session = Session(tmp_path / "state", tmp_path)
    session.add({"role": "user", "content": "first message"})
    assert Session.list(tmp_path / "state", tmp_path)[0]["name"] == "first message"
    session.append("name", name="Renamed")
    session.close()
    assert Session.list(tmp_path / "state", tmp_path)[0]["name"] == "Renamed"


def test_default_data_directory_moves_from_the_former_name(tmp_path, monkeypatch):
    monkeypatch.delenv("GRAPHY_DIR", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    old = tmp_path / ".pipy"
    old.mkdir()
    (old / "settings.json").write_text('{"web_provider": "duckduckgo"}')
    store = Store()
    assert store.root == tmp_path / ".graphy" and not old.exists()
    assert store.prefs == {"web_provider": "duckduckgo"}
    monkeypatch.setenv("GRAPHY_DIR", str(tmp_path / "custom"))
    assert Store().root == tmp_path / "custom"
