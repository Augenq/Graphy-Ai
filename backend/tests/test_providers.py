import asyncio
import json

import httpx
import pytest
from reference_graphy.models import PRESETS, Catalog
from reference_graphy.providers import ProviderError, Providers, call_id, payload
from reference_graphy.storage import Store

TOOL = {
    "name": "read",
    "description": "Read a file",
    "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
}


class Chunks(httpx.AsyncByteStream):
    def __init__(self, data, fail=False):
        self.data, self.fail = data, fail

    async def __aiter__(self):
        # Deliberately split Unicode, CRLF, and JSON boundaries.
        for index in range(0, len(self.data), 7):
            yield self.data[index : index + 7]
        if self.fail:
            raise httpx.ReadError("connection lost")


def events(*values, fail=False):
    data = "".join(
        "data: " + (v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)) + "\r\n\r\n"
        for v in values
    ).encode()
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=Chunks(data, fail))


def custom(tmp_path, api="chat"):
    store = Store(tmp_path)
    store.prefs["providers"] = {
        "test": {
            "api": api,
            "base_url": "http://local/v1",
            "models": [
                {
                    "id": "test-model",
                    "vision": True,
                    "reasoning": True,
                    "cost": {"input": 1, "output": 2, "cache_read": 0.1},
                }
            ],
        }
    }
    return store, Catalog(store).get("test/test-model")


async def run(store, model, response, messages=None, tools=None):
    requests, emitted = [], []

    async def transport(request):
        requests.append(request)
        return response

    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        result = await Providers(store, client).stream(
            model,
            messages or [{"role": "user", "content": "hi"}],
            "System",
            tools or [TOOL],
            "medium",
            "session-1",
            emitted.append,
        )
    return result, requests[0], emitted


async def test_chat_fragmented_multiple_tools_usage(tmp_path):
    store, model = custom(tmp_path)
    response = events(
        {"choices": [{"delta": {"content": "Привет", "reasoning_content": "Think"}}]},
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {"index": 0, "id": "call_1", "function": {"name": "read", "arguments": '{"pa'}},
                            {
                                "index": 1,
                                "id": "call_2",
                                "function": {"name": "read", "arguments": '{"path":"b"}'},
                            },
                        ]
                    }
                }
            ]
        },
        {
            "choices": [
                {
                    "delta": {"tool_calls": [{"index": 0, "function": {"arguments": 'th":"a"}'}}]},
                    "finish_reason": "tool_calls",
                }
            ]
        },
        {
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 20,
                "prompt_tokens_details": {"cached_tokens": 30},
            },
            "choices": [],
        },
        "[DONE]",
    )
    result, request, emitted = await run(store, model, response)
    assert result["content"] == "Привет" and result["thinking"] == "Think"
    assert [x["arguments"]["path"] for x in result["calls"]] == ["a", "b"]
    assert result["usage"] == {
        "input": 70,
        "output": 20,
        "cache_read": 30,
        "cache_write": 0,
        "cost": 0.000113,
    }
    assert len(emitted) == 2
    body = json.loads(request.content)
    assert body["tools"][0]["function"] == TOOL
    assert body["messages"][0]["role"] == "system"
    assert request.url.path == "/v1/chat/completions"


@pytest.mark.parametrize("api", ["responses", "codex"])
async def test_responses_tools_reasoning_and_complete(tmp_path, api):
    store, model = custom(tmp_path, api)
    # Use a custom 'codex' protocol preset with externally supplied valid credential.
    if api == "codex":
        store.set_credential(
            "openai-codex",
            {"access": "token", "refresh": "refresh", "expires": 9999999999, "accountId": "acct"},
        )
    reasoning = {"id": "rs_1", "type": "reasoning", "encrypted_content": "opaque", "summary": []}
    response = events(
        {"type": "response.output_text.delta", "delta": "Done"},
        {"type": "response.reasoning_summary_text.delta", "delta": "Reason"},
        {
            "type": "response.output_item.added",
            "output_index": 1,
            "item": {"type": "function_call", "call_id": "c1", "name": "read", "arguments": ""},
        },
        {"type": "response.function_call_arguments.delta", "output_index": 1, "delta": '{"path":"x"}'},
        {"type": "response.output_item.done", "output_index": 0, "item": reasoning},
        {
            "type": "response.completed",
            "response": {
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 50,
                    "input_tokens_details": {"cached_tokens": 25},
                }
            },
        },
    )
    result, request, _ = await run(store, model, response)
    assert result["calls"][0] == {"id": "c1", "name": "read", "arguments": {"path": "x"}}
    assert result["native"]["reasoning"] == [reasoning]
    assert result["usage"]["input"] == 75
    body = json.loads(request.content)
    assert body["store"] is False
    assert body["include"] == ["reasoning.encrypted_content"]
    assert body["tools"][0]["strict"] is False
    if api == "codex":
        assert request.headers["chatgpt-account-id"] == "acct"
        assert request.url.path == "/v1/codex/responses"
        assert "max_output_tokens" not in body


