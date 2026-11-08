"""llama.cpp router management. The server owns model files and downloads."""

from __future__ import annotations

import asyncio
import builtins
import contextlib
import json
import os
import re
from collections.abc import Awaitable, Callable
from urllib.parse import quote, urlsplit, urlunsplit

import httpx

Progress = Callable[[str], Awaitable[None]]
_ACTIONS = {"load": "/models/load", "unload": "/models/unload", "download": "/models"}
_QUANT = re.compile(
    r"(?:^|[-_.])((?:UD-)?(?:(?:IQ|Q)\d(?:_[A-Z0-9]+)+|BF16|F16|F32|MXFP\d(?:_[A-Z0-9]+)*))$", re.I
)


class LlamaError(RuntimeError):
    """A failed management operation, with its last observed router catalog."""

    def __init__(self, message: str, models: list | None = None):
        super().__init__(message)
        self.models = models


class Llama:
    def __init__(self, base_url: str, key: str = "", client: httpx.AsyncClient | None = None):
        parsed = urlsplit(base_url.strip())
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
        ):
            raise ValueError("Router URL must be HTTP(S), without embedded credentials")
        path = parsed.path.rstrip("/")
        if path.endswith("/v1"):
            path = path[:-3]
        self.base_url = urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))
        self.key = key
        self.client = client or httpx.AsyncClient(follow_redirects=False)
        self._owned = client is None
        self.poll_interval = 0.5
        self.operation_timeout = 1200.0
        self.last_cancel: dict | None = None

    async def aclose(self):
        if self._owned:
            await self.client.aclose()

    def _headers(self, hf: bool = False) -> dict:
        token = os.environ.get("HF_TOKEN", "") if hf else self.key
        return {"Authorization": f"Bearer {token}"} if token else {}

    async def _request(
        self,
        path: str,
        method: str = "GET",
        *,
        body: dict | None = None,
        params: dict | None = None,
        hf: bool = False,
    ):
        service = "Hugging Face" if hf else "llama.cpp"
        url = ("https://huggingface.co" if hf else self.base_url) + path
        try:
            response = await self.client.request(
                method, url, json=body, params=params, headers=self._headers(hf), timeout=15
            )
        except httpx.HTTPError as exc:
            # Exception strings and upstream bodies can echo authentication headers.
            raise LlamaError(f"{service} connection failed ({type(exc).__name__})") from None
        if not response.is_success:
            retry = response.headers.get("retry-after", "")
            suffix = f"; retry after {retry}s" if response.status_code == 429 and retry.isdigit() else ""
            raise LlamaError(f"{service} returned HTTP {response.status_code}{suffix}")
        if not response.content:
            return {}
        try:
            return response.json()
        except ValueError:
            raise LlamaError(f"{service} returned invalid JSON") from None

    async def list(self, reload: bool = False) -> list[dict]:
        payload = await self._request("/models", params={"reload": "1"} if reload else None)
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, list) or any(
            not isinstance(item, dict)
            or not isinstance(item.get("id"), str)
            or not isinstance(item.get("status"), dict)
            or not isinstance(item["status"].get("value"), str)
            for item in data
        ):
            raise LlamaError("Invalid router catalog; llama.cpp must run in router mode")
        return data

    async def props(self, model: str = "") -> dict:
        payload = await self._request(
            "/props", params={"model": model, "autoload": "false"} if model else None
        )
        return payload if isinstance(payload, dict) else {}

    @staticmethod
    def _entry(models: builtins.list[dict], model: str) -> dict | None:
        return next((m for m in models if m["id"] == model or model in m.get("aliases", [])), None)

    @staticmethod
    def _progress(data: dict) -> str:
        progress = data.get("progress", data)
        if not isinstance(progress, dict):
            return ""
        counts = [
            v
            for v in progress.values()
            if isinstance(v, dict)
            and isinstance(v.get("done"), (int, float))
            and isinstance(v.get("total"), (int, float))
        ]
        total = sum(v["total"] for v in counts)
        if total > 0:
            done = sum(v["done"] for v in counts)
            return f"Downloading {max(0, min(100, done / total * 100)):.1f}% ({done / 1048576:.1f}/{total / 1048576:.1f} MiB)"
        stage = progress.get("current", progress.get("stage", ""))
        value = progress.get("value")
        if stage or isinstance(value, (int, float)):
            ratio = max(0, min(1, value)) if isinstance(value, (int, float)) else 0
            stages = progress.get("stages", [])
            if isinstance(stages, list) and stage in stages:
                ratio = (stages.index(stage) + ratio) / len(stages)
            return f"Loading {str(stage).replace('_', ' ')} {ratio * 100:.1f}%".strip()
        return ""

    async def _watch(self, model: str, progress: Progress, events: dict):
        """SSE enriches progress; only GET /models decides successful completion."""
        try:
            async with self.client.stream(
                "GET",
                self.base_url + "/models/sse",
                headers=self._headers(),
                timeout=httpx.Timeout(15, read=None),
            ) as response:
                if not response.is_success:
                    return
                lines = []
                async for line in response.aiter_lines():
                    if line.startswith("data:"):
                        lines.append(line[5:].lstrip())
                    elif not line and lines:
                        raw, lines = "\n".join(lines), []
                        try:
                            event = json.loads(raw)
                        except ValueError:
                            continue
                        if not isinstance(event, dict) or event.get("model") != model:
                            continue
                        data = event.get("data")
                        data = data if isinstance(data, dict) else {}
                        if event.get("event") == "download_failed":
                            events["failure"] = "Model download failed"
                        message = self._progress(data)
                        if message:
                            await progress(message)
        except (httpx.HTTPError, ValueError):
            pass  # Older routers and disconnections fall back to catalog polling.

    async def perform(self, action: str, model: str, progress: Progress) -> builtins.list[dict]:
        if action not in _ACTIONS or not model.strip():
            raise ValueError("Expected load, unload or download and a nonempty model")
        events: dict = {}
        watcher = asyncio.create_task(self._watch(model, progress, events))
        models: builtins.list[dict] | None = None
        try:
            async with asyncio.timeout(self.operation_timeout):
                # A single POST only: a dropped response must never replay a mutation.
                try:
                    await self._request(_ACTIONS[action], "POST", body={"model": model})
                except LlamaError as exc:
                    models = await self._observed()
                    raise LlamaError(
                        f"{exc}. Operation was not retried; inspect router status before retrying", models
                    ) from None
                await progress(
                    {"load": "Loading model", "unload": "Unloading model", "download": "Downloading model"}[
                        action
                    ]
                )
                stable = 0
                while True:
                    models = await self.list()
                    entry = self._entry(models, model)
                    status = entry["status"] if entry else {}
                    value = status.get("value")
                    if status.get("failed") or value == "failed" or events.get("failure"):
                        code = status.get("exit_code")
                        detail = f" (exit {code})" if isinstance(code, int) else ""
                        raise LlamaError(f"Model {action} failed{detail}", models)
                    if action == "load" and value == "loaded":
                        return models
                    if action == "unload" and (entry is None or value == "unloaded"):
                        return models
                    if action == "download":
                        # Require an actual catalog entry; SSE never fabricates success.
                        stable = stable + 1 if entry and value not in {"downloading", "loading"} else 0
                        if stable >= 2:
                            return await self.list(reload=True)
                    message = self._progress(status)
                    if message:
                        await progress(message)
                    await asyncio.sleep(self.poll_interval)
        except asyncio.CancelledError:
            # The reference router uses unload to stop both load and download.
            task = asyncio.create_task(self.cancel(model, action))
            try:
                self.last_cancel = await asyncio.shield(task)
                await progress(self.last_cancel["message"])
            except asyncio.CancelledError:
                # Preserve cleanup on repeated cancellation as well.
                with contextlib.suppress(Exception, asyncio.CancelledError):
                    self.last_cancel = await task
            raise
        except TimeoutError:
            models = await self._observed()
            raise LlamaError(
                "Router operation timed out; remote work may continue. Inspect status or cancel before retrying",
                models,
            ) from None
        except LlamaError as exc:
            if exc.models is None:
                exc.models = await self._observed()
            raise
        finally:
            watcher.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await watcher

    async def _observed(self) -> builtins.list[dict] | None:
        try:
            return await self.list()
        except LlamaError:
            return None

    async def cancel(self, model: str, action: str) -> dict:
        """Stop load/download via unload, then report observed state, not a promise."""
        if action not in _ACTIONS:
            raise ValueError("Unknown router action")
        requested, error = False, ""
        if action in {"load", "download"}:
            try:
                requested = True
                await self._request("/models/unload", "POST", body={"model": model})
            except LlamaError as exc:
                error = str(exc)
        models = await self._observed()
        entry = self._entry(models, model) if models is not None else None
        value = entry["status"]["value"] if entry else ("absent" if models is not None else "unknown")
        confirmed = models is not None and value in {"absent", "unloaded"}
        message = f"Router state: {value}. " + (
            "Operation stopped." if confirmed else "Remote cancellation is not confirmed."
        )
        if error:
            message += " " + error
        return {"requested": requested, "confirmed": confirmed, "message": message, "models": models}

    async def search(self, query: str) -> builtins.list[dict]:
        payload = await self._request(
            "/api/models",
            hf=True,
            params={"search": query, "filter": "gguf", "sort": "downloads", "direction": "-1", "limit": "20"},
        )
        if not isinstance(payload, list):
            raise LlamaError("Hugging Face returned invalid search results")
        return [
            {"id": m["id"], "downloads": m.get("downloads", 0)}
            for m in payload
            if isinstance(m, dict) and isinstance(m.get("id"), str)
        ]

    async def variants(self, repo: str) -> dict:
        """Discover GGUF quants, summing shards and excluding vision projectors."""
        repo = repo.split(":", 1)[0]
        encoded = "/".join(quote(part, safe="") for part in repo.split("/"))
        payload = await self._request(f"/api/models/{encoded}", params={"blobs": "true"}, hf=True)
        if not isinstance(payload, dict) or not isinstance(payload.get("siblings"), list):
            raise LlamaError("Hugging Face returned invalid model details")
        sizes: dict[str, int | None] = {}
        for file in payload["siblings"]:
            if not isinstance(file, dict):
                continue
            name = str(file.get("rfilename", "")).rsplit("/", 1)[-1]
            if not name.lower().endswith(".gguf") or name.lower().startswith("mmproj"):
                continue
            match = _QUANT.search(re.sub(r"-\d{5}-of-\d{5}$", "", name[:-5]))
            if match:
                quant, size = match[1].upper(), file.get("size")
                if not isinstance(size, int) or (quant in sizes and sizes[quant] is None):
                    sizes[quant] = None
                else:
                    sizes[quant] = (sizes.get(quant) or 0) + size
        quants = [
            {"name": name, **({"size": size} if size is not None else {})} for name, size in sizes.items()
        ]
        quants.sort(key=lambda q: (q["name"] != "Q4_K_M", q.get("size", float("inf")), q["name"]))
        return {"id": payload.get("id", repo), "gated": payload.get("gated", False), "quantizations": quants}
