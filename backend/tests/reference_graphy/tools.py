"""File reading and cancellable document-processing shell commands."""

import asyncio
import base64
import io
import os
import shutil
import signal
import tempfile
import threading
from pathlib import Path

from jsonschema import Draft202012Validator
from PIL import Image, ImageOps

from .contracts import normalize_optional

MAX_BYTES, MAX_LINES = 50 * 1024, 2000


def schema(properties, required):
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


S = {"type": "string"}
N = {"type": "integer", "minimum": 1}
DEFINITIONS = {
    "read": (
        "Read text lines or an image. Paths are relative to the launch directory. offset starts at 1; limit bounds lines. Follow next_offset when truncated.",
        schema({"path": S, "offset": N, "limit": N}, ["path"]),
    ),
    "bash": (
        "Run Bash in the working directory; returns output and exit code. timeout is seconds. Inspect state before retrying an interrupted command.",
        schema({"command": S, "timeout": {"type": "number", "exclusiveMinimum": 0}}, ["command"]),
    ),
}


def bounded(text: str, *, tail=False, lines=MAX_LINES, size=MAX_BYTES) -> str:
    parts = text.splitlines(keepends=True)
    if len(parts) <= lines and len(text.encode()) <= size:
        return text
    selected = "".join(parts[-lines:] if tail else parts[:lines]).encode()
    selected = selected[-size:] if tail else selected[:size]
    result = selected.decode("utf-8", errors="ignore")
    return ("[Earlier output omitted]\n" + result) if tail else (result + "\n[Output truncated]")


def image_file(path: Path) -> dict:
    with Image.open(path) as original:
        image = ImageOps.exif_transpose(original)
        image.thumbnail((2000, 2000))
        if image.mode not in ("RGB", "RGBA"):
            image = image.convert("RGB")
        data = io.BytesIO()
        image.save(data, format="PNG")
        if data.tell() > 3_000_000:
            data = io.BytesIO()
            image.convert("RGB").save(data, format="JPEG", quality=80)
            mime = "image/jpeg"
        else:
            mime = "image/png"
        if data.tell() > 4_500_000:
            raise ValueError("Image is too large after resize")
        return {"mime": mime, "data": base64.b64encode(data.getvalue()).decode(), "name": path.name}


class Tools:
    def __init__(self, cwd: Path, enabled=None):
        self.cwd = cwd.resolve()
        self.enabled = list(DEFINITIONS) if enabled is None else list(enabled)

    @property
    def declarations(self):
        return [
            {"name": name, "description": DEFINITIONS[name][0], "parameters": DEFINITIONS[name][1]}
            for name in self.enabled
            if name in DEFINITIONS
        ]

    def path(self, value="."):
        path = Path(value).expanduser()
        return path if path.is_absolute() else self.cwd / path

    async def execute(self, call: dict, update=None) -> dict:
        name, args = call["name"], call.get("arguments", {})
        try:
            if name not in self.enabled or name not in DEFINITIONS:
                raise ValueError(f"Unknown or disabled tool: {name}")
            args = normalize_optional(DEFINITIONS[name][1], args)
            Draft202012Validator(DEFINITIONS[name][1]).validate(args)
            if name == "bash":
                return await self.bash(args, update)
            stop = threading.Event()
            try:
                return await asyncio.to_thread(self.read_file, args, stop)
            finally:
                stop.set()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            return {"content": bounded(f"{type(exc).__name__}: {exc}"), "error": True}

    def read_file(self, args, stop):
        path = self.path(args["path"])
        if path.suffix.lower() in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"):
            return {"content": f"Image: {path.name}", "images": [image_file(path)]}
        start, count = args.get("offset", 1), args.get("limit", MAX_LINES)
        selected: list[str] = []
        size, last, truncated = 0, start - 1, False
        with path.open(encoding="utf-8", errors="replace") as stream:
            for index, line in enumerate(stream, 1):
                if stop.is_set():
                    break
                if index < start:
                    continue
                if len(selected) >= min(count, MAX_LINES) or size + len(line.encode()) > MAX_BYTES:
                    truncated = True
                    break
                selected.append(line)
                size += len(line.encode())
                last = index
        text = "".join(selected)
        if truncated and not selected:
            # Nothing fits: pointing at the same (or an earlier) offset would send the model in circles.
            text = f"[Line {start} exceeds {MAX_BYTES} bytes. Read it with bash, e.g. sed -n '{start}p' file | cut -c1-4000.]"
            return {"content": text, "next_offset": None, "truncated": True}
        if truncated:
            text += f"\n[Truncated; continue with offset={last + 1}. For an oversized line use bash.]"
        return {"content": text, "next_offset": last + 1 if truncated else None, "truncated": truncated}

    async def bash(self, args, update):
        executable = shutil.which("bash")
        if not executable:
            raise ValueError("Bash not found. On Windows install Git Bash and add it to PATH.")
        kwargs = {"start_new_session": True} if os.name != "nt" else {"creationflags": 0x200}
        process = await asyncio.create_subprocess_exec(
            executable,
            "-c",
            args["command"],
            cwd=self.cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            **kwargs,
        )
        fd, output_path = tempfile.mkstemp(prefix="graphy-output-", suffix=".txt")
        output = os.fdopen(fd, "wb")
        total, tail = 0, b""

        async def consume():
            nonlocal tail, total
            assert process.stdout is not None
            while chunk := await process.stdout.read(8192):
                output.write(chunk)
                total += len(chunk)
                tail = (tail + chunk)[-MAX_BYTES:]
                if update:
                    await update(chunk.decode(errors="replace"))
            await process.wait()

        async def kill():
            if os.name == "nt":
                killer = await asyncio.create_subprocess_exec(
                    "taskkill",
                    "/PID",
                    str(process.pid),
                    "/T",
                    "/F",
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await killer.wait()
            else:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                    await asyncio.sleep(0.15)
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            await process.wait()

        timed_out = False
        try:
            try:
                async with asyncio.timeout(args.get("timeout")):
                    await consume()
            except TimeoutError:
                # What the command printed before the deadline is the only clue to why it hung.
                timed_out = True
                await asyncio.shield(kill())
        except BaseException:
            await asyncio.shield(kill())
            output.close()
            os.unlink(output_path)
            raise
        output.close()
        truncated = total > MAX_BYTES or tail.count(b"\n") > MAX_LINES
        text = bounded(tail.decode(errors="replace"), tail=True)
        if timed_out:
            text += f"\n[Timed out after {args['timeout']:g}s; the command was killed]"
        if truncated:
            text += f"\n[Full output: {output_path}]"
        else:
            os.unlink(output_path)
        return {
            "content": text,
            "exit_code": process.returncode,
            "error": timed_out or process.returncode != 0,
            **({"full_output_path": output_path} if truncated else {}),
        }