async def test_anthropic_blocks_signatures_cache_and_usage(tmp_path):
    store, model = custom(tmp_path, "anthropic")
    response = events(
        {
            "type": "message_start",
            "message": {
                "usage": {"input_tokens": 40, "cache_read_input_tokens": 10, "cache_creation_input_tokens": 5}
            },
        },
        {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}},
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "thinking_delta", "thinking": "reason"},
        },
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "signature_delta", "signature": "signed"},
        },
        {
            "type": "content_block_start",
            "index": 1,
            "content_block": {"type": "tool_use", "id": "toolu_a", "name": "read", "input": {}},
        },
        {
            "type": "content_block_delta",
            "index": 1,
            "delta": {"type": "input_json_delta", "partial_json": '{"path":"x"}'},
        },
        {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 30}},
        {"type": "message_stop"},
    )
    result, request, _ = await run(store, model, response)
    assert result["thinking"] == "reason"
    assert result["native"]["blocks"][0]["signature"] == "signed"
    assert result["native"]["blocks"][1]["input"] == {"path": "x"}
    assert result["usage"]["input"] == 40 and result["usage"]["cache_write"] == 5
    assert result["usage"]["cost"] is None  # No known cache-write price.
    body = json.loads(request.content)
    assert body["tools"][0]["input_schema"] == TOOL["parameters"]
    assert body["system"][0]["cache_control"]["type"] == "ephemeral"


async def test_google_signatures_and_calls(tmp_path):
    store, model = custom(tmp_path, "google")
    response = events(
        {"candidates": [{"content": {"parts": [{"text": "thinking", "thought": True}]}}]},
        {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {
                                "functionCall": {"name": "read", "args": {"path": "x"}},
                                "thoughtSignature": "signed",
                            }
                        ]
                    },
                    "finishReason": "STOP",
                }
            ],
            "usageMetadata": {
                "promptTokenCount": 80,
                "cachedContentTokenCount": 10,
                "candidatesTokenCount": 20,
                "thoughtsTokenCount": 5,
            },
        },
    )
    result, request, _ = await run(store, model, response)
    assert result["calls"][0]["arguments"] == {"path": "x"}
    assert result["native"]["parts"][1]["thoughtSignature"] == "signed"
    assert result["usage"]["input"] == 70 and result["usage"]["output"] == 25
    assert request.url.params["alt"] == "sse"


@pytest.mark.parametrize("api", ["chat", "responses", "anthropic", "google"])
def test_history_switch_strips_native_and_preserves_calls(tmp_path, api):
    store, model = custom(tmp_path, api)
    messages = [
        {"role": "user", "content": "look", "images": [{"mime": "image/png", "data": "AAAA"}]},
        {
            "role": "assistant",
            "content": "",
            "thinking": "secret reasoning",
            "provider": "old",
            "model": "old",
            "native": {
                "reasoning": [{"type": "reasoning", "encrypted_content": "old-secret"}],
                "blocks": [{"type": "thinking", "thinking": "old-secret", "signature": "old"}],
                "parts": [{"text": "old-secret", "thoughtSignature": "old"}],
            },
            "calls": [{"id": "a|invalid/id", "name": "read", "arguments": {"path": "a"}}],
        },
        {"role": "tool", "call_id": "a|invalid/id", "name": "read", "content": "file"},
    ]
    _, _, body = payload(model, messages, "sys", [TOOL], "off", "s")
    encoded = json.dumps(body)
    assert "old-secret" not in encoded and "secret reasoning" not in encoded
    assert call_id("a|invalid/id") in encoded
    assert "AAAA" in encoded
    assert "file" in encoded


async def test_disconnect_preserves_partial_and_does_not_mark_replay_safe(tmp_path):
    store, model = custom(tmp_path)
    response = events({"choices": [{"delta": {"content": "partial"}}]}, fail=True)
    with pytest.raises(ProviderError) as caught:
        await run(store, model, response)
    assert caught.value.streamed is True
    assert caught.value.partial["content"] == "partial"
    assert caught.value.partial["stop"] == "error"


