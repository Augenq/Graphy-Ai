"""HTTP/SSE adapters with a single message format and no provider SDKs."""

import asyncio
import copy
import inspect
import json
import math
import re
import time
import uuid
from email.utils import parsedate_to_datetime

import httpx

from .auth import AuthError, codex_credential
from .models import api_key, settings
from .native import invoke
from .styles import STYLE_HEADING


class ProviderError(RuntimeError):
    def __init__(self, message, status=None, retry_after=None, retryable=False, streamed=False, partial=None):
        super().__init__(message)
        self.status, self.retry_after = status, retry_after
        self.retryable, self.streamed, self.partial = retryable, streamed, partial
        self.context_overflow = status == 413 or bool(
            re.search(
                r"context[_ ](?:length|window)|too many tokens|maximum.*tokens|prompt is too long|input.*too long",
                message,
                re.I,
            )
        )


def call_id(value, provider=None):
    return invoke("providers.call_id", {"value": value, "provider": provider})


def _compatible(message, model):
    return invoke("providers.compatible", {"message": message, "model": model})


def _images(message, api):
    return invoke("providers.images", {"message": message, "api": api})


def _fold_state(messages):
    return invoke("providers.fold_state", {"messages": messages})


def _history(model, messages, system):
    return invoke("providers.history", {"model": model, "messages": messages, "system": system})


def payload(model, messages, system, tools, thinking, session_id):
    """Build a protocol-specific request with the Rust core; transports stay asynchronous."""
    try:
        result = invoke("providers.payload", {
            "model": model, "messages": messages, "system": system, "tools": tools,
            "thinking": thinking, "session_id": session_id, "style_heading": STYLE_HEADING,
        })
    except ValueError as exc:
        raise ProviderError(str(exc)) from exc
    return tuple(result)


def _adaptive_thinking(model_id):
    return invoke("providers.adaptive_thinking", {"model_id": model_id})


def strict_schema(schema):
    return invoke("providers.strict_schema", {"schema": schema})


async def sse_events(response):
    """Incremental UTF-8/CRLF framing is handled by httpx; SSE data can span lines."""
    data = []
    async for line in response.aiter_lines():
        if line.startswith("data:"):
            data.append(line[5:].lstrip(" "))
        elif not line and data:
            value = "\n".join(data)
            data = []
            if value == "[DONE]":
                yield {"_done": True}
            else:
                event = json.loads(value)
                if not isinstance(event, dict):
                    raise ProviderError("Invalid SSE event object")
                yield event
    if data:
        value = "\n".join(data)
        event = {"_done": True} if value == "[DONE]" else json.loads(value)
        if not isinstance(event, dict):
            raise ProviderError("Invalid SSE event object")
        yield event


def _retry_after(headers):
    try:
        if headers.get("retry-after-ms"):
            return max(0, float(headers["retry-after-ms"]) / 1000)
        value = headers.get("retry-after")
        if value:
            try:
                return max(0, float(value))
            except ValueError:
                return max(0, parsedate_to_datetime(value).timestamp() - time.time())
    except (ValueError, TypeError, OverflowError):
        pass
    return None


def _usage(result, model, values, api):
    usage = result["usage"]
    if api == "anthropic":
        for source, target in [
            ("input_tokens", "input"),
            ("output_tokens", "output"),
            ("cache_read_input_tokens", "cache_read"),
            ("cache_creation_input_tokens", "cache_write"),
        ]:
            if source in values:
                usage[target] = values[source]
    elif api == "google":
        if "promptTokenCount" in values:
            usage["input"] = values["promptTokenCount"] - values.get("cachedContentTokenCount", 0)
        usage["output"] = values.get("candidatesTokenCount", 0) + values.get("thoughtsTokenCount", 0)
        usage["cache_read"] = values.get("cachedContentTokenCount", 0)
    else:
        total = values.get("input_tokens") or values.get("prompt_tokens") or 0
        details = values.get("input_tokens_details") or values.get("prompt_tokens_details") or {}
        cached = values.get("prompt_cache_hit_tokens") or details.get("cached_tokens") or 0
        usage.update(
            input=max(0, total - cached),
            output=values.get("output_tokens") or values.get("completion_tokens") or 0,
            cache_read=cached,
        )
    prices = model.get("cost")
    tokens = usage["input"] + usage["cache_read"] + usage["cache_write"]
    for tier in model.get("cost_tiers", []):
        threshold = tier.get("tier", {}).get("size")
        if threshold and tokens > threshold:
            prices = {**(prices or {}), **{k: v for k, v in tier.items() if k != "tier"}}
    if prices is not None and all(
        not usage[k] or k in prices for k in ("input", "output", "cache_read", "cache_write")
    ):
        usage["cost"] = (
            sum(usage[k] * prices.get(k, 0) for k in ("input", "output", "cache_read", "cache_write")) / 1e6
        )
    if type(values.get("cost")) in (int, float) and math.isfinite(values["cost"]) and values["cost"] >= 0:
        usage["cost"] = values["cost"]


