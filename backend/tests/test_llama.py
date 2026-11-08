import asyncio
import json

import httpx
import pytest
from reference_graphy.llama import Llama, LlamaError


def catalog(value="loaded", **status):
    return {"data": [{"id": "repo/model:Q4_K_M", "status": {"value": value, **status}}]}


async def noop(message):
    pass


def router(handler):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    llama = Llama("http://localhost:8080/v1/?ignored=true#fragment", "router-secret", client)
    llama.poll_interval = 0
    return llama, client


async def test_normalize_and_catalog_props():
    paths = []

    def handle(request):
        paths.append(request.url.path)
        assert request.headers["authorization"] == "Bearer router-secret"
        if request.url.path == "/props":
            assert request.url.params["autoload"] == "false"
            return httpx.Response(200, json={"models_autoload": False})
        return httpx.Response(200, json=catalog("sleeping"))

    llama, client = router(handle)
    async with client:
        assert llama.base_url == "http://localhost:8080"
        assert (await llama.list())[0]["status"]["value"] == "sleeping"
        assert await llama.props("repo/model:Q4_K_M") == {"models_autoload": False}
    assert paths == ["/models", "/props"]


@pytest.mark.parametrize("url", ["file:///tmp/model", "http://user:pass@localhost", "localhost:8080"])
def test_invalid_router_url(url):
    with pytest.raises(ValueError):
        Llama(url)


async def test_reject_nonrouter_catalog():
    llama, client = router(lambda _: httpx.Response(200, json={"data": [{"id": "not-router"}]}))
    async with client:
        with pytest.raises(LlamaError, match="router mode"):
            await llama.list()


@pytest.mark.parametrize(
    "action,path,states",
    [
        ("load", "/models/load", ["loading", "loaded"]),
        ("unload", "/models/unload", ["loaded", "unloaded"]),
        ("download", "/models", ["downloading", "unloaded", "unloaded", "unloaded"]),
    ],
)
async def test_actions_poll_to_actual_state(action, path, states):
    posts, messages, polls = [], [], []

    async def progress(message):
        messages.append(message)

    def handle(request):
        if request.url.path == "/models/sse":
            return httpx.Response(404)
        if request.method == "POST":
            posts.append((request.url.path, json.loads(request.content)))
            return httpx.Response(200, json={})
        polls.append(request.url.params.get("reload"))
        return httpx.Response(200, json=catalog(states.pop(0)))

    llama, client = router(handle)
    async with client:
        models = await llama.perform(action, "repo/model:Q4_K_M", progress)
    assert posts == [(path, {"model": "repo/model:Q4_K_M"})]
    assert models[0]["status"]["value"] == ("loaded" if action == "load" else "unloaded")
    assert messages
    if action == "download":
        assert polls[-1] == "1"


async def test_failed_model_exposes_state_without_leaking_response_body():
    def handle(request):
        if request.url.path == "/models/sse":
            return httpx.Response(404)
        return httpx.Response(
            200, json={} if request.method == "POST" else catalog("unloaded", failed=True, exit_code=7)
        )

    llama, client = router(handle)
    async with client:
        with pytest.raises(LlamaError, match="exit 7") as exc:
            await llama.perform("load", "repo/model:Q4_K_M", noop)
    assert exc.value.models[0]["status"]["failed"]


async def test_ambiguous_post_failure_queries_status_and_never_replays():
    posts = []

    def handle(request):
        if request.url.path == "/models/sse":
            return httpx.Response(404)
        if request.method == "POST":
            posts.append(request)
            raise httpx.ReadError("oops router-secret", request=request)
        return httpx.Response(200, json=catalog("loading"))

    llama, client = router(handle)
    async with client:
        with pytest.raises(LlamaError, match="not retried") as exc:
            await llama.perform("load", "repo/model:Q4_K_M", noop)
    assert len(posts) == 1
    assert "router-secret" not in str(exc.value)
    assert exc.value.models[0]["status"]["value"] == "loading"


async def test_error_response_does_not_echo_credentials():
    llama, client = router(lambda _: httpx.Response(401, json={"error": {"message": "router-secret"}}))
    async with client:
        with pytest.raises(LlamaError, match="HTTP 401") as exc:
            await llama.list()
    assert "router-secret" not in str(exc.value)