async def test_missing_completion_is_error(tmp_path):
    store, model = custom(tmp_path)
    with pytest.raises(ProviderError, match="before completion"):
        await run(store, model, events({"choices": [{"delta": {"content": "partial"}}]}))


async def test_bad_arguments_are_never_returned_as_executable_calls(tmp_path):
    store, model = custom(tmp_path)
    result, _, _ = await run(
            store,
            model,
            events(
                {
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [
                                    {"index": 0, "function": {"name": "read", "arguments": "{bad"}}
                                ]
                            },
                            "finish_reason": "tool_calls",
                        }
                    ]
                }
            ),
    )
    assert result["calls"][0]["argument_error"]
    assert result["calls"][0]["arguments"] == {}


async def test_length_preserves_call_ids_for_agent_to_return_nonexecution_results(tmp_path):
    store, model = custom(tmp_path)
    result, _, _ = await run(
        store,
        model,
        events(
            {
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [{"index": 0, "function": {"name": "write", "arguments": "{bad"}}]
                        },
                        "finish_reason": "length",
                    }
                ]
            }
        ),
    )
    assert result["stop"] == "length"
    assert result["calls"][0]["name"] == "write"
    assert result["calls"][0]["arguments"] == {}
    assert result["calls"][0]["id"]
    assert "native" not in result


def test_free_router_keeps_provider_reasoning_default(tmp_path):
    # Live OpenRouter routing may select a model whose reasoning cannot be disabled.
    # An unknown/router model's default must not inject a disable flag.
    store = Store(tmp_path)
    model = Catalog(store).get("openrouter/openrouter/free")
    _, _, body = payload(model, [{"role": "user", "content": "hello"}], "system", [], "off", "session")
    assert "reasoning" not in body
    assert "reasoning_effort" not in body


async def test_error_retry_after_context_and_secret_redaction(tmp_path):
    store, model = custom(tmp_path)
    store.set_credential("test", {"key": "sensitive-api-key"})
    with pytest.raises(ProviderError) as caught:
        await run(
            store,
            model,
            httpx.Response(
                429, headers={"retry-after-ms": "1500"}, json={"error": {"message": "busy sensitive-api-key"}}
            ),
        )
    assert caught.value.retryable and caught.value.retry_after == 1.5
    assert "sensitive-api-key" not in str(caught.value)
    with pytest.raises(ProviderError) as caught:
        await run(store, model, httpx.Response(400, json={"error": {"message": "context_length_exceeded"}}))
    assert caught.value.context_overflow and not caught.value.retryable


async def test_cancelled_request_exposes_partial(tmp_path):
    store, model = custom(tmp_path)
    ready = asyncio.Event()

    class Hanging(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
            ready.set()
            await asyncio.Event().wait()

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, stream=Hanging()))
    ) as client:
        task = asyncio.create_task(
            Providers(store, client).stream(model, [], "", [], "off", "s", lambda e: None)
        )
        await ready.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError) as caught:
            await task
    assert caught.value.partial["content"] == "partial"
    assert caught.value.partial["stop"] == "aborted"


