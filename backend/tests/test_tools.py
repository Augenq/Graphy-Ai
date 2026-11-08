import asyncio
import base64
import io
import os
import shlex
import sys
import tempfile
from pathlib import Path

import pytest
from PIL import Image
from reference_graphy.tools import MAX_BYTES, Tools


async def call(tools, name, **arguments):
    return await tools.execute({"name": name, "arguments": arguments})


async def test_only_read_and_bash_exist_so_nothing_else_is_declared_or_executable(tmp_path):
    tools = Tools(tmp_path)
    assert [d["name"] for d in tools.declarations] == ["read", "bash"]
    for name in ("write", "edit", "grep", "find", "ls"):
        assert (await call(tools, name, path="file", pattern="x", content="y"))["error"], name


async def test_read_ranges_and_validation(tmp_path):
    tools = Tools(tmp_path)
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub/file").write_text("one\ntwo\nthree\nfour\n")
    read = await call(tools, "read", path="sub/file", offset=2, limit=2)
    assert read["content"].startswith("two\nthree\n") and "offset=4" in read["content"]
    past_end = await call(tools, "read", path="sub/file", offset=5)
    assert past_end["content"] == "" and past_end["next_offset"] is None and not past_end["truncated"]
    last_page = await call(tools, "read", path="sub/file", offset=4, limit=2)
    assert last_page["content"] == "four\n" and last_page["next_offset"] is None
    assert (await call(tools, "read", path="sub/file", offset=0))["error"]
    assert (await call(tools, "powershell", command="echo bad"))["error"]


async def test_read_byte_bound_and_image_resize(tmp_path):
    (tmp_path / "large").write_text("line\n" * 20000)
    result = await call(Tools(tmp_path), "read", path="large")
    assert len(result["content"].encode()) < MAX_BYTES + 200
    assert "Truncated" in result["content"]
    assert result["truncated"] and f"offset={result['next_offset']}" in result["content"]
    # following next_offset must make progress and finally reach the end
    seen, offset = 0, 1
    while offset:
        page = await call(Tools(tmp_path), "read", path="large", offset=offset)
        seen += page["content"].count("line\n")
        assert page["next_offset"] is None or page["next_offset"] > offset
        offset = page["next_offset"]
    assert seen == 20000
    Image.new("RGB", (4000, 1000), "red").save(tmp_path / "picture.png")
    result = await call(Tools(tmp_path), "read", path="picture.png")
    attached = result["images"][0]
    with Image.open(io.BytesIO(base64.b64decode(attached["data"]))) as image:
        assert image.size == (2000, 500)


async def test_shell_exit_stream_and_full_truncated_output(tmp_path):
    tools, chunks = Tools(tmp_path), []

    async def update(chunk):
        chunks.append(chunk)

    result = await tools.execute(
        {"name": "bash", "arguments": {"command": "printf 'out'; printf 'err' >&2; exit 7"}}, update
    )
    assert result["exit_code"] == 7 and result["error"]
    assert "out" in "".join(chunks) and "err" in result["content"]
    command = f"{shlex.quote(sys.executable)} -c 'print(\"abc\" * 30000)'"
    result = await call(tools, "bash", command=command)
    path = Path(result["full_output_path"])
    try:
        assert await asyncio.to_thread(path.read_text) == "abc" * 30000 + "\n"
        assert len(result["content"].encode()) < MAX_BYTES + 300
    finally:
        await asyncio.to_thread(path.unlink)


@pytest.mark.skipif(os.name == "nt", reason="POSIX process group behavior")
@pytest.mark.parametrize("cancel", [False, True])
async def test_shell_timeout_and_cancel_kill_descendants(tmp_path, cancel):
    pid_file = tmp_path / "child.pid"
    script = "import os,signal,time,pathlib; signal.signal(signal.SIGTERM,signal.SIG_IGN); "
    script += f"pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid())); time.sleep(60)"
    command = f"{shlex.quote(sys.executable)} -c {shlex.quote(script)} & wait"
    arguments = {"command": command, **({} if cancel else {"timeout": 1})}
    task = asyncio.create_task(call(Tools(tmp_path), "bash", **arguments))
    for _ in range(100):
        if pid_file.exists():
            break
        await asyncio.sleep(0.01)
    assert pid_file.exists(), "Child process did not start"
    pid = int(pid_file.read_text())
    try:
        if cancel:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            result = await task
            assert result.get("error") and "Timed out after 1s" in result["content"]
            assert result["exit_code"] != 0  # the whole process group was killed, not just the shell
        for _ in range(100):
            status = Path(f"/proc/{pid}/status")
            try:
                state = await asyncio.to_thread(status.read_text)
            except (FileNotFoundError, ProcessLookupError):
                break
            if "State:\tZ" in state:
                break
            await asyncio.sleep(0.01)
        else:
            pytest.fail(f"Descendant {pid} survived cancellation")
    finally:
        if not task.done():
            task.cancel()
        try:
            os.kill(pid, 9)
        except ProcessLookupError:
            pass


