"""Local HTTP API and event stream. The contract is described in docs/protocol.md.

The server only ever listens on the loopback interface and still demands a bearer token: any web page the
user visits can reach localhost, so reachability alone is not authorization. Origins are checked as well
(browsers attach them to cross-site requests) and so is the Host header (DNS rebinding).
"""

import argparse
import asyncio
import contextlib
import json
import os
import secrets
import signal
import sys
import traceback
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import web

from . import __version__
from .service import PROTOCOL, ApiError, Service
from .storage import Store

API = "/api/v1"
LOOPBACK = ("127.0.0.1", "localhost", "::1")
# Inside the Docker sandbox (scripts/sandbox.cjs) the server listens on the container's own interface; the
# container's port is published on the host's loopback only, so it is still reachable from this computer alone.
IN_SANDBOX = os.environ.get("GRAPHY_SANDBOX") == "docker"
MAX_BODY = 4 * 1024 * 1024
PING_SECONDS = 15
BATCH = 256


def error_response(status, code, message):
    return web.json_response({"error": {"code": code, "message": message}}, status=status)


def allowed_host(host_header):
    host = urlsplit("//" + host_header).hostname or ""
    return host in LOOPBACK


def cors_headers(origin):
    """Headers for an origin the guard has already accepted; none for a same-origin or non-browser client."""
    return {"Access-Control-Allow-Origin": origin, "Vary": "Origin"} if origin is not None else {}


def make_guard(token, origins, service):
    @web.middleware
    async def guard(request, handler):
        if not allowed_host(request.headers.get("Host", "")):
            return error_response(403, "bad_host", "Unexpected Host header")
        origin = request.headers.get("Origin")
        if origin is not None and origin not in origins:
            return error_response(403, "bad_origin", "Origin is not allowed")
        headers = cors_headers(origin)
        if request.method == "OPTIONS":
            return web.Response(status=204, headers=headers | {
                "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Authorization, Content-Type",
                "Access-Control-Max-Age": "600"})
        if request.path != f"{API}/health":
            supplied = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
            if not supplied and request.path == f"{API}/events":
                supplied = request.query.get("token", "")  # EventSource cannot set headers
            if not supplied or not secrets.compare_digest(supplied, token):
                return error_response(401, "unauthorized", "Missing or wrong token")
        try:
            response = await handler(request)
        except ApiError as exc:
            response = error_response(exc.status, exc.code, exc.message)
        except web.HTTPException as exc:
            response = error_response(exc.status, "http_error", exc.reason or "Error")
        except (ValueError, KeyError, TypeError) as exc:
            response = error_response(400, "invalid", service.store.redact(str(exc)))
        except OSError as exc:
            response = error_response(500, "storage_error", service.store.redact(str(exc)))
        except asyncio.CancelledError:
            raise
        except Exception:  # a bug: report it to the log, tell the client nothing internal
            traceback.print_exc(file=sys.stderr)
            response = error_response(500, "internal", "Internal error")
        if not response.prepared:
            response.headers.update(headers)
        return response

    return guard


async def read_json(request):
    if not request.can_read_body:
        return {}
    if request.content_type != "application/json":
        raise ApiError(415, "unsupported_media_type", "Send application/json")
    try:
        body = await request.json()
    except ValueError as exc:
        raise ApiError(400, "invalid_json", "Body is not valid JSON") from exc
    if not isinstance(body, dict):
        raise ApiError(400, "invalid_json", "Body must be a JSON object")
    return body


def text_field(body, name, *, required=True, default=""):
    value = body.get(name, default)
    if not isinstance(value, str) or (required and not value.strip()):
        raise ValueError(f"{name} must be a nonempty string" if required else f"{name} must be a string")
    return value


