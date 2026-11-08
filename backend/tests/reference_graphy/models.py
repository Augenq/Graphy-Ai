"""Small offline model snapshot plus explicit endpoint discovery (no background calls)."""

import math
import os
from urllib.parse import urlsplit, urlunsplit

import httpx

from .storage import read_json, write_json

# APIs describe wire protocols; service presets only supply URL and key environment variables.
PRESETS = {
    "openai": ("responses", "https://api.openai.com/v1", "OPENAI_API_KEY"),
    "openai-codex": ("codex", "https://chatgpt.com/backend-api", ""),
    "anthropic": ("anthropic", "https://api.anthropic.com/v1", "ANTHROPIC_API_KEY"),
    "google": ("google", "https://generativelanguage.googleapis.com/v1beta", "GEMINI_API_KEY"),
    "deepseek": ("chat", "https://api.deepseek.com", "DEEPSEEK_API_KEY"),
    "openrouter": ("chat", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
    "xai": ("responses", "https://api.x.ai/v1", "XAI_API_KEY"),
    "mistral": ("chat", "https://api.mistral.ai/v1", "MISTRAL_API_KEY"),
    "groq": ("chat", "https://api.groq.com/openai/v1", "GROQ_API_KEY"),
    "together": ("chat", "https://api.together.ai/v1", "TOGETHER_API_KEY"),
    "ollama": ("chat", "http://localhost:11434/v1", ""),
    "lmstudio": ("chat", "http://localhost:1234/v1", ""),
    "llama.cpp": ("chat", "http://localhost:8080/v1", "LLAMA_API_KEY"),
    "vllm": ("chat", "http://localhost:8000/v1", ""),
    "sglang": ("chat", "http://localhost:30000/v1", ""),
    "localai": ("chat", "http://localhost:8080/v1", ""),
}
API_ALIASES = {
    "openai-completions": "chat",
    "openai-responses": "responses",
    "anthropic-messages": "anthropic",
    "google-generative-ai": "google",
    "openai-codex-responses": "codex",
}
LOCAL = {"ollama", "lmstudio", "llama.cpp", "vllm", "sglang", "localai"}


def _host_address(url: str, gateway: str) -> str:
    parsed = urlsplit(url)
    if parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        return url
    return urlunsplit(parsed._replace(netloc=f"{gateway}:{parsed.port}" if parsed.port else gateway))


def settings(store, provider: str) -> dict:
    api, url, env = PRESETS.get(provider, ("chat", "", ""))
    value = {"api": api, "base_url": url, "env": env}
    value.update(store.prefs.get("providers", {}).get(provider, {}))
    if provider == "llama.cpp":
        value["base_url"] = os.environ.get("LLAMA_BASE_URL") or value["base_url"]
        value["base_url"] = value["base_url"].rstrip("/")
        if not value["base_url"].endswith("/v1"):
            value["base_url"] += "/v1"
    gateway = os.environ.get("GRAPHY_HOST_GATEWAY")
    if provider in LOCAL and gateway and value.get("base_url"):
        # Inside the sandbox 127.0.0.1 is the container itself; the host's servers are reached via its gateway.
        value["base_url"] = _host_address(value["base_url"], gateway)
    value["api"] = API_ALIASES.get(value["api"], value["api"])
    if not value.get("base_url"):
        raise ValueError(f"Configure a base_url for provider {provider}")
    return value


def api_key(store, provider: str) -> str:
    config = settings(store, provider)
    env = config.get("env") or config.get("api_key_env")
    credential = store.credential(provider)
    return (os.environ.get(env, "") if env else "") or credential.get("key", "")


# Curated models.dev snapshot 1dfa7fe16479961030f1a8f056d2c0d4afe9bc49, 2026-10-17.
# Generated from provider/base-model TOML; USD per million tokens. No claim of live availability.
SNAPSHOT = [
    {
        "provider": "openai",
        "id": "gpt-5.4",
        "name": "GPT-5.4",
        "context": 1050000,
        "max_output": 128000,
        "vision": True,
        "tools": True,
        "reasoning": True,
        "thinking_levels": ["off", "low", "medium", "high", "xhigh"],
        "thinking_map": {"off": "none"},
        "cost_tiers": [{"tier": {"size": 272000}, "input": 5.0, "output": 22.5, "cache_read": 0.5}],
        "cost": {"input": 2.5, "output": 15.0, "cache_read": 0.25},
        "metadata_estimated": False,
    },
    {
        "provider": "openai",
        "id": "gpt-5.4-mini",
        "name": "GPT-5.4 mini",
        "context": 400000,
        "max_output": 128000,
        "vision": True,
        "tools": True,
        "reasoning": True,
        "thinking_levels": ["off", "low", "medium", "high", "xhigh"],
        "thinking_map": {"off": "none"},
        "cost_tiers": [],
        "cost": {"input": 0.75, "output": 4.5, "cache_read": 0.075},
        "metadata_estimated": False,
    },
    {
        "provider": "openai",
        "id": "gpt-5.3-codex",
        "name": "GPT-5.3 Codex",
        "context": 400000,
        "max_output": 128000,
        "vision": True,
        "tools": True,
        "reasoning": True,
        "thinking_levels": ["off", "low", "medium", "high", "xhigh"],
        "thinking_map": {"off": "none"},
        "cost_tiers": [],
        "cost": {"input": 1.75, "output": 14.0, "cache_read": 0.175},
        "metadata_estimated": False,
    },
    {
        "provider": "openai",
        "id": "gpt-4.1",
        "name": "GPT-4.1",
        "context": 1047576,
        "max_output": 32768,
        "vision": True,
        "tools": True,
        "reasoning": False,
        "thinking_levels": ["off"],
        "thinking_map": {},
        "cost_tiers": [],
        "cost": {"input": 2.0, "output": 8.0, "cache_read": 0.5},
        "metadata_estimated": False,
    },
    {
        "provider": "openai-codex",
        "id": "gpt-5.3-codex",
        "name": "GPT-5.3 Codex",
        "context": 400000,
        "max_output": 128000,
        "vision": True,
        "tools": True,
        "reasoning": True,
        "thinking_levels": ["off", "low", "medium", "high", "xhigh"],
        "thinking_map": {"off": "none"},
        "cost_tiers": [],
        "cost": None,
        "metadata_estimated": False,
    },
    {
        "provider": "openai-codex",
        "id": "gpt-5.4",
        "name": "GPT-5.4",
        "context": 1050000,
        "max_output": 128000,
        "vision": True,
        "tools": True,
        "reasoning": True,
        "thinking_levels": ["off", "low", "medium", "high", "xhigh"],
        "thinking_map": {"off": "none"},
        "cost_tiers": [],
        "cost": None,
        "metadata_estimated": False,
    },
    {
        "provider": "openai-codex",
        "id": "gpt-5.2",
        "name": "GPT-5.2",
        "context": 400000,
        "max_output": 128000,
        "vision": True,
        "tools": True,
        "reasoning": True,
        "thinking_levels": ["off", "low", "medium", "high", "xhigh"],
        "thinking_map": {"off": "none"},
        "cost_tiers": [],
        "cost": None,
        "metadata_estimated": False,
    },
    {
        "provider": "anthropic",
        "id": "claude-sonnet-4-6",
        "name": "Claude Sonnet 4.6",
        "context": 1000000,
        "max_output": 128000,
        "vision": True,
        "tools": True,
        "reasoning": True,
        "thinking_levels": ["off", "low", "medium", "high", "max"],
        "thinking_map": {},
        "cost_tiers": [],
        "cost": {"input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75},
        "metadata_estimated": False,
    },
    {
        "provider": "anthropic",
        "id": "claude-opus-4-6",
        "name": "Claude Opus 4.6",
        "context": 1000000,
        "max_output": 128000,
        "vision": True,
        "tools": True,
        "reasoning": True,
        "thinking_levels": ["off", "low", "medium", "high", "max"],
        "thinking_map": {},
        "cost_tiers": [],
        "cost": {"input": 5, "output": 25, "cache_read": 0.5, "cache_write": 6.25},
        "metadata_estimated": False,
    },
    {
        "provider": "anthropic",
        "id": "claude-haiku-4-5",
        "name": "Claude Haiku 4.5 (latest)",
        "context": 200000,
        "max_output": 64000,
        "vision": True,
        "tools": True,
        "reasoning": True,
        "thinking_levels": ["off", "low", "medium", "high"],
        "thinking_map": {},
        "cost_tiers": [],
        "cost": {"input": 1, "output": 5, "cache_read": 0.1, "cache_write": 1.25},
        "metadata_estimated": False,
    },
    {
        "provider": "google",
        "id": "gemini-3.1-pro-preview",
        "name": "Gemini 3.1 Pro Preview",
        "context": 1048576,
        "max_output": 65536,
        "vision": True,
        "tools": True,
        "reasoning": True,
        "thinking_levels": ["off", "low", "medium", "high"],
        "thinking_map": {},
        "cost_tiers": [{"tier": {"size": 200000}, "input": 4.0, "output": 18.0, "cache_read": 0.4}],
        "cost": {"input": 2.0, "output": 12.0, "cache_read": 0.2},
        "metadata_estimated": False,
    },
    {
        "provider": "google",
        "id": "gemini-3-flash-preview",
        "name": "Gemini 3 Flash Preview",
        "context": 1048576,
        "max_output": 65536,
        "vision": True,
        "tools": True,
        "reasoning": True,
        "thinking_levels": ["off", "minimal", "low", "medium", "high"],
        "thinking_map": {},
        "cost_tiers": [],
        "cost": {"input": 0.5, "output": 3.0, "cache_read": 0.05},
        "metadata_estimated": False,
    },
    {
        "provider": "google",
        "id": "gemini-2.5-pro",
        "name": "Gemini 2.5 Pro",
        "context": 1048576,
        "max_output": 65536,
        "vision": True,
        "tools": True,
        "reasoning": True,
        "thinking_levels": ["off", "low", "medium", "high"],
        "thinking_map": {},
        "cost_tiers": [{"tier": {"size": 200000}, "input": 2.5, "output": 15.0, "cache_read": 0.25}],
        "cost": {"input": 1.25, "output": 10.0, "cache_read": 0.125},
        "metadata_estimated": False,
    },
    {
        "provider": "google",
        "id": "gemini-2.5-flash",
        "name": "Gemini 2.5 Flash",
        "context": 1048576,
        "max_output": 65536,
        "vision": True,
        "tools": True,
        "reasoning": True,
        "thinking_levels": ["off", "low", "medium", "high"],
        "thinking_map": {},
        "cost_tiers": [],
        "cost": {"input": 0.3, "output": 2.5, "cache_read": 0.03},
        "metadata_estimated": False,
    },
    {
        "provider": "deepseek",
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "context": 1000000,
        "max_output": 393216,
        "vision": False,
        "tools": True,
        "reasoning": True,
        "thinking_levels": ["off", "low", "high", "max"],
        "thinking_map": {},
        "cost_tiers": [],
        "cost": {"input": 0.66, "output": 1.98, "cache_read": 0.022},
        "metadata_estimated": False,
    },
    {
        "provider": "deepseek",
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash",
        "context": 1000000,
        "max_output": 393216,
        "vision": True,
        "tools": True,
        "reasoning": True,
        "thinking_levels": ["off", "low", "high", "max"],
        "thinking_map": {},
        "cost_tiers": [],
        "cost": {"input": 0.15, "output": 0.6, "cache_read": 0.003},
        "metadata_estimated": False,
    },
    {
        "provider": "openrouter",
        "id": "anthropic/claude-sonnet-4.6",
        "name": "Claude Sonnet 4.6",
        "context": 1000000,
        "max_output": 128000,
        "vision": True,
        "tools": True,
        "reasoning": True,
        "thinking_levels": ["off", "low", "medium", "high", "max"],
        "thinking_map": {"off": "none"},
        "cost_tiers": [
            {
                "tier": {"type": "context", "size": 200000},
                "input": 6,
                "output": 22.5,
                "cache_read": 0.6,
                "cache_write": 7.5,
            }
        ],
        "cost": {"input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75},
        "metadata_estimated": False,
    },
    {
        "provider": "openrouter",
        "id": "openai/gpt-5.4",
        "name": "GPT-5.4",
        "context": 1050000,
        "max_output": 128000,
        "vision": True,
        "tools": True,
        "reasoning": True,
        "thinking_levels": ["off", "low", "medium", "high", "xhigh"],
        "thinking_map": {"off": "none"},
        "cost_tiers": [
            {"tier": {"type": "context", "size": 272000}, "input": 5, "output": 22.5, "cache_read": 0.5}
        ],
        "cost": {"input": 2.5, "output": 15, "cache_read": 0.25},
        "metadata_estimated": False,
    },
    {
        "provider": "openrouter",
        "id": "deepseek/deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "context": 1048576,
        "max_output": 384000,
        "vision": False,
        "tools": True,
        "reasoning": True,
        "thinking_levels": ["off", "high", "xhigh"],
        "thinking_map": {"off": "none"},
        "cost_tiers": [],
        "cost": {"input": 0.2088, "output": 0.4176, "cache_read": 0.0174},
        "metadata_estimated": False,
    },
    {
        "provider": "xai",
        "id": "grok-4.3",
        "name": "Grok 4.3",
        "context": 1000000,
        "max_output": 30000,
        "vision": True,
        "tools": True,
        "reasoning": True,
        "thinking_levels": ["off", "low", "medium", "high"],
        "thinking_map": {"off": "none"},
        "cost_tiers": [{"tier": {"size": 200000}, "input": 2.5, "output": 5, "cache_read": 0.4}],
        "cost": {"input": 1.25, "output": 2.5, "cache_read": 0.2},
        "metadata_estimated": False,
    },
    {
        "provider": "xai",
        "id": "grok-4.20-0309-reasoning",
        "name": "Grok 4.20 (Reasoning)",
        "context": 1000000,
        "max_output": 30000,
        "vision": True,
        "tools": True,
        "reasoning": True,
        "thinking_levels": ["off", "low", "medium", "high"],
        "thinking_map": {},
        "cost_tiers": [{"tier": {"size": 200000}, "input": 2.5, "output": 5, "cache_read": 0.4}],
        "cost": {"input": 1.25, "output": 2.5, "cache_read": 0.2},
        "metadata_estimated": False,
    },
    {
        "provider": "mistral",
        "id": "mistral-large-latest",
        "name": "Mistral Large (latest)",
        "context": 262144,
        "max_output": 262144,
        "vision": True,
        "tools": True,
        "reasoning": False,
        "thinking_levels": ["off"],
        "thinking_map": {},
        "cost_tiers": [],
        "cost": {"input": 0.5, "cache_read": 0.05, "output": 1.5},
        "metadata_estimated": False,
    },
    {
        "provider": "mistral",
        "id": "mistral-small-latest",
        "name": "Mistral Small (latest)",
        "context": 262144,
        "max_output": 256000,
        "vision": True,
        "tools": True,
        "reasoning": True,
        "thinking_levels": ["off", "high"],
        "thinking_map": {"off": "none"},
        "cost_tiers": [],
        "cost": {"input": 0.15, "output": 0.6, "cache_read": 0.015},
        "metadata_estimated": False,
    },
    {
        "provider": "mistral",
        "id": "devstral-latest",
        "name": "Devstral 2",
        "context": 262144,
        "max_output": 262144,
        "vision": False,
        "tools": True,
        "reasoning": False,
        "thinking_levels": ["off"],
        "thinking_map": {},
        "cost_tiers": [],
        "cost": {"input": 0.4, "output": 2.0},
        "metadata_estimated": False,
    },
    {
        "provider": "groq",
        "id": "llama-3.3-70b-versatile",
        "name": "Llama 3.3 70B",
        "context": 131072,
        "max_output": 32768,
        "vision": False,
        "tools": True,
        "reasoning": False,
        "thinking_levels": ["off"],
        "thinking_map": {},
        "cost_tiers": [],
        "cost": {"input": 0.59, "output": 0.79},
        "metadata_estimated": False,
    },
    {
        "provider": "groq",
        "id": "openai/gpt-oss-120b",
        "name": "GPT OSS 120B",
        "context": 131072,
        "max_output": 65536,
        "vision": False,
        "tools": True,
        "reasoning": True,
        "thinking_levels": ["off", "low", "medium", "high"],
        "thinking_map": {},
        "cost_tiers": [],
        "cost": {"input": 0.15, "output": 0.6, "cache_read": 0.075},
        "metadata_estimated": False,
    },
    {
        "provider": "together",
        "id": "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        "name": "Llama 3.3 70B",
        "context": 131072,
        "max_output": 131072,
        "vision": False,
        "tools": True,
        "reasoning": False,
        "thinking_levels": ["off"],
        "thinking_map": {},
        "cost_tiers": [],
        "cost": {"input": 1.04, "output": 1.04},
        "metadata_estimated": False,
    },
    {
        "provider": "together",
        "id": "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
        "name": "Qwen3 Coder 480B A35B Instruct",
        "context": 262144,
        "max_output": 262144,
        "vision": False,
        "tools": True,
        "reasoning": False,
        "thinking_levels": ["off"],
        "thinking_map": {},
        "cost_tiers": [],
        "cost": {"input": 2, "output": 2},
        "metadata_estimated": False,
    },
]


LEVEL_ORDER = ("off", "minimal", "low", "medium", "high", "xhigh", "max")


def _reasoning_levels(row):
    """Thinking levels a discovery row advertises (OpenRouter `reasoning.supported_efforts`), or None when it says nothing."""
    info = row.get("reasoning")
    efforts = info.get("supported_efforts") if isinstance(info, dict) else None
    if not isinstance(efforts, list):
        return ["off", "medium"] if "reasoning" in (row.get("supported_parameters") or []) else None
    levels = {"off" if x == "none" else x for x in efforts if isinstance(x, str)}
    if not (info.get("mandatory") or "off" in levels):
        levels.add("off")
    ordered = [x for x in LEVEL_ORDER if x in levels]
    return ordered if len(ordered) > 1 else None


def _rate(value):
    """A per-token price, or None for absent, malformed and sentinel values (OpenRouter routers report "-1")."""
    try:
        rate = float(value)
    except (TypeError, ValueError):
        return None
    return rate if math.isfinite(rate) and rate >= 0 else None


class Catalog:
    def __init__(self, store):
        self.store = store
        self.cache = read_json(store.root / "models.json", {})
        self.models = []
        self._rebuild()

    def _model(self, provider, item):
        config = settings(self.store, provider)
        value = {
            "provider": provider,
            "api": config["api"],
            "base_url": config["base_url"],
            "context": 32768,
            "max_output": 4096,
            "vision": False,
            "tools": True,
            "reasoning": False,
            "thinking_levels": ["off"],
            "cost": None,
            "metadata_estimated": True,
        }
        value.update(item)
        value["provider"] = provider
        value["name"] = value.get("name", value["id"])
        return value

    def _rebuild(self):
        values = {(x["provider"], x["id"]): self._model(x["provider"], x) for x in SNAPSHOT}
        for provider, items in self.cache.items():
            for item in items:
                values[provider, item["id"]] = self._model(provider, item)
        for provider, config in self.store.prefs.get("providers", {}).items():
            models = config.get("models", [])
            if isinstance(models, dict):
                models = [dict(v, id=k) for k, v in models.items()]
            for item in models:
                item = {"id": item} if isinstance(item, str) else item
                base = values.get((provider, item["id"]), {})
                values[provider, item["id"]] = self._model(provider, base | item)
        self.models = sorted(values.values(), key=lambda x: (x["provider"], x["name"]))

    def get(self, identifier: str) -> dict:
        provider, sep, name = identifier.partition("/")
        if not sep or not name:
            raise ValueError("Use provider/model-id")
        for model in self.models:
            if model["provider"] == provider and model["id"] == name:
                # Endpoints can be edited while a Catalog is open.
                return model | {k: settings(self.store, provider)[k] for k in ("api", "base_url")}
        # Arbitrary IDs remain possible even when a service has no discovery API.
        return self._model(provider, {"id": name})

    def available(self) -> list:
        def enabled(provider):
            return (
                (provider == "llama.cpp" and bool(os.environ.get("LLAMA_BASE_URL")))
                or (
                    provider in LOCAL
                    and (provider in self.store.prefs.get("providers", {}) or provider in self.cache)
                )
                or (provider == "openai-codex" and bool(self.store.credential(provider).get("refresh")))
                or bool(api_key(self.store, provider))
                or (
                    provider in self.store.prefs.get("providers", {})
                    and not settings(self.store, provider).get("env")
                )
            )

        return [x for x in self.models if enabled(x["provider"])]

    async def refresh(self, provider: str | None = None, client=None) -> list:
        if provider is None:
            # Refresh only explicitly configured/authenticated endpoints.
            providers = set(self.store.prefs.get("providers", {})) | {x["provider"] for x in self.available()}
            for name in sorted(providers - {"openai-codex"}):
                await self.refresh(name, client)
            return self.models
        provider = provider.partition("/")[0]
        config = settings(self.store, provider)
        if config["api"] == "codex":
            return [x for x in self.models if x["provider"] == provider]
        key = api_key(self.store, provider)
        headers = {**config.get("headers", {}), **self.store.credential(provider).get("headers", {})}
        params: dict[str, str] = {}
        if key:
            if config["api"] == "anthropic":
                headers.update({"x-api-key": key, "anthropic-version": "2023-06-01"})
            elif config["api"] == "google":
                headers["x-goog-api-key"] = key
            else:
                headers["Authorization"] = f"Bearer {key}"
        owned = client is None
        client = client or httpx.AsyncClient(timeout=30)
        try:
            entries: list[dict] = []
            tokens: set[str] = set()
            url = config["base_url"].rstrip("/") + "/models"
            router = await self._llama_models(client, config, headers) if provider == "llama.cpp" else None
            if router is not None:
                self.cache[provider] = router
                write_json(self.store.root / "models.json", self.cache)
                self._rebuild()
                return [x for x in self.models if x["provider"] == provider]
            while True:
                response = await client.get(url, headers=headers, params=params)
                response.raise_for_status()
                data = response.json()
                rows = data.get("models", data.get("data", []))
                served = {
                    x["id"]: (x.get("meta") or {}).get("n_ctx")
                    for x in data.get("data", [])
                    if isinstance(x, dict) and isinstance(x.get("id"), str)
                } if isinstance(data.get("data"), list) else {}
                known = {x["id"]: x for x in self.models if x["provider"] == provider}
                # Hand-checked entries keep their levels; discovered ones follow what the service advertises.
                curated = {x["id"] for x in SNAPSHOT if x["provider"] == provider}
                for row in rows:
                    identifier = row.get("id") or row.get("name", "").removeprefix("models/")
                    if not identifier:
                        continue
                    if config["api"] == "google" and "generateContent" not in row.get(
                        "supportedGenerationMethods", []
                    ):
                        continue
                    item = known.get(identifier, {"id": identifier}).copy()
                    item.update(id=identifier, name=row.get("displayName", row.get("name", identifier)))
                    limit = row.get("context_length") or row.get("inputTokenLimit")
                    if not limit and provider == "llama.cpp":
                        # A single-model llama-server lists Ollama-style "models" without sizes; the running -c
                        # size is only in the OpenAI-style "data" rows.
                        limit = served.get(identifier)
                    if limit:
                        item.update(context=limit, metadata_estimated=False)
                    if row.get("outputTokenLimit"):
                        item["max_output"] = row["outputTokenLimit"]
                    completion = (row.get("top_provider") or {}).get("max_completion_tokens")
                    if isinstance(completion, int) and completion > 0:
                        # OpenRouter: without this a reasoning model spends the default 4096 on thinking and a
                        # lesson is cut off mid-task (the request limit is capped separately in providers.payload).
                        item["max_output"] = completion
                    price = row.get("pricing")
                    if price:
                        item["cost"] = {
                            k: rate * 1e6
                            for k, v in (
                                ("input", "prompt"),
                                ("output", "completion"),
                                ("cache_read", "input_cache_read"),
                                ("cache_write", "input_cache_write"),
                            )
                            if (rate := _rate(price.get(v))) is not None
                        }
                    levels = _reasoning_levels(row)
                    if levels and identifier not in curated:
                        item.update(reasoning=True, thinking_levels=levels)
                    if row.get("architecture"):
                        item["vision"] = "image" in row["architecture"].get("input_modalities", [])
                    entries.append(item)
                token = data.get("nextPageToken") or (data.get("last_id") if data.get("has_more") else None)
                if not token or token in tokens:  # a server repeating its cursor must not hang the refresh
                    break
                tokens.add(token)
                params = {"pageToken" if config["api"] == "google" else "after": token}
            if provider == "llama.cpp" and "enable_thinking" in await self._llama_template(client, config, headers):
                # A single-model server lists no template in /models; its /props chat template says whether thinking can be switched off.
                for item in entries:
                    item.update(reasoning=True, thinking_levels=["off", "medium"], reasoning_format="qwen-chat-template")
            self.cache[provider] = entries
            write_json(self.store.root / "models.json", self.cache)
            self._rebuild()
            return [x for x in self.models if x["provider"] == provider]
        finally:
            if owned:
                await client.aclose()

    async def _llama_template(self, client, config, headers) -> str:
        from .llama import Llama

        base = Llama(config["base_url"], client=client).base_url
        try:
            response = await client.get(base + "/props", headers=headers)
            props = response.json() if response.is_success else {}
        except (httpx.HTTPError, ValueError):
            return ""
        template = props.get("chat_template") if isinstance(props, dict) else None
        return template if isinstance(template, str) else ""

    async def _llama_models(self, client, config, headers):
        from .llama import Llama

        # Use the shared router URL normalizer; explicit headers include private proxy auth.
        router = Llama(config["base_url"], client=client)
        response = await client.get(router.base_url + "/models", headers=headers)
        if response.status_code == 404:
            return None  # A single-model server may expose only the compatible /v1/models.
        response.raise_for_status()
        data = response.json()
        rows = data.get("data") if isinstance(data, dict) else None
        if not isinstance(rows, list) or any(
            not isinstance(x, dict)
            or not isinstance(x.get("id"), str)
            or not isinstance(x.get("status"), dict)
            or not isinstance(x["status"].get("value"), str)
            for x in rows
        ):
            return None

        async def props(model=""):
            response = await client.get(
                router.base_url + "/props",
                headers=headers,
                params={"model": model, "autoload": "false"} if model else None,
            )
            if response.is_error:
                return {}
            result = response.json()
            return result if isinstance(result, dict) else {}

        general = await props()
        autoload = general.get("models_autoload") is True
        known = {x["id"]: x for x in self.models if x["provider"] == "llama.cpp"}
        entries = []
        for row in rows:
            status = row["status"]
            state = status["value"]
            architecture = row.get("architecture", {})
            outputs = architecture.get("output_modalities", [])
            if outputs and "text" not in outputs:
                continue
            if status.get("failed") or not (
                state in ("loaded", "sleeping")
                or (autoload and state == "unloaded" and row.get("source") == "preset")
            ):
                continue
            identifier = row["id"]
            previous = known.get(identifier, {})
            item = dict(previous, id=identifier, name=identifier, router_status=state)
            metadata = row.get("meta", {})
            properties = await props(identifier)
            runtime = (
                metadata.get("n_ctx")
                or properties.get("n_ctx")
                or properties.get("default_generation_settings", {}).get("n_ctx")
            )
            context = runtime
            if not context:
                args = status.get("args", [])
                for index, arg in enumerate(args[:-1]):
                    if arg in ("--ctx-size", "-c", "-ctx"):
                        try:
                            context = int(args[index + 1])
                        except (TypeError, ValueError):
                            pass
                        break
            if not context and previous and not previous.get("metadata_estimated"):
                context = previous.get("context")
            context = context or metadata.get("n_ctx_train")
            if isinstance(context, int) and context > 0:
                item.update(context=context, max_output=context, metadata_estimated=False)
            inputs = architecture.get("input_modalities")
            vision = properties.get("modalities", {}).get("vision", metadata.get("vision"))
            if inputs is not None or vision is not None:
                item["vision"] = "image" in (inputs or []) or vision is True
            if "chat_template" in properties:
                reasoning = "enable_thinking" in str(properties["chat_template"])
                item.update(
                    reasoning=reasoning,
                    thinking_levels=["off", "medium"] if reasoning else ["off"],
                    reasoning_format="qwen-chat-template" if reasoning else None,
                )
            item["cost"] = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
            entries.append(item)
        return entries