class _Response:
    def __init__(self, model, emit):
        self.model, self.emit = model, emit
        self.result = {
            "role": "assistant",
            "content": "",
            "thinking": "",
            "calls": [],
            "provider": model["provider"],
            "model": model["id"],
            "stop": "stop",
            "usage": {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "cost": None},
        }
        self.calls = {}
        self.blocks = {}
        self.parts = []
        self.reasoning = []
        self.done = False
        self.streamed = False

    async def delta(self, value, thinking=False):
        if not value:
            return
        key = "thinking" if thinking else "content"
        self.result[key] += value
        self.streamed = True
        event = self.emit({"type": "thinking_delta" if thinking else "text_delta", "delta": value})
        if inspect.isawaitable(event):
            await event

    async def chat(self, event):
        if event.get("_done"):
            self.done = True
            return
        if event.get("usage"):
            _usage(self.result, self.model, event["usage"], "chat")
        for choice in event.get("choices") or []:
            if choice.get("index", 0) != 0:
                continue
            delta = choice.get("delta") or {}
            content = delta.get("content")
            if isinstance(content, list):
                for part in content:
                    if part.get("type") == "text":
                        await self.delta(part.get("text", ""))
                    elif part.get("type") == "thinking":
                        thoughts = part.get("thinking", [])
                        if isinstance(thoughts, str):
                            await self.delta(thoughts, True)
                        else:
                            for thought in thoughts:
                                await self.delta(thought.get("text", ""), True)
            else:
                await self.delta(content)
            reasoning = next(
                (
                    delta[k]
                    for k in ("reasoning_content", "reasoning", "reasoning_text")
                    if isinstance(delta.get(k), str)
                ),
                None,
            )
            await self.delta(reasoning, True)
            for c in delta.get("tool_calls") or []:
                self.streamed = True
                index = c.get("index")
                if index is None:
                    # Without an index a new id opens a new call; a chunk without an id continues the last one.
                    same = next((i for i, t in self.calls.items() if c.get("id") and t["id"] == c["id"]), None)
                    index = same if same is not None else (
                        max(self.calls, default=0) if not c.get("id") else max(self.calls, default=-1) + 1)
                target = self.calls.setdefault(index, {"id": "", "name": "", "arguments": ""})
                if c.get("id"):
                    target["id"] = c["id"]
                function = c.get("function") or {}
                target["name"] += function.get("name") or ""
                target["arguments"] += function.get("arguments") or ""
            if choice.get("finish_reason"):
                self.done = True
                reason = choice["finish_reason"]
                self.result["stop"] = (
                    "length" if reason == "length" else ("error" if reason == "content_filter" else "stop")
                )

    async def responses(self, event):
        kind = event.get("type", "")
        if kind == "response.output_text.delta":
            await self.delta(event.get("delta", ""))
        elif kind in ("response.reasoning_summary_text.delta", "response.reasoning_text.delta"):
            await self.delta(event.get("delta", ""), True)
        elif kind in ("response.output_item.added", "response.output_item.done"):
            item = event.get("item", {})
            index = event.get("output_index", item.get("id", 0))
            if item.get("type") == "function_call":
                self.streamed = True
                target = self.calls.setdefault(
                    index, {"id": item.get("call_id", ""), "name": item.get("name", ""), "arguments": ""}
                )
                target.update(id=item.get("call_id", target["id"]), name=item.get("name", target["name"]))
                if kind.endswith(".done"):
                    target["arguments"] = item.get("arguments", target["arguments"])
            elif kind.endswith(".done") and item.get("type") == "reasoning" and item.get("encrypted_content"):
                self.reasoning.append(item)
        elif kind == "response.function_call_arguments.delta":
            self.streamed = True
            self.calls.setdefault(event.get("output_index", 0), {"id": "", "name": "", "arguments": ""})[
                "arguments"
            ] += event.get("delta", "")
        elif kind in ("response.completed", "response.incomplete", "response.failed", "response.cancelled"):
            response = event.get("response", {})
            self.done = True
            if kind == "response.incomplete":
                details = response.get("incomplete_details") or {}
                self.result["stop"] = "length" if details.get("reason") == "max_output_tokens" else "error"
            elif kind != "response.completed":
                self.result["stop"] = "error"
            if response.get("usage"):
                _usage(self.result, self.model, response["usage"], self.model["api"])
            # Some proxies send only the final output, without preceding item/delta events.
            if not self.result["content"]:
                for item in response.get("output", []):
                    for part in item.get("content", []):
                        if part.get("type") == "output_text":
                            await self.delta(part.get("text", ""))
            for index, item in enumerate(response.get("output", [])):
                if item.get("type") == "function_call":
                    self.calls[index] = {
                        "id": item.get("call_id", ""),
                        "name": item.get("name", ""),
                        "arguments": item.get("arguments", ""),
                    }
                if item.get("type") == "reasoning" and item.get("encrypted_content"):
                    if item not in self.reasoning:
                        self.reasoning.append(item)

    async def anthropic(self, event):
        kind, index = event.get("type"), event.get("index", 0)
        if kind == "message_start":
            _usage(self.result, self.model, event.get("message", {}).get("usage", {}), "anthropic")
        elif kind == "content_block_start":
            block = copy.deepcopy(event.get("content_block", {}))
            self.blocks[index] = block
            if block.get("type") == "text":
                await self.delta(block.get("text", ""))
            elif block.get("type") == "thinking":
                await self.delta(block.get("thinking", ""), True)
            elif block.get("type") == "tool_use":
                self.streamed = True
                self.calls[index] = {"id": block["id"], "name": block["name"], "arguments": ""}
        elif kind == "content_block_delta":
            delta = event.get("delta", {})
            block = self.blocks[index]
            if delta.get("type") == "text_delta":
                block["text"] = block.get("text", "") + delta.get("text", "")
                await self.delta(delta.get("text", ""))
            elif delta.get("type") == "thinking_delta":
                block["thinking"] = block.get("thinking", "") + delta.get("thinking", "")
                await self.delta(delta.get("thinking", ""), True)
            elif delta.get("type") == "signature_delta":
                block["signature"] = block.get("signature", "") + delta.get("signature", "")
            elif delta.get("type") == "input_json_delta":
                self.calls[index]["arguments"] += delta.get("partial_json", "")
        elif kind == "message_delta":
            if event.get("delta", {}).get("stop_reason") == "max_tokens":
                self.result["stop"] = "length"
            elif event.get("delta", {}).get("stop_reason") in ("refusal", "safety"):
                self.result["stop"] = "error"
            _usage(self.result, self.model, event.get("usage", {}), "anthropic")
        elif kind == "message_stop":
            self.done = True

    async def google(self, event):
        if event.get("usageMetadata"):
            _usage(self.result, self.model, event["usageMetadata"], "google")
        if event.get("promptFeedback", {}).get("blockReason"):
            self.done = True
            self.result["stop"] = "error"
        for candidate in event.get("candidates", [])[:1]:
            for part in candidate.get("content", {}).get("parts", []):
                self.parts.append(part)
                if "text" in part:
                    await self.delta(part["text"], bool(part.get("thought")))
                if part.get("functionCall"):
                    c = part["functionCall"]
                    self.streamed = True
                    self.calls[len(self.calls)] = {
                        "id": c.get("id", "call_" + uuid.uuid4().hex),
                        "name": c["name"],
                        "arguments": c.get("args", {}),
                    }
            if candidate.get("finishReason"):
                self.done = True
                reason = candidate["finishReason"]
                self.result["stop"] = (
                    "length" if reason == "MAX_TOKENS" else ("stop" if reason == "STOP" else "error")
                )

    def finish(self):
        if not self.done:
            raise ProviderError("Provider stream ended before completion", retryable=True)
        calls = []
        if self.result["stop"] in ("stop", "length"):
            for index, c in self.calls.items():
                try:
                    arguments = (
                        json.loads(c["arguments"] or "{}")
                        if isinstance(c["arguments"], str)
                        else c["arguments"]
                    )
                    if not isinstance(arguments, dict) or not c["name"]:
                        raise ValueError
                except (ValueError, TypeError):
                    arguments = {}
                    c["name"] = c.get("name") or "unknown_tool"
                    c["argument_error"] = "Malformed JSON tool arguments; reissue a complete object."
                c["arguments"] = arguments
                c["id"] = call_id(c["id"] or "call_" + uuid.uuid4().hex)
                calls.append(c)
                if index in self.blocks:
                    self.blocks[index]["input"] = arguments
        self.result["calls"] = calls
        native = {}
        if self.reasoning:
            native["reasoning"] = self.reasoning
        if self.blocks:
            # Redacted blocks are opaque; signed thinking is replayed only to the same model.
            native["blocks"] = [
                b for _, b in sorted(self.blocks.items()) if b.get("type") != "thinking" or b.get("signature")
            ]
        if self.parts:
            native["parts"] = self.parts
        if native and self.result["stop"] == "stop":
            self.result["native"] = native
        return self.result