async def test_discovery_custom_private_headers_and_cache(tmp_path):
    store, _ = custom(tmp_path)
    store.set_credential("test", {"headers": {"X-Private": "secret"}})
    store.prefs["providers"]["test"]["models"] = ["manual"]
    seen = []

    def transport(request):
        seen.append(request)
        return httpx.Response(200, json={"data": [{"id": "discovered", "context_length": 8192}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        catalog = Catalog(store)
        await catalog.refresh("test", client)
    assert seen[0].headers["X-Private"] == "secret"
    assert catalog.get("test/discovered")["context"] == 8192
    assert catalog.get("test/manual")["metadata_estimated"]
    assert len(catalog.available()) == 2
    assert Catalog(store).get("test/discovered")["context"] == 8192
    assert catalog.get("test/arbitrary/id")["id"] == "arbitrary/id"


def test_snapshot_services_and_codex(tmp_path):
    store = Store(tmp_path)
    catalog = Catalog(store)
    hosted = set(PRESETS) - {"ollama", "lmstudio", "llama.cpp", "vllm", "sglang", "localai"}
    assert {x["provider"] for x in catalog.models} == hosted
    assert catalog.get("openai-codex/gpt-5.3-codex")["reasoning"]
    assert not catalog.get("openai-codex/gpt-5.3-codex")["metadata_estimated"]
    assert catalog.get("openai-codex/gpt-5.3-codex")["cost"] is None


async def test_no_vision_configuration_rejects_image(tmp_path):
    store, model = custom(tmp_path)
    model["vision"] = False
    with pytest.raises(ProviderError, match="image input"):
        await run(
            store,
            model,
            events("[DONE]"),
            messages=[{"role": "user", "content": "x", "images": [{"mime": "image/png", "data": "AAA"}]}],
        )


@pytest.mark.parametrize(
    "provider",
    ["openai", "anthropic", "google", "deepseek", "openrouter", "xai", "mistral", "groq", "together"],
)
async def test_all_hosted_presets_route_and_auth(tmp_path, provider, monkeypatch):
    store = Store(tmp_path)
    store.set_credential(provider, {"key": "preset-secret"})
    monkeypatch.delenv(PRESETS[provider][2], raising=False)
    catalog = Catalog(store)
    model = next(x for x in catalog.models if x["provider"] == provider)
    api = model["api"]
    if api == "chat":
        response = events({"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}]})
    elif api == "responses":
        response = events(
            {
                "type": "response.completed",
                "response": {
                    "output": [{"type": "message", "content": [{"type": "output_text", "text": "ok"}]}]
                },
            }
        )
    elif api == "anthropic":
        response = events(
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": "ok"}},
            {"type": "message_stop"},
        )
    else:
        response = events({"candidates": [{"content": {"parts": [{"text": "ok"}]}, "finishReason": "STOP"}]})
    result, request, _ = await run(store, model, response)
    assert result["content"] == "ok"
    header = {"anthropic": "x-api-key", "google": "x-goog-api-key"}.get(api, "authorization")
    assert "preset-secret" in request.headers[header]
    assert request.url.host == httpx.URL(PRESETS[provider][1]).host


@pytest.mark.parametrize("api", ["chat", "responses", "anthropic", "google"])
async def test_sampling_maps_fields_without_overriding_protocol(tmp_path, api):
    store, model = custom(tmp_path, api)
    model["sampling"] = {"temperature": 0.2, "top_p": 0.9, "model": "injected", "stream": False}
    response = {
        "chat": events("[DONE]"),
        "responses": events({"type": "response.completed"}),
        "anthropic": events({"type": "message_stop"}),
        "google": events({"candidates": [{"finishReason": "STOP"}]}),
    }[api]
    _, request, _ = await run(store, model, response)
    body = json.loads(request.content)
    params = body["generationConfig"] if api == "google" else body
    assert params["temperature"] == 0.2
    assert params["topP" if api == "google" else "top_p"] == 0.9
    if api != "google":
        assert body["stream"] is True and body["model"] == model["id"]


async def test_google_safety_and_max_tokens(tmp_path):
    store, model = custom(tmp_path, "google")
    result, _, _ = await run(store, model, events({"candidates": [{"finishReason": "MAX_TOKENS"}]}))
    assert result["stop"] == "length"
    result, _, _ = await run(store, model, events({"promptFeedback": {"blockReason": "SAFETY"}}))
    assert result["stop"] == "error"


async def test_stream_error_redacts_key(tmp_path, monkeypatch):
    store, model = custom(tmp_path)
    store.prefs["providers"]["test"]["env"] = "CUSTOM_API_KEY"
    monkeypatch.setenv("CUSTOM_API_KEY", "secret-from-env")
    with pytest.raises(ProviderError) as caught:
        await run(store, model, events({"error": {"message": "bad key secret-from-env"}}))
    assert "secret-from-env" not in str(caught.value)


async def test_anthropic_signed_reasoning_replays_only_to_same_model(tmp_path):
    store, model = custom(tmp_path, "anthropic")
    assistant = {
        "role": "assistant",
        "provider": "test",
        "model": "test-model",
        "content": "answer",
        "native": {
            "blocks": [
                {"type": "thinking", "thinking": "private", "signature": "sig"},
                {"type": "text", "text": "answer"},
            ]
        },
    }
    _, _, body = payload(model, [{"role": "user", "content": "hi"}, assistant], "sys", [], "off", "s")
    assert body["messages"][1]["content"][0]["signature"] == "sig"
    other = model | {"id": "different"}
    _, _, body = payload(other, [{"role": "user", "content": "hi"}, assistant], "sys", [], "off", "s")
    assert "private" not in json.dumps(body)


async def test_cost_uses_long_context_tier(tmp_path):
    store, model = custom(tmp_path)
    model["cost_tiers"] = [{"tier": {"size": 100}, "input": 2, "output": 4}]
    result, _, _ = await run(
        store,
        model,
        events(
            {
                "choices": [{"delta": {}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 200, "completion_tokens": 10},
            }
        ),
    )
    assert result["usage"]["cost"] == 0.00044


def test_mistral_tool_ids_are_nine_alphanumeric_characters_and_consistent(tmp_path):
    store = Store(tmp_path)
    model = Catalog(store).get("mistral/devstral-latest")
    messages = [
        {
            "role": "assistant",
            "content": "",
            "calls": [{"id": "call_long_original_1234", "name": "read", "arguments": {"path": "x"}}],
        },
        {"role": "tool", "call_id": "call_long_original_1234", "name": "read", "content": "text"},
    ]
    _, _, body = payload(model, messages, "sys", [TOOL], "off", "s")
    identifier = body["messages"][1]["tool_calls"][0]["id"]
    assert len(identifier) == 9 and identifier.isalnum()
    assert body["messages"][2]["tool_call_id"] == identifier


async def test_google_generated_call_ids_do_not_repeat_across_turns(tmp_path):
    store, model = custom(tmp_path, "google")
    identifiers = []
    for _ in range(2):
        result, _, _ = await run(
            store,
            model,
            events(
                {
                    "candidates": [
                        {
                            "content": {"parts": [{"functionCall": {"name": "read", "args": {"path": "x"}}}]},
                            "finishReason": "STOP",
                        }
                    ]
                }
            ),
        )
        identifiers.append(result["calls"][0]["id"])
    assert identifiers[0] != identifiers[1]


@pytest.mark.parametrize("autoload", [False, True])
async def test_llama_router_discovery_filters_states_and_preserves_metadata(tmp_path, autoload):
    store = Store(tmp_path)
    store.prefs["providers"] = {"llama.cpp": {"base_url": "http://router:8080"}}
    store.set_credential("llama.cpp", {"headers": {"X-Private": "secret"}})
    rows = [
        {
            "id": "loaded",
            "status": {"value": "loaded"},
            "meta": {"n_ctx": 8192, "n_ctx_train": 131072},
            "architecture": {"input_modalities": ["text", "image"], "output_modalities": ["text"]},
        },
        {
            "id": "sleeping",
            "status": {"value": "sleeping", "args": ["--ctx-size", "4096"]},
            "meta": {"n_ctx_train": 131072},
        },
        {"id": "preset", "status": {"value": "unloaded"}, "source": "preset"},
        {"id": "failed", "status": {"value": "unloaded", "failed": True}, "source": "preset"},
        {"id": "download", "status": {"value": "unloaded"}, "source": "download"},
        {
            "id": "decision",
            "status": {"value": "loaded"},
            "architecture": {"output_modalities": ["decisions"]},
        },
        {
            "id": "hybrid",
            "status": {"value": "loaded"},
            "architecture": {"output_modalities": ["text", "decisions"]},
        },
    ]
    requests = []

    def transport(request):
        requests.append(request)
        assert request.headers["X-Private"] == "secret"
        if request.url.path == "/models":
            return httpx.Response(200, json={"data": rows})
        if request.url.path == "/props" and not request.url.params:
            return httpx.Response(200, json={"models_autoload": autoload})
        if request.url.path == "/props":
            assert request.url.params["autoload"] == "false"
            return httpx.Response(200, json={"chat_template": "{% if enable_thinking %}..."})
        pytest.fail(f"Unexpected endpoint: {request.url}")

    catalog = Catalog(store)
    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        result = await catalog.refresh("llama.cpp", client)
    assert {x["id"] for x in result} == {"loaded", "sleeping", "hybrid"} | ({"preset"} if autoload else set())
    loaded = catalog.get("llama.cpp/loaded")
    assert loaded["base_url"] == "http://router:8080/v1"
    assert loaded["context"] == 8192 and loaded["vision"]
    assert loaded["reasoning"] and loaded["thinking_levels"] == ["off", "medium"]
    assert catalog.get("llama.cpp/sleeping")["context"] == 4096
    _, _, body = payload(loaded, [{"role": "user", "content": "hi"}], "sys", [TOOL], "medium", "s")
    assert body["chat_template_kwargs"]["enable_thinking"] is True
    assert "reasoning_effort" not in body


async def test_llama_single_model_falls_back_to_openai_discovery(tmp_path):
    store = Store(tmp_path)
    seen = []

    def transport(request):
        seen.append(request.url.path)
        return (
            httpx.Response(404)
            if request.url.path == "/models"
            else httpx.Response(200, json={"data": [{"id": "single"}]})
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        models = await Catalog(store).refresh("llama.cpp", client)
    assert models[0]["id"] == "single"
    assert seen == ["/models", "/v1/models", "/props"]


async def test_llama_single_model_thinking_switch_follows_chat_template(tmp_path):
    store = Store(tmp_path)
    store.prefs["providers"] = {"llama.cpp": {"base_url": "http://single:8080"}}

    def transport(request):
        if request.url.path == "/props":
            return httpx.Response(200, json={"chat_template": "{% if enable_thinking %}..."})
        if request.url.path == "/models":
            return httpx.Response(404)
        return httpx.Response(200, json={"data": [{"id": "single", "meta": {"n_ctx": 4096}}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        await Catalog(store).refresh("llama.cpp", client)
    model = Catalog(store).get("llama.cpp/single")
    assert model["reasoning"] and model["thinking_levels"] == ["off", "medium"]
    _, _, body = payload(model, [{"role": "user", "content": "hi"}], "sys", [], "off", "s")
    assert body["chat_template_kwargs"] == {"enable_thinking": False}


def test_openrouter_advertised_off_disables_optional_reasoning(tmp_path):
    store = Store(tmp_path)
    model = Catalog(store).get("openrouter/openai/gpt-5.6-luna")
    model = model | {"reasoning": True, "thinking_levels": ["off", "low", "high"]}
    _, _, body = payload(model, [{"role": "user", "content": "hi"}], "sys", [], "off", "s")
    assert body["reasoning"] == {"enabled": False}
    _, _, body = payload(model, [{"role": "user", "content": "hi"}], "sys", [], "low", "s")
    assert body["reasoning"] == {"effort": "low"}


def test_host_address_rewrites_only_loopback_for_sandbox():
    from reference_graphy.models import _host_address

    assert _host_address("http://127.0.0.1:8080/v1", "172.18.0.1") == "http://172.18.0.1:8080/v1"
    assert _host_address("http://localhost/v1", "172.18.0.1") == "http://172.18.0.1/v1"
    assert _host_address("https://api.example.com/v1", "172.18.0.1") == "https://api.example.com/v1"


async def test_llama_context_does_not_revert_to_training_size_when_unloaded(tmp_path):
    store = Store(tmp_path)
    store.prefs["providers"] = {"llama.cpp": {}}
    loaded = True

    def transport(request):
        if request.url.path == "/models":
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "model",
                            "status": {"value": "loaded" if loaded else "unloaded"},
                            "source": "preset",
                            "meta": {"n_ctx": 4096, "n_ctx_train": 131072}
                            if loaded
                            else {"n_ctx_train": 131072},
                        }
                    ]
                },
            )
        return httpx.Response(200, json={"models_autoload": True})

    catalog = Catalog(store)
    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        await catalog.refresh("llama.cpp", client)
        loaded = False
        await catalog.refresh("llama.cpp", client)
    assert catalog.get("llama.cpp/model")["context"] == 4096


@pytest.mark.parametrize("value", ["null", "[]", '"text"'])
async def test_malformed_sse_objects_raise_provider_error(tmp_path, value):
    store, model = custom(tmp_path)
    with pytest.raises(ProviderError, match="Invalid SSE event object"):
        await run(store, model, events(value))


def chat_events(*deltas, usage=None):
    """A chat stream whose last chunk finishes the turn; deltas are the `delta` objects of choice 0."""
    chunks = [{"choices": [{"index": 0, "delta": delta}]} for delta in deltas]
    chunks[-1]["choices"][0]["finish_reason"] = "stop"
    if usage is not None:
        chunks.append({"choices": [], "usage": usage})
    return events(*chunks, "[DONE]")


def test_anthropic_tool_result_without_output_is_never_an_empty_text_block(tmp_path):
    store, model = custom(tmp_path, "anthropic")

    def results(content, images=()):
        messages = [
            {"role": "user", "content": "run it"},
            {"role": "assistant", "content": "", "calls": [{"id": "c1", "name": "bash", "arguments": {}}]},
            {"role": "tool", "call_id": "c1", "name": "bash", "content": content, "images": list(images)},
        ]
        _, _, body = payload(model, messages, "sys", [TOOL], "off", "s")
        return body["messages"][-1]["content"][0]["content"]

    # `mkdir x` prints nothing; the API answers 400 to {"type": "text", "text": ""}.
    assert results("") == [{"type": "text", "text": "(no output)"}]
    assert results("done") == [{"type": "text", "text": "done"}]
    only_image = results("", [{"mime": "image/png", "data": "AAAA"}])
    assert [block["type"] for block in only_image] == ["image"]


@pytest.mark.parametrize(
    ("model_id", "adaptive"),
    [
        ("claude-haiku-4-5", False),
        ("claude-haiku-4-5-20251001", False),
        ("claude-sonnet-4-5-20250929", False),
        ("claude-opus-4-1-20250805", False),
        ("claude-sonnet-4-20250514", False),
        ("claude-3-7-sonnet-20250219", False),
        ("claude-3-5-sonnet-latest", False),
        ("claude-sonnet-4-6", True),
        ("claude-opus-4-6-20260101", True),
        ("claude-opus-4-7", True),
        ("claude-opus-5-5", True),
        ("claude-fable-5-1", True),
        ("anthropic/claude-opus-4.6", True),
        ("anthropic/claude-sonnet-4.5", False),
    ],
)
def test_adaptive_thinking_starts_with_claude_4_6_not_with_every_id_containing_dash_5(
    tmp_path, model_id, adaptive
):
    store, model = custom(tmp_path, "anthropic")
    _, _, body = payload(model | {"id": model_id}, [{"role": "user", "content": "hi"}], "sys", [], "high", "s")
    if adaptive:
        assert body["thinking"] == {"type": "adaptive"}
        assert body["output_config"] == {"effort": "high"}
    else:
        assert body["thinking"]["type"] == "enabled" and body["thinking"]["budget_tokens"] > 0
        assert "output_config" not in body


async def test_chat_stream_tolerates_null_fields_of_openai_compatible_servers(tmp_path):
    store, model = custom(tmp_path)
    response = events(
        {"choices": None},
        {"choices": [{"index": 0, "delta": None}]},
        {"choices": [{"index": 0, "delta": {"role": "assistant", "content": "Hi", "tool_calls": None}}]},
        {"choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "id": "c", "function": None}]}}]},
        {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
        {"choices": [], "usage": {"prompt_tokens": 12, "completion_tokens": 3, "prompt_tokens_details": None,
                                  "prompt_cache_hit_tokens": None}},
        "[DONE]",
    )
    result, _, _ = await run(store, model, response)
    assert result["content"] == "Hi"
    assert (result["usage"]["input"], result["usage"]["output"], result["usage"]["cache_read"]) == (12, 3, 0)


async def test_chat_usage_with_null_counters_does_not_fail_the_turn(tmp_path):
    store, model = custom(tmp_path)
    result, _, _ = await run(store, model, chat_events(
        {"content": "ok"}, usage={"prompt_tokens": None, "completion_tokens": None}))
    assert result["content"] == "ok" and result["usage"]["input"] == 0


async def test_chat_tool_calls_without_index_are_not_glued_together(tmp_path):
    store, model = custom(tmp_path)
    response = events(
        {"choices": [{"delta": {"tool_calls": [{"id": "call_a", "function": {"name": "read", "arguments": '{"path":'}}]}}]},
        {"choices": [{"delta": {"tool_calls": [{"function": {"arguments": '"a.txt"}'}}]}}]},
        {"choices": [{"delta": {"tool_calls": [
            {"id": "call_b", "function": {"name": "read", "arguments": '{"path":"b.txt"}'}}]},
            "finish_reason": "tool_calls"}]},
        "[DONE]",
    )
    result, _, _ = await run(store, model, response)
    assert [(c["id"], c["name"], c["arguments"]) for c in result["calls"]] == [
        ("call_a", "read", {"path": "a.txt"}), ("call_b", "read", {"path": "b.txt"})]


async def test_chat_tool_calls_with_index_still_merge_fragments(tmp_path):
    store, model = custom(tmp_path)
    response = events(
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "a", "function": {"name": "read", "arguments": '{"pa'}}]}}]},
        {"choices": [{"delta": {"tool_calls": [{"index": 1, "id": "b", "function": {"name": "read", "arguments": "{}"}}]}}]},
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": 'th":"x"}'}}]},
                      "finish_reason": "tool_calls"}]},
        "[DONE]",
    )
    result, _, _ = await run(store, model, response)
    assert [(c["id"], c["arguments"]) for c in result["calls"]] == [("a", {"path": "x"}), ("b", {})]