def routes(service):
    table = web.RouteTableDef()

    def json_ok(data=None, status=200):
        return web.json_response({} if data is None else data, status=status)

    @table.get(f"{API}/health")
    async def health(request):
        return json_ok({"ok": True, "protocol": PROTOCOL, "version": __version__})

    @table.get(f"{API}/bootstrap")
    async def bootstrap(request):
        return json_ok(service.bootstrap())

    @table.get(f"{API}/events")
    async def events(request):
        response = web.StreamResponse(headers={
            "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no", **cors_headers(request.headers.get("Origin"))})
        await response.prepare(request)
        subscription = service.bus.subscribe()

        def frame(event):
            return f"id: {event['seq']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"

        try:
            await response.write(frame({"seq": service.bus.seq, "type": "hello", "protocol": PROTOCOL}).encode())
            while True:
                try:
                    event = await asyncio.wait_for(subscription.queue.get(), PING_SECONDS)
                except TimeoutError:
                    await response.write(b": ping\n\n")
                    continue
                if event is None or subscription.closed:
                    break
                frames = []
                if subscription.lagged:
                    frames.append(frame({"seq": service.bus.seq, "type": "lagged"}))
                    await response.write("".join(frames).encode())
                    break
                frames.append(frame(event))
                # Whatever is already waiting goes out in the same write; nothing is held back to fill a buffer.
                while len(frames) < BATCH and not subscription.queue.empty():
                    queued = subscription.queue.get_nowait()
                    if queued is None:
                        break
                    frames.append(frame(queued))
                await response.write("".join(frames).encode())
        except (ConnectionResetError, ConnectionError):
            pass
        finally:
            service.bus.unsubscribe(subscription)
        return response

    # -------------------------------------------------------------- courses

    @table.get(f"{API}/courses")
    async def list_courses(request):
        return json_ok({"courses": service.list_courses()})

    @table.post(f"{API}/courses")
    async def create_course(request):
        body = await read_json(request)
        return json_ok(service.create_course(text_field(body, "name")), 201)

    @table.patch(API + "/courses/{id}")
    async def rename_course(request):
        body = await read_json(request)
        return json_ok(service.rename_course(request.match_info["id"], text_field(body, "name")))

    @table.delete(API + "/courses/{id}")
    async def delete_course(request):
        await service.delete_course(request.match_info["id"])
        return json_ok({"deleted": True})

    @table.get(API + "/courses/{id}/progress")
    async def progress(request):
        return json_ok(service.progress(request.match_info["id"]))

    # -------------------------------------------------------------- sessions

    @table.get(f"{API}/sessions")
    async def list_sessions(request):
        rows = service.list_sessions(request.query.get("course_id") or None,
                                     request.query.get("include_empty") == "1")
        return json_ok({"sessions": rows})

    @table.post(f"{API}/sessions")
    async def create_session(request):
        body = await read_json(request)
        runtime = service.create_session(text_field(body, "course_id"), body.get("model") or None,
                                         body.get("thinking") or None, body.get("explanation_style", "deep_dive"))
        return json_ok(runtime.snapshot(), 201)

    @table.get(API + "/sessions/{id}")
    async def snapshot(request):
        return json_ok(service.runtime(request.match_info["id"]).snapshot())

    @table.patch(API + "/sessions/{id}")
    async def rename(request):
        runtime = service.runtime(request.match_info["id"])
        runtime.rename(text_field(await read_json(request), "name"))
        return json_ok(runtime.summary())

    @table.delete(API + "/sessions/{id}")
    async def delete_session(request):
        await service.delete_session(request.match_info["id"])
        return json_ok({"deleted": True})

    @table.post(API + "/sessions/{id}/close")
    async def close_session(request):
        runtime = service.runtimes.get(request.match_info["id"])
        if runtime is not None and runtime.busy:
            raise ApiError(409, "busy", "Stop the running operation before closing the chat")
        return json_ok({"closed": await service.close_session(request.match_info["id"])})

    @table.post(API + "/sessions/{id}/messages")
    async def send(request):
        runtime = service.runtime(request.match_info["id"])
        body = await read_json(request)
        paths = body.get("paths", [])
        if not isinstance(paths, list) or any(not isinstance(p, str) for p in paths):
            raise ValueError("paths must be a list of strings")
        result = await runtime.send(text_field(body, "text", required=not paths), bool(body.get("followup")), paths)
        return json_ok(result, 202)

    @table.post(API + "/sessions/{id}/abort")
    async def abort(request):
        return json_ok({"aborted": service.runtime(request.match_info["id"]).abort()})

    @table.post(API + "/sessions/{id}/restore")
    async def restore(request):
        return json_ok({"text": service.runtime(request.match_info["id"]).restore()})

    @table.post(API + "/sessions/{id}/compact")
    async def compact(request):
        body = await read_json(request)
        runtime = service.runtime(request.match_info["id"])
        return json_ok(await runtime.compact(text_field(body, "instructions", required=False)), 202)

    @table.post(API + "/sessions/{id}/skill")
    async def skill(request):
        body = await read_json(request)
        runtime = service.runtime(request.match_info["id"])
        return json_ok(await runtime.run_skill(text_field(body, "name"), text_field(body, "request", required=False)), 202)

    @table.put(API + "/sessions/{id}/style")
    async def select_style(request):
        body = await read_json(request)
        runtime = service.runtime(request.match_info["id"])
        runtime.select_style(body.get("explanation_style", runtime.session.explanation_style))
        return json_ok(runtime.summary())

    @table.put(API + "/sessions/{id}/model")
    async def select_model(request):
        body = await read_json(request)
        runtime = service.runtime(request.match_info["id"])
        if runtime.busy:
            raise ApiError(409, "busy", "Finish or stop the current operation before changing the model")
        runtime.select_model(text_field(body, "model"), body.get("thinking") or None, bool(body.get("make_default")))
        return json_ok(runtime.summary())

    # -------------------------------------------------------------- questions

    @table.put(API + "/sessions/{id}/questions/{batch}/draft")
    async def draft(request):
        body = await read_json(request)
        runtime = service.runtime(request.match_info["id"])
        runtime.save_draft(request.match_info["batch"], body.get("answers"), body.get("step"))
        return json_ok({"saved": True})

    @table.post(API + "/sessions/{id}/questions/{batch}/submit")
    async def submit(request):
        body = await read_json(request)
        runtime = service.runtime(request.match_info["id"])
        return json_ok(await runtime.resolve_questions(request.match_info["batch"], body.get("answers")), 202)

    @table.post(API + "/sessions/{id}/questions/{batch}/cancel")
    async def cancel(request):
        body = await read_json(request)
        runtime = service.runtime(request.match_info["id"])
        block = runtime.session.pending_question
        answers = body.get("answers") or (block["answers"] if block else None)
        return json_ok(await runtime.resolve_questions(request.match_info["batch"], answers, cancel=True), 202)

    # -------------------------------------------------------------- models and providers

    @table.get(f"{API}/models")
    async def models(request):
        return json_ok({"models": service.list_models()})

    @table.post(f"{API}/models/refresh")
    async def refresh(request):
        body = await read_json(request)
        return json_ok({"models": await service.refresh_models(text_field(body, "provider"))})

    @table.get(f"{API}/providers")
    async def providers(request):
        return json_ok({"providers": service.list_providers()})

    @table.put(API + "/providers/{name}")
    async def connect(request):
        body = await read_json(request)
        key = body.get("key")
        if key is not None and not isinstance(key, str):
            raise ValueError("key must be a string")
        result = await service.connect_provider(request.match_info["name"], key=key,
                                                base_url=body.get("base_url") or None, api=body.get("api") or None)
        return json_ok(result)

    @table.delete(API + "/providers/{name}")
    async def disconnect(request):
        return json_ok(service.disconnect_provider(request.match_info["name"]))

    @table.post(f"{API}/login/codex")
    async def login(request):
        body = await read_json(request)
        return json_ok({"flow_id": service.start_login(text_field(body, "method"))}, 202)

    @table.post(API + "/login/{flow}/input")
    async def login_input(request):
        body = await read_json(request)
        service.login_input(request.match_info["flow"], body.get("value"))
        return json_ok({"accepted": True})

    @table.delete(API + "/login/{flow}")
    async def login_cancel(request):
        await service.cancel_login(request.match_info["flow"])
        return json_ok({"cancelled": True})

    # -------------------------------------------------------------- settings

    @table.get(f"{API}/settings")
    async def get_settings(request):
        return json_ok(service.get_settings())

    @table.patch(f"{API}/settings")
    async def patch_settings(request):
        return json_ok(service.update_settings(await read_json(request)))

    @table.put(f"{API}/settings/web-key")
    async def web_key(request):
        return json_ok(service.set_web_key((await read_json(request)).get("key")))

    @table.get(f"{API}/skills")
    async def skills(request):
        return json_ok(service.list_skills())

    return table