class Providers:
    def __init__(self, store, client=None):
        self.store = store
        self.owned = client is None
        self.client = client or httpx.AsyncClient(timeout=httpx.Timeout(300, connect=20))

    async def close(self):
        if self.owned:
            await self.client.aclose()

    async def stream(self, model, messages, system, tools, thinking, session_id, emit):
        provider = model["provider"]
        config = settings(self.store, provider)
        model = model | {k: config[k] for k in ("api", "base_url", "strict_tools") if k in config}
        state = _Response(model, emit)
        key = api_key(self.store, provider)
        headers = {
            "accept": "text/event-stream",
            **config.get("headers", {}),
            **model.get("headers", {}),
            **self.store.credential(provider).get("headers", {}),
        }
        try:
            if model["api"] == "codex":
                credential = await codex_credential(self.store, self.client)
                key = credential["access"]
                headers.update(
                    {
                        "Authorization": f"Bearer {key}",
                        "chatgpt-account-id": credential["accountId"],
                        "OpenAI-Beta": "responses=experimental",
                        "originator": "pi",
                        "session-id": session_id,
                    }
                )
            elif model["api"] == "anthropic":
                headers.update({"anthropic-version": "2023-06-01"})
                if key:
                    headers["x-api-key"] = key
            elif model["api"] == "google":
                if key:
                    headers["x-goog-api-key"] = key
            elif key:
                headers["Authorization"] = f"Bearer {key}"
            path, params, body = payload(model, messages, system, tools, thinking, session_id)
            sampling = {
                k: v
                for k, v in model.get("sampling", {}).items()
                if k in ("temperature", "top_p", "top_k", "presence_penalty", "frequency_penalty", "seed")
            }
            if model["api"] == "google":
                names = {
                    "top_p": "topP",
                    "top_k": "topK",
                    "presence_penalty": "presencePenalty",
                    "frequency_penalty": "frequencyPenalty",
                }
                body["generationConfig"].update({names.get(k, k): v for k, v in sampling.items()})
            else:
                if model["api"] in ("responses", "codex"):
                    sampling = {k: v for k, v in sampling.items() if k in ("temperature", "top_p")}
                elif model["api"] == "anthropic":
                    sampling = {k: v for k, v in sampling.items() if k in ("temperature", "top_p", "top_k")}
                body.update(sampling)
            body.update(config.get("body", {}))
            body.update(model.get("body", {}))
            url = model["base_url"].rstrip("/")
            if not url.endswith(path):
                url += path
            async with self.client.stream("POST", url, params=params, headers=headers, json=body) as response:
                if response.is_error:
                    raw = (await response.aread()).decode(errors="replace")
                    try:
                        error = json.loads(raw)
                        if isinstance(error, list) and error:
                            error = error[0]  # Gemini streams errors as a one-element array
                        error = error.get("error", raw) if isinstance(error, dict) else raw
                        message = error.get("message", str(error)) if isinstance(error, dict) else str(error)
                    except ValueError:
                        message = raw
                    message = (
                        self.store.redact(message).replace(key, "[redacted]")
                        if key
                        else self.store.redact(message)
                    )
                    retryable = response.status_code in (408, 409, 429, 500, 502, 503, 504, 529)
                    if re.search(
                        r"insufficient_quota|billing|monthly usage|available balance|out of budget", raw, re.I
                    ):
                        retryable = False
                    raise ProviderError(
                        f"{provider} ({response.status_code}): {message[:1000]}",
                        status=response.status_code,
                        retry_after=_retry_after(response.headers),
                        retryable=retryable,
                    )
                adapter = getattr(state, "responses" if model["api"] == "codex" else model["api"])
                async for event in sse_events(response):
                    if event.get("error") or event.get("type") == "error":
                        error = event.get("error") or {}
                        message = (
                            error.get("message", "Provider stream error")
                            if isinstance(error, dict)
                            else str(error)
                        )
                        message = self.store.redact(message)
                        if key:
                            message = message.replace(key, "[redacted]")
                        raise ProviderError(message, retryable=not state.streamed)
                    await adapter(event)
            return state.finish()
        except asyncio.CancelledError as exc:
            state.result["stop"] = "aborted"
            setattr(exc, "partial", state.result)  # noqa: B010
            raise
        except (ProviderError, AuthError, httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            state.result["stop"] = "error"
            if isinstance(exc, ProviderError):
                exc.partial = state.result
                exc.streamed = state.streamed
                raise
            text = self.store.redact(str(exc))
            if key:
                text = text.replace(key, "[redacted]")
            raise ProviderError(
                f"{provider}: {text}",
                retryable=isinstance(exc, httpx.TransportError),
                streamed=state.streamed,
                partial=state.result,
            ) from exc