async def test_gemini_http_error_arrives_as_json_array_and_stays_retryable(tmp_path):
    store, model = custom(tmp_path, "google")
    store.set_credential("test", {"key": "sensitive-api-key"})
    body = [{"error": {"code": 429, "message": "Quota exceeded for sensitive-api-key", "status": "RESOURCE_EXHAUSTED"}}]
    with pytest.raises(ProviderError) as caught:
        await run(store, model, httpx.Response(429, headers={"retry-after": "3"}, json=body))
    error = caught.value
    assert (error.status, error.retryable, error.retry_after) == (429, True, 3)
    assert "Quota exceeded" in str(error) and "sensitive-api-key" not in str(error)


@pytest.mark.parametrize("raw", ["[]", '"just text"', "null", "<html>502</html>"])
async def test_unusual_error_bodies_become_provider_errors(tmp_path, raw):
    store, model = custom(tmp_path)
    with pytest.raises(ProviderError) as caught:
        await run(store, model, httpx.Response(502, text=raw))
    assert caught.value.status == 502 and caught.value.retryable


async def test_discovery_ignores_sentinel_and_malformed_prices(tmp_path):
    store, _ = custom(tmp_path)
    rows = [{"id": "router", "pricing": {"prompt": "-1", "completion": "-1"}},
            {"id": "broken", "pricing": {"prompt": "free", "completion": None}},
            {"id": "paid", "pricing": {"prompt": "0.000002", "completion": "0.00001"}}]
    async with httpx.AsyncClient(transport=httpx.MockTransport(
            lambda r: httpx.Response(200, json={"data": rows}))) as client:
        catalog = Catalog(store)
        await catalog.refresh("test", client)
    assert catalog.get("test/router")["cost"] == {}
    assert catalog.get("test/broken")["cost"] == {}
    assert catalog.get("test/paid")["cost"] == {"input": pytest.approx(2.0), "output": pytest.approx(10.0)}


