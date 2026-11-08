"""Exercise the real HTTP handlers and persistence without opening network sockets."""

import json
from types import SimpleNamespace

import pytest
from reference_graphy.context import request_context, style_method, style_presentation, system_prompt
from reference_graphy.server import API, make_app
from reference_graphy.service import Service
from reference_graphy.storage import Store


@pytest.fixture
async def api(tmp_path):
    store = Store(tmp_path / "state")
    store.prefs.update(default_model="fake/test", providers={
        "fake": {"api": "chat", "base_url": "http://fake.invalid/v1",
                 "models": [{"id": "test", "tools": True, "context": 32768}]}})
    service = Service(store, tmp_path, auto_title=False)
    app = make_app(service, "fixture-token", [])

    async def call(method, route, body=None, sid=None, status=200):
        handler = next(r.handler for r in app.router.routes()
                       if r.method == method and r.resource.canonical == API + route)

        async def request_json():
            return body

        request = SimpleNamespace(
            method=method, path=API + route, can_read_body=body is not None,
            query={"include_empty": "1"},
            content_type="application/json", json=request_json,
            match_info={"id": sid}, headers={"Host": "localhost", "Authorization": "Bearer fixture-token"})
        response = await app.middlewares[0](request, handler)
        data = json.loads(response.body)
        assert response.status == status, data
        return data

    yield service, call
    await service.close()


async def test_preferences_are_global_settings_that_persist_and_reach_the_agent(api):
    service, call = api
    course = await call("POST", "/courses", {"name": "Preferences"}, status=201)
    lesson = await call("POST", "/sessions", {"course_id": course["id"], "explanation_style": "socratic"}, status=201)
    sid = lesson["id"]
    runtime = service.runtime(sid)
    method = style_method(runtime.session)
    settings = await call("GET", "/settings")
    assert settings["explanation_depth"] == settings["explanation_presentation"] == "adaptive"
    assert "# Learner-selected response preferences" not in system_prompt(runtime.session, runtime.tools)
    await call("PATCH", "/settings", {"explanation_depth": "brief", "explanation_presentation": "structured"})
    # The change reaches the already open lesson without touching its method or messages.
    assert style_method(runtime.session) == method
    assert "keep the answer compact" in style_presentation(runtime.session, runtime.tools.store)
    assert "descriptively named sections" in style_presentation(runtime.session, runtime.tools.store)
    assert "# Learner-selected response preferences" in system_prompt(runtime.session, runtime.tools)
    assert runtime.session.messages == []
    # Persisted with the other agent settings and shared by every lesson.
    assert Store(service.store.root).prefs["explanation_depth"] == "brief"
    other = await call("POST", "/sessions", {"course_id": course["id"]}, status=201)
    other_runtime = service.runtime(other["id"])
    state = json.loads(next(m["content"] for m in request_context(runtime.session, runtime.tools)
                            if m["role"] == "context").split("\n", 1)[1])
    assert "keep the answer compact" in state["style_presentation"]
    assert "think it through together" not in state["style_method"]
    assert "keep the answer compact" in style_presentation(other_runtime.session, other_runtime.tools.store)
    # Back to "adaptive": the selected style's own Depth/Presentation lines apply again.
    await call("PATCH", "/settings", {"explanation_depth": "adaptive", "explanation_presentation": "adaptive"})
    assert "# Learner-selected response preferences" not in system_prompt(runtime.session, runtime.tools)
    assert "keep the answer compact" not in style_presentation(runtime.session, runtime.tools.store)


@pytest.mark.parametrize(("field", "invalid"), [
    ("explanation_depth", "huge"), ("explanation_presentation", None), ("explanation_depth", ["brief"]),
])
async def test_invalid_preferences_are_rejected_before_any_setting_is_saved(api, field, invalid):
    service, call = api
    await call("PATCH", "/settings", {"explanation_presentation": "prose", field: invalid}, status=400)
    assert (await call("GET", "/settings"))["explanation_presentation"] == "adaptive"


async def test_invalid_style_is_rejected(api):
    service, call = api
    course = await call("POST", "/courses", {"name": "Validation"}, status=201)
    lesson = await call("POST", "/sessions", {"course_id": course["id"]}, status=201)
    events = list(service.runtime(lesson["id"]).session.events)
    await call("PUT", "/sessions/{id}/style", {"explanation_style": "../teacher"}, lesson["id"], status=400)
    assert service.runtime(lesson["id"]).session.events == events
    await call("POST", "/sessions", {"course_id": course["id"], "explanation_style": "../teacher"}, status=400)
    assert len(service.runtimes) == 1


async def test_legacy_per_lesson_preferences_are_ignored(api):
    service, call = api
    course = await call("POST", "/courses", {"name": "Legacy"}, status=201)
    lesson = await call("POST", "/sessions", {"course_id": course["id"]}, status=201)
    runtime = service.runtime(lesson["id"])
    runtime.session.append("explanation_style", explanation_style="quick_take", depth="brief", presentation="prose")
    await service.close_session(lesson["id"])
    restored = await call("GET", "/sessions/{id}", sid=lesson["id"])
    assert restored["explanation_style"] == "quick_take"
    assert "explanation_depth" not in restored and "explanation_presentation" not in restored
    runtime = service.runtime(lesson["id"])
    assert "# Learner-selected response preferences" not in system_prompt(runtime.session, runtime.tools)
