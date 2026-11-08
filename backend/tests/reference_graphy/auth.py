"""Codex subscription login. PKCE, device login and on-demand locked refresh."""

import asyncio
import base64
import hashlib
import inspect
import json
import math
import secrets
import time
import webbrowser
from urllib.parse import parse_qs, urlencode, urlparse

import httpx
from filelock import FileLock

CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
AUTH_BASE = "https://auth.openai.com"
REDIRECT = "http://localhost:1455/auth/callback"
DEVICE_REDIRECT = AUTH_BASE + "/deviceauth/callback"
_REFRESH_LOCKS: dict[str, asyncio.Lock] = {}


class AuthError(ValueError):
    pass


def authorization_input(value: str | None, state: str) -> str:
    if value is None:
        raise asyncio.CancelledError
    value = value.strip()
    if not value:
        raise AuthError("Missing authorization code")
    query = urlparse(value).query if "://" in value else value
    if "code=" in query:
        params = parse_qs(query)
        code = params.get("code", [""])[0]
        supplied = params.get("state", [""])[0]
    elif "#" in value:
        code, supplied = value.split("#", 1)
    else:
        code, supplied = value, ""
    if supplied and not secrets.compare_digest(supplied, state):
        raise AuthError("OAuth state mismatch")
    if not code:
        raise AuthError("Missing authorization code")
    return code


def _credential(data: dict) -> dict:
    try:
        access = data["access_token"]
        part = access.split(".")[1]
        payload = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
        account = payload["https://api.openai.com/auth"]["chatgpt_account_id"]
        expiry = float(data["expires_in"])
        if (
            not isinstance(account, str)
            or not account
            or not isinstance(data["refresh_token"], str)
            or not data["refresh_token"]
            or not math.isfinite(expiry)
            or expiry <= 0
        ):
            raise ValueError
    except (KeyError, ValueError, TypeError, IndexError) as exc:
        raise AuthError("Codex token response missing valid access/refresh/expiry/account ID") from exc
    return {
        "type": "oauth",
        "access": access,
        "refresh": data["refresh_token"],
        "expires": time.time() + expiry,
        "accountId": account,
    }


async def _token(client, fields) -> dict:
    response = await client.post(AUTH_BASE + "/oauth/token", data={"client_id": CLIENT_ID, **fields})
    if response.is_error:
        # Auth bodies may include tokens; never echo them into logs/UI.
        raise AuthError(f"Codex token exchange failed ({response.status_code}); log in again if expired")
    try:
        return _credential(response.json())
    except (json.JSONDecodeError, TypeError) as exc:
        raise AuthError("Invalid Codex token response") from exc


async def _notify(notify, value):
    result = notify(value)
    if inspect.isawaitable(result):
        await result