async def test_discovery_stops_when_a_server_repeats_its_page_cursor(tmp_path):
    store, _ = custom(tmp_path)
    requests = []

    def transport(request):
        requests.append(request)
        return httpx.Response(200, json={"data": [{"id": "m1"}], "has_more": True, "last_id": "same"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        catalog = Catalog(store)
        await asyncio.wait_for(catalog.refresh("test", client), 5)
    assert len(requests) == 2  # the first page and one page for the cursor; the repeat ends the loop
    assert catalog.get("test/m1")["id"] == "m1"


def test_style_switch_keeps_anthropic_shared_cache_prefix(session, tmp_path):
    from reference_graphy.context import system_prompt
    from reference_graphy.providers import payload
    from reference_graphy.storage import Store

    class Tools:
        store = Store(tmp_path / 'prefs')

    model = {'api': 'anthropic', 'provider': 'anthropic', 'id': 'claude-sonnet-4-6', 'max_output': 1024}
    messages = [{'role': 'user', 'content': 'Explain a matrix.'}]
    first = payload(model, messages, system_prompt(session, Tools()), [TOOL], 'off', session.id)[2]
    session.append('explanation_style', explanation_style='quick_take')
    second = payload(model, messages, system_prompt(session, Tools()), [TOOL], 'off', session.id)[2]
    assert first['system'][0] == second['system'][0]
    assert first['system'][1] != second['system'][1]
    assert 'Quick Take' in second['system'][1]['text']
    assert all(block['cache_control'] == {'type': 'ephemeral'} for block in second['system'])
    assert json.dumps(second).count('cache_control') == 4


async def test_discovery_uses_the_completion_limit_so_a_reasoning_model_can_finish_a_lesson(tmp_path):
    store, _ = custom(tmp_path)
    rows = [{"id": "big", "top_provider": {"max_completion_tokens": 65536}},
            {"id": "unknown", "top_provider": {"max_completion_tokens": None}}, {"id": "bare"}]
    async with httpx.AsyncClient(transport=httpx.MockTransport(
            lambda r: httpx.Response(200, json={"data": rows}))) as client:
        catalog = Catalog(store)
        await catalog.refresh("test", client)
    assert catalog.get("test/big")["max_output"] == 65536
    assert catalog.get("test/unknown")["max_output"] == 4096 == catalog.get("test/bare")["max_output"]


def test_discovery_reads_reasoning_levels_from_openrouter_rows():
    from reference_graphy.models import _reasoning_levels

    luna = {"reasoning": {"mandatory": False, "supported_efforts": ["max", "xhigh", "high", "medium", "low", "none"]}}
    assert _reasoning_levels(luna) == ["off", "low", "medium", "high", "xhigh", "max"]
    assert _reasoning_levels({"reasoning": {"mandatory": True, "supported_efforts": ["high", "low"]}}) == ["low", "high"]
    assert _reasoning_levels({"supported_parameters": ["tools", "reasoning"]}) == ["off", "medium"]
    assert _reasoning_levels({"supported_parameters": ["tools"]}) is None
    assert _reasoning_levels({"reasoning": {"supported_efforts": ["high"]}}) == ["off", "high"]