def make_app(service, token, origins):
    app = web.Application(middlewares=[make_guard(token, set(origins), service)], client_max_size=MAX_BODY)
    app.add_routes(routes(service))

    async def stop_streams(app):
        service.bus.close()

    app.on_shutdown.append(stop_streams)
    return app


async def stdin_closed():
    """Completes when the parent process goes away (its end of our stdin pipe closes)."""
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    while await reader.read(4096):
        pass


async def serve(service, *, host, port, token, origins, exit_on_stdin_close=False):
    runner = web.AppRunner(make_app(service, token, origins), access_log=None, handle_signals=False)
    await runner.setup()
    try:
        await web.TCPSite(runner, host, port).start()
        actual = runner.addresses[0][1]
        shown = f"[{host}]" if ":" in host else host
        print(json.dumps({"type": "ready", "url": f"http://{shown}:{actual}", "token": token,
                          "protocol": PROTOCOL, "version": __version__, "pid": os.getpid()}), flush=True)
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for name in ("SIGINT", "SIGTERM"):
            if signum := getattr(signal, name, None):
                with contextlib.suppress(NotImplementedError):
                    loop.add_signal_handler(signum, stop.set)
        watcher = None
        if exit_on_stdin_close:
            async def watch():
                with contextlib.suppress(Exception):
                    await stdin_closed()
                stop.set()

            watcher = asyncio.create_task(watch())
        await stop.wait()
        if watcher:
            watcher.cancel()
    finally:
        await runner.cleanup()
        await service.close()