async def test_read_line_over_the_byte_limit_never_points_back_at_itself(tmp_path):
    (tmp_path / "wide").write_text("a\nb\n" + "x" * (MAX_BYTES + 10) + "\nlast\n")
    tools = Tools(tmp_path)
    before = await call(tools, "read", path="wide")
    assert before["content"].startswith("a\nb\n") and before["next_offset"] == 3
    # next_offset used to be 1 here: following it re-read the file from the top, forever.
    long_line = await call(tools, "read", path="wide", offset=3)
    assert long_line["truncated"] and long_line["next_offset"] is None
    assert "bash" in long_line["content"] and "Line 3" in long_line["content"]
    assert (await call(tools, "read", path="wide", offset=4))["content"] == "last\n"


async def test_read_offset_past_a_long_line_keeps_counting_from_the_requested_offset(tmp_path):
    (tmp_path / "f").write_text("".join(f"line{i}\n" for i in range(1, 6)) + "y" * (MAX_BYTES + 1) + "\n")
    result = await call(Tools(tmp_path), "read", path="f", offset=4)
    assert result["content"].startswith("line4\nline5\n") and result["next_offset"] == 6


async def test_read_directory_and_missing_file_are_errors_not_crashes(tmp_path):
    (tmp_path / "dir").mkdir()
    tools = Tools(tmp_path)
    assert (await call(tools, "read", path="dir"))["error"]
    assert "FileNotFoundError" in (await call(tools, "read", path="nope"))["content"]


def test_bounded_keeps_head_or_tail_and_cuts_inside_utf8_safely():
    from reference_graphy.tools import bounded

    assert bounded("short") == "short"
    text = "".join(f"{i}\n" for i in range(10))
    assert bounded(text, lines=3).startswith("0\n1\n2\n") and bounded(text, lines=3).endswith("[Output truncated]")
    tail = bounded(text, tail=True, lines=3)
    assert tail.startswith("[Earlier output omitted]") and tail.endswith("7\n8\n9\n")
    # A byte limit that falls in the middle of a Cyrillic letter must not raise or leave a broken character.
    cyrillic = "я" * 100
    assert set(bounded(cyrillic, size=51).replace("\n[Output truncated]", "")) == {"я"}
    assert set(bounded(cyrillic, tail=True, size=51).replace("[Earlier output omitted]\n", "")) == {"я"}


async def test_shell_timeout_keeps_what_the_command_printed_before_the_deadline(tmp_path):
    result = await call(Tools(tmp_path), "bash", command="echo before; sleep 30", timeout=1)
    assert result["error"]
    assert "before" in result["content"] and "Timed out after 1s" in result["content"]
    assert "TimeoutError" not in result["content"]


async def test_shell_without_deadline_and_with_silent_success_has_empty_output(tmp_path):
    result = await call(Tools(tmp_path), "bash", command="true")
    assert result == {"content": "", "exit_code": 0, "error": False}


@pytest.mark.skipif(os.name == "nt", reason="POSIX process group behavior")
@pytest.mark.parametrize("how", ["success", "failure", "timeout", "cancel"])
async def test_shell_never_leaves_its_output_file_behind_unless_it_returns_the_path(tmp_path, monkeypatch, how):
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(scratch))
    tools = Tools(tmp_path)
    if how == "cancel":
        task = asyncio.create_task(call(tools, "bash", command="echo started; sleep 30"))
        await asyncio.sleep(0.5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    else:
        command, timeout = {"success": ("echo ok", None), "failure": ("echo no; exit 3", None),
                            "timeout": ("sleep 30", 0.5)}[how]
        await call(tools, "bash", command=command, **({"timeout": timeout} if timeout else {}))
    assert list(scratch.iterdir()) == []


async def test_shell_large_output_keeps_the_complete_file_closed_and_flushed(tmp_path):
    command = f"{shlex.quote(sys.executable)} -c 'print(\"z\" * 200000)'"
    result = await call(Tools(tmp_path), "bash", command=command)
    path = Path(result["full_output_path"])
    try:
        assert (await asyncio.to_thread(path.stat)).st_size == 200001 and "[Full output:" in result["content"]
    finally:
        await asyncio.to_thread(path.unlink)
