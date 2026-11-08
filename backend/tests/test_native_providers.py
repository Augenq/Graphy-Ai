"""Request serialization is exercised through the mandatory Rust binding."""

import copy
import hashlib
import json

import pytest
from reference_graphy import providers
from reference_graphy.styles import STYLE_HEADING

from graphy.native import invoke


@pytest.mark.parametrize("api", ["chat", "responses", "codex", "anthropic", "google"])
def test_native_history_encodes_unicode_arguments_and_preserves_call_links(api):
    identifier = "tool/id|кириллица"
    arguments = {"text": 'Ещё 😀 "quoted", colon: and \\slash', "nested": [True, None, {"n": 3}]}
    messages = [
        {"role": "assistant", "content": "", "calls": [
            {"id": identifier, "name": "read", "arguments": arguments},
        ]},
        {"role": "tool", "call_id": identifier, "name": "read", "content": "result"},
    ]
    model = {"api": api, "provider": "test", "id": "model"}
    history = invoke("providers.history", {"model": model, "messages": messages, "system": ""})
    expected_id = "call_" + hashlib.sha256(identifier.encode()).hexdigest()[:24]
    if api == "chat":
        call = history[0]["tool_calls"][0]
        assert json.loads(call["function"]["arguments"]) == arguments
        assert call["id"] == history[1]["tool_call_id"] == expected_id
    elif api in ("responses", "codex"):
        assert json.loads(history[0]["arguments"]) == arguments
        assert history[0]["call_id"] == history[1]["call_id"] == expected_id
    elif api == "anthropic":
        call = history[0]["content"][0]
        assert call["input"] == arguments
        assert call["id"] == history[1]["content"][0]["tool_use_id"] == expected_id
    else:
        call = history[0]["parts"][0]["functionCall"]
        assert call["args"] == arguments
        assert call["id"] == history[1]["parts"][0]["functionResponse"]["id"] == expected_id


def test_native_anthropic_cache_markers_and_strict_contract_do_not_mutate_inputs():
    model = {"api": "anthropic", "provider": "anthropic", "id": "claude-opus-4-6", "strict_tools": True}
    native = [{"type": "thinking", "thinking": "opaque", "signature": "signed"},
              {"type": "text", "text": "answer"}]
    messages = [{"role": "assistant", "content": "answer", "provider": "anthropic",
                 "model": "claude-opus-4-6", "native": {"blocks": native}}]
    tools = [{"name": "save", "description": "Save", "parameters": {
        "type": "object", "properties": {"optional": {"type": "string"}, "value": {"type": "integer"}},
        "required": ["value"],
    }}]
    before = copy.deepcopy((model, messages, tools))
    path, params, body = providers.payload(model, messages, "shared\x1c" + STYLE_HEADING + "style", tools, "off", "s")
    assert path == "/messages" and params == {}
    assert body["system"][0]["text"] == "shared"
    assert body["messages"][0]["content"][0]["signature"] == "signed"
    assert body["messages"][0]["content"][-1]["cache_control"] == {"type": "ephemeral"}
    schema = body["tools"][0]["input_schema"]
    assert schema["additionalProperties"] is False
    assert schema["properties"]["optional"]["anyOf"] == [{"type": "string"}, {"type": "null"}]
    assert (model, messages, tools) == before


def test_python_payload_delegates_to_native_and_translates_provider_errors(monkeypatch):
    operations = []
    real_invoke = providers.invoke

    def observe(operation, data):
        operations.append(operation)
        return real_invoke(operation, data)

    monkeypatch.setattr(providers, "invoke", observe)
    model = {"api": "chat", "provider": "test", "id": "text-model"}
    result = providers.payload(model, [{"role": "user", "content": "hello"}], "system", [], "off", "s")
    assert isinstance(result, tuple) and result[0] == "/chat/completions"
    assert operations == ["providers.payload"]
    with pytest.raises(providers.ProviderError, match="not configured for image input"):
        providers.payload(model, [{"role": "user", "images": [{"mime": "image/png", "data": "x"}]}], "", [], "off", "s")
    with pytest.raises(providers.ProviderError, match="Unsupported API protocol"):
        providers.payload(model | {"api": "unknown"}, [], "", [], "off", "s")


@pytest.mark.parametrize("value", ["simple", "bad/id", "🦀" * 100, "call_" + "x" * 80])
def test_native_mistral_ids_follow_nine_character_hash_contract(value):
    assert providers.call_id(value, "mistral") == hashlib.sha256(value.encode()).hexdigest()[:9]