async def test_cancel_unloads_and_reports_actual_state():
    posts = []

    def handle(request):
        if request.method == "POST":
            posts.append(request.url.path)
            return httpx.Response(200)
        return httpx.Response(200, json=catalog("unloaded"))

    llama, client = router(handle)
    async with client:
        report = await llama.cancel("repo/model:Q4_K_M", "download")
    assert posts == ["/models/unload"]
    assert report["requested"] and report["confirmed"]
    assert report["models"][0]["status"]["value"] == "unloaded"


async def test_unsupported_cancel_does_not_claim_success():
    def handle(request):
        return (
            httpx.Response(404)
            if request.method == "POST"
            else httpx.Response(200, json=catalog("downloading"))
        )

    llama, client = router(handle)
    async with client:
        report = await llama.cancel("repo/model:Q4_K_M", "download")
    assert not report["confirmed"]
    assert "not confirmed" in report["message"]
    assert report["models"][0]["status"]["value"] == "downloading"


async def test_task_cancellation_cleans_up_remote_and_reraises():
    polling = asyncio.Event()
    stopped = False
    posts = []

    def handle(request):
        nonlocal stopped
        if request.url.path == "/models/sse":
            return httpx.Response(404)
        if request.method == "POST":
            posts.append(request.url.path)
            stopped = request.url.path == "/models/unload"
            return httpx.Response(200, json={})
        polling.set()
        return httpx.Response(200, json=catalog("unloaded" if stopped else "loading"))

    llama, client = router(handle)
    async with client:
        task = asyncio.create_task(llama.perform("load", "repo/model:Q4_K_M", noop))
        await polling.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert posts == ["/models/load", "/models/unload"]
    assert llama.last_cancel["confirmed"]


async def test_deadline_queries_actual_state_without_mutation_retry():
    posts = []

    def handle(request):
        if request.url.path == "/models/sse":
            return httpx.Response(404)
        if request.method == "POST":
            posts.append(request)
            return httpx.Response(200, json={})
        return httpx.Response(200, json=catalog("loading"))

    llama, client = router(handle)
    llama.operation_timeout = 0.01
    async with client:
        with pytest.raises(LlamaError, match="remote work may continue") as exc:
            await llama.perform("load", "repo/model:Q4_K_M", noop)
    assert len(posts) == 1
    assert exc.value.models[0]["status"]["value"] == "loading"


async def test_sse_progress_is_optional_not_authoritative():
    messages = []

    async def progress(message):
        messages.append(message)

    event = {
        "model": "repo/model:Q4_K_M",
        "event": "download_progress",
        "data": {"file": {"done": 50, "total": 100}},
    }

    def handle(request):
        return httpx.Response(200, text="data: garbage\n\ndata: " + json.dumps(event) + "\n\n")

    llama, client = router(handle)
    async with client:
        await llama._watch("repo/model:Q4_K_M", progress, {})
    assert len(messages) == 1
    assert "50.0%" in messages[0]


async def test_huggingface_search_and_sharded_variants(monkeypatch):
    monkeypatch.setenv("HF_TOKEN", "hf-secret")

    def handle(request):
        assert request.url.host == "huggingface.co"
        assert request.headers["authorization"] == "Bearer hf-secret"
        if request.url.path == "/api/models":
            assert request.url.params["filter"] == "gguf"
            return httpx.Response(200, json=[{"id": "org/gguf", "downloads": 123}, {"noise": True}])
        assert request.url.params["blobs"] == "true"
        siblings = [
            {"rfilename": "model-Q4_K_M-00001-of-00002.gguf", "size": 100},
            {"rfilename": "model-Q4_K_M-00002-of-00002.gguf", "size": 200},
            {"rfilename": "model-IQ4_XS.gguf", "size": 250},
            {"rfilename": "model-F16.gguf"},
            {"rfilename": "mmproj-Q4_K_M.gguf", "size": 999},
        ]
        return httpx.Response(200, json={"id": "org/gguf", "gated": "manual", "siblings": siblings})

    llama, client = router(handle)
    async with client:
        assert await llama.search("model") == [{"id": "org/gguf", "downloads": 123}]
        result = await llama.variants("org/gguf:Q4_K_M")
    assert result["gated"] == "manual"
    assert result["quantizations"] == [
        {"name": "Q4_K_M", "size": 300},
        {"name": "IQ4_XS", "size": 250},
        {"name": "F16"},
    ]