def parse(argv):
    parser = argparse.ArgumentParser(prog="graphy serve", description="Локальный API для графического клиента")
    parser.add_argument("--host", default="127.0.0.1", help="только loopback: 127.0.0.1, localhost или ::1 (в песочнице Docker — любой)")
    parser.add_argument("--port", type=int, default=0, help="0 — выбрать свободный порт")
    parser.add_argument("--allow-origin", action="append", default=[], metavar="ORIGIN",
                        help="источник веб-клиента, например http://localhost:5174 (можно несколько; null — file://)")
    parser.add_argument("--cwd", type=Path, help="каталог для относительных путей учебных материалов")
    parser.add_argument("--exit-on-stdin-close", action="store_true", help="завершиться, когда родитель закроет stdin")
    args = parser.parse_args(argv)
    if args.host not in LOOPBACK and not IN_SANDBOX:
        parser.error("the server listens on the loopback interface only")
    if not 0 <= args.port <= 65535:
        parser.error("invalid port")
    return args


def main(argv=None):
    args = parse(sys.argv[1:] if argv is None else argv)
    token = os.environ.get("GRAPHY_TOKEN") or secrets.token_urlsafe(32)
    origins = [*args.allow_origin, *filter(None, os.environ.get("GRAPHY_ALLOWED_ORIGINS", "").split(","))]
    try:
        service = Service(Store(), args.cwd)
        asyncio.run(serve(service, host=args.host, port=args.port, token=token, origins=origins,
                          exit_on_stdin_close=args.exit_on_stdin_close))
    except KeyboardInterrupt:
        pass
    except (OSError, ValueError) as exc:
        print(f"graphy serve: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