async def login_codex(store, ask, notify, method="browser", client=None):
    """ask(title, secret=False) returns str or None; notify receives public text.

    method='browser' races localhost callback against pasted redirect/code;
    method='device' polls the headless device flow. Cancellation closes all resources.
    """
    owned = client is None
    client = client or httpx.AsyncClient(timeout=30)
    try:
        if method in ("device", "device_code"):
            response = await client.post(
                AUTH_BASE + "/api/accounts/deviceauth/usercode", json={"client_id": CLIENT_ID}
            )
            if response.is_error:
                raise AuthError(f"Codex device login unavailable ({response.status_code}); try browser login")
            data = response.json()
            try:
                device_id, user_code = data["device_auth_id"], data["user_code"]
                interval = max(1.0, float(data.get("interval", 5)))
                if not device_id or not user_code or interval > 60:
                    raise ValueError
            except (ValueError, TypeError, KeyError) as exc:
                raise AuthError("Invalid device authorization response") from exc
            await _notify(notify, f"Open {AUTH_BASE}/codex/device and enter code: {user_code}")
            deadline = time.monotonic() + 900
            while time.monotonic() < deadline:
                await asyncio.sleep(interval)
                response = await client.post(
                    AUTH_BASE + "/api/accounts/deviceauth/token",
                    json={"device_auth_id": device_id, "user_code": user_code},
                )
                if response.is_success:
                    data = response.json()
                    try:
                        credential = await _token(
                            client,
                            {
                                "grant_type": "authorization_code",
                                "code": data["authorization_code"],
                                "code_verifier": data["code_verifier"],
                                "redirect_uri": DEVICE_REDIRECT,
                            },
                        )
                    except KeyError as exc:
                        raise AuthError("Invalid device token response") from exc
                    break
                try:
                    error = response.json().get("error", "")
                    error = error.get("code", "") if isinstance(error, dict) else error
                except ValueError:
                    error = ""
                if error == "slow_down":
                    interval += 5
                elif response.status_code not in (403, 404) and error != "deviceauth_authorization_pending":
                    raise AuthError(f"Device login failed ({response.status_code})")
            else:
                raise AuthError("Device login expired; start again")
        elif method == "browser":
            verifier = secrets.token_urlsafe(48)
            challenge = (
                base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
            )
            state = secrets.token_urlsafe(24)
            url = (
                AUTH_BASE
                + "/oauth/authorize?"
                + urlencode(
                    {
                        "response_type": "code",
                        "client_id": CLIENT_ID,
                        "redirect_uri": REDIRECT,
                        "scope": "openid profile email offline_access",
                        "code_challenge": challenge,
                        "code_challenge_method": "S256",
                        "state": state,
                        "id_token_add_organizations": "true",
                        "codex_cli_simplified_flow": "true",
                        "originator": "pi",
                    }
                )
            )
            callback = asyncio.get_running_loop().create_future()

            async def handle(reader, writer):
                try:
                    first = await asyncio.wait_for(reader.readline(), 5)
                    path = first.decode("ascii", errors="replace").split(" ")[1]
                    parsed = urlparse(path)
                    params = parse_qs(parsed.query)
                    valid = (
                        parsed.path == "/auth/callback"
                        and secrets.compare_digest(params.get("state", [""])[0], state)
                        and bool(params.get("code", [""])[0])
                    )
                    if valid and not callback.done():
                        callback.set_result(params["code"][0])
                    body = b"Login complete. You may close this tab." if valid else b"Invalid OAuth callback."
                    writer.write(
                        b"HTTP/1.1 "
                        + (b"200 OK" if valid else b"400 Bad Request")
                        + b"\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: "
                        + str(len(body)).encode()
                        + b"\r\n\r\n"
                        + body
                    )
                    await writer.drain()
                except (OSError, TimeoutError, IndexError):
                    pass
                finally:
                    writer.close()
                    await writer.wait_closed()

            server = None
            manual = None
            try:
                try:
                    server = await asyncio.start_server(handle, "127.0.0.1", 1455, limit=8192)
                except OSError:
                    await _notify(notify, "Port 1455 unavailable; paste the final redirect URL after login.")
                await _notify(notify, f"Open this URL to sign in with ChatGPT:\n{url}")
                # Browser launch must never delay callback/manual input or block cancellation.
                asyncio.create_task(asyncio.to_thread(webbrowser.open, url))
                manual = asyncio.create_task(ask("Complete browser login, or paste redirect URL / code:"))
                waiters = {manual, callback} if server else {manual}
                done, _ = await asyncio.wait(waiters, timeout=900, return_when=asyncio.FIRST_COMPLETED)
                if not done:
                    raise AuthError("Browser login expired; start again")
                code = callback.result() if callback in done else authorization_input(manual.result(), state)
                credential = await _token(
                    client,
                    {
                        "grant_type": "authorization_code",
                        "code": code,
                        "code_verifier": verifier,
                        "redirect_uri": REDIRECT,
                    },
                )
            finally:
                if manual and not manual.done():
                    manual.cancel()
                    await asyncio.gather(manual, return_exceptions=True)
                if not callback.done():
                    callback.cancel()
                if server:
                    server.close()
                    await server.wait_closed()
        else:
            raise AuthError("Choose browser or device login")
        store.set_credential("openai-codex", credential)
        await _notify(notify, "Codex login saved.")
        return credential
    finally:
        if owned:
            await client.aclose()


async def codex_credential(store, client):
    """Refresh only when needed; file lock also serializes separate graphy processes."""
    lock = _REFRESH_LOCKS.setdefault(str(store.root), asyncio.Lock())
    async with lock:
        file_lock = FileLock(str(store.root / "codex-refresh.lock"))
        # Non-blocking attempts keep the UI responsive during another process's refresh.
        while True:
            try:
                file_lock.acquire(timeout=0)
                break
            except TimeoutError:
                await asyncio.sleep(0.1)
        try:
            credential = store.credential("openai-codex")
            if not credential.get("refresh"):
                raise AuthError("Use /login openai-codex to sign in with ChatGPT")
            # Accept reference-style millisecond expiry on imported credentials.
            expires = credential.get("expires", 0)
            expires = expires / 1000 if expires > 1e11 else expires
            if expires > time.time() + 60:
                return credential
            refreshed = await _token(
                client, {"grant_type": "refresh_token", "refresh_token": credential["refresh"]}
            )
            credential = credential | refreshed
            store.set_credential("openai-codex", credential)
            return credential
        finally:
            file_lock.release()
