import asyncio
import base64
import json
import socket
import time
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from reference_graphy import auth
from reference_graphy.auth import AuthError, authorization_input, codex_credential, login_codex
from reference_graphy.storage import Store


@pytest.fixture
def callback_server_available():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", 0))
    except OSError as exc:
        pytest.skip(f"Loopback TCP is unavailable in this environment: {exc}")


def token_data(account="acct", refresh="new-refresh"):
    encoded = (
        base64.urlsafe_b64encode(
            json.dumps({"https://api.openai.com/auth": {"chatgpt_account_id": account}}).encode()
        )
        .decode()
        .rstrip("=")
    )
    return {"access_token": f"header.{encoded}.signature", "refresh_token": refresh, "expires_in": 3600}


def test_authorization_input_formats_and_state():
    assert authorization_input("abc", "state") == "abc"
    assert authorization_input("abc#state", "state") == "abc"
    assert authorization_input("http://localhost:1455/auth/callback?code=abc&state=state", "state") == "abc"
    assert authorization_input("code=abc&state=state", "state") == "abc"
    with pytest.raises(AuthError, match="state mismatch"):
        authorization_input("code=abc&state=wrong", "state")
    with pytest.raises(asyncio.CancelledError):
        authorization_input(None, "state")


async def test_refresh_single_network_exchange_for_concurrent_consumers(tmp_path):
    store = Store(tmp_path)
    store.set_credential(
        "openai-codex",
        {
            "type": "oauth",
            "access": "old",
            "refresh": "old-refresh",
            "expires": time.time() - 100,
            "accountId": "acct",
            "headers": {"X-Private": "saved-secret"},
        },
    )
    requests = []

    async def transport(request):
        requests.append(request)
        await asyncio.sleep(0.01)
        return httpx.Response(200, json=token_data())

    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        results = await asyncio.gather(*(codex_credential(store, client) for _ in range(5)))
    assert len(requests) == 1
    assert len({x["access"] for x in results}) == 1
    assert parse_qs(requests[0].content.decode())["grant_type"] == ["refresh_token"]
    assert store.credential("openai-codex")["refresh"] == "new-refresh"


async def test_valid_token_does_not_refresh_and_missing_auth_explains_login(tmp_path):
    store = Store(tmp_path)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: pytest.fail("unexpected request"))
    ) as client:
        with pytest.raises(AuthError, match="/login openai-codex"):
            await codex_credential(store, client)
        credential = {
            "access": "ok",
            "refresh": "r",
            "expires": (time.time() + 3600) * 1000,
            "accountId": "a",
        }
        store.set_credential("openai-codex", credential)
        assert await codex_credential(store, client) == credential


async def test_invalid_refresh_does_not_overwrite_credentials_or_echo_secret(tmp_path):
    store = Store(tmp_path)
    old = {"refresh": "private-refresh", "expires": 0}
    store.set_credential("openai-codex", old)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(401, json={"error": "private-refresh"}))
    ) as client:
        with pytest.raises(AuthError) as caught:
            await codex_credential(store, client)
    assert "private-refresh" not in str(caught.value)
    assert store.credential("openai-codex") == old


async def test_browser_manual_pkce_and_cleanup(tmp_path, monkeypatch, callback_server_available):
    store = Store(tmp_path)
    notifications, requests = [], []
    monkeypatch.setattr(auth.webbrowser, "open", lambda url: True)

    async def ask(title, secret=False):
        url = next(x.split("\n")[-1] for x in notifications if "/oauth/authorize?" in x)
        state = parse_qs(urlparse(url).query)["state"][0]
        return f"http://localhost:1455/auth/callback?code=code123&state={state}"

    def transport(request):
        requests.append(request)
        return httpx.Response(200, json=token_data())

    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        credential = await login_codex(store, ask, notifications.append, client=client)
    values = parse_qs(requests[0].content.decode())
    assert values["code"] == ["code123"]
    assert len(values["code_verifier"][0]) >= 43
    assert credential["accountId"] == "acct"
    assert store.credential("openai-codex") == credential
    # The callback port is closed after a manual login.
    server = await asyncio.start_server(lambda r, w: w.close(), "127.0.0.1", 1455)
    server.close()
    await server.wait_closed()


async def test_browser_callback_wins_and_cancels_manual(tmp_path, monkeypatch, callback_server_available):
    store = Store(tmp_path)
    notifications = []
    manual_cancelled = asyncio.Event()
    monkeypatch.setattr(auth.webbrowser, "open", lambda url: True)

    async def ask(title, secret=False):
        url = next(x.split("\n")[-1] for x in notifications if "/oauth/authorize?" in x)
        state = parse_qs(urlparse(url).query)["state"][0]
        try:
            async with httpx.AsyncClient(trust_env=False) as callback:
                # An unsolicited wrong-state request must not complete the flow.
                bad = await callback.get("http://127.0.0.1:1455/auth/callback?code=bad&state=wrong")
                assert bad.status_code == 400
                good = await callback.get(f"http://127.0.0.1:1455/auth/callback?code=correct&state={state}")
                assert good.status_code == 200
            await asyncio.Event().wait()
        finally:
            manual_cancelled.set()

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json=token_data()))
    ) as client:
        result = await login_codex(store, ask, notifications.append, client=client)
    assert result["accountId"] == "acct"
    assert manual_cancelled.is_set()


async def test_browser_cancel_does_not_save_and_releases_port(tmp_path, monkeypatch, callback_server_available):
    store = Store(tmp_path)
    monkeypatch.setattr(auth.webbrowser, "open", lambda url: True)

    async def ask(title, secret=False):
        return None

    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: pytest.fail("cancelled"))) as client:
        with pytest.raises(asyncio.CancelledError):
            await login_codex(store, ask, lambda text: None, client=client)
    assert not store.credential("openai-codex")
    server = await asyncio.start_server(lambda r, w: w.close(), "127.0.0.1", 1455)
    server.close()
    await server.wait_closed()


async def test_device_pending_slowdown_then_exchange(tmp_path, monkeypatch):
    store = Store(tmp_path)
    requests, sleeps, notes = [], [], []

    async def sleep(delay):
        sleeps.append(delay)

    monkeypatch.setattr(auth.asyncio, "sleep", sleep)
    polls = iter(
        [
            httpx.Response(403, json={}),
            httpx.Response(429, json={"error": "slow_down"}),
            httpx.Response(200, json={"authorization_code": "device-code", "code_verifier": "verifier"}),
        ]
    )

    def transport(request):
        requests.append(request)
        if request.url.path.endswith("/usercode"):
            return httpx.Response(
                200, json={"device_auth_id": "device", "user_code": "ABCD", "interval": "2"}
            )
        if request.url.path.endswith("/deviceauth/token"):
            return next(polls)
        return httpx.Response(200, json=token_data())

    async def ask(title, secret=False):
        pytest.fail("device login must not ask for a pasted code")

    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        result = await login_codex(store, ask, notes.append, method="device", client=client)
    assert result["accountId"] == "acct"
    assert sleeps == [2, 2, 7]
    assert "ABCD" in notes[0] and "/codex/device" in notes[0]
    fields = parse_qs(requests[-1].content.decode())
    assert fields["code"] == ["device-code"]
    assert fields["redirect_uri"] == [auth.DEVICE_REDIRECT]
