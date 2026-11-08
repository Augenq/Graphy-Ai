import asyncio
import json

import httpx
import pytest
from reference_graphy.learning_tools import LearningTools
from reference_graphy.session import Session
from reference_graphy.storage import Store
from reference_graphy.web import MAX_BYTES, MAX_TEXT, WebResearch, canonical_url


def search_html():
    return '''<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fschool.edu%2Fmath%3Futm_source%3Dx">Math course</a>
    <div class="result__snippet">Learn <b>math</b> here</div>
    <a class="result__a" href="https://school.edu/math">Duplicate</a>
    <a class="result__a" href="javascript:bad">Invalid</a>
    <a class="result__a" href="https://other.edu/math">Other math</a>
    <div class="result__snippet">Exercises</div>'''


async def test_search_deduplicates_redirects_and_nested_snippets():
    async with httpx.AsyncClient(transport=httpx.MockTransport(
            lambda r: httpx.Response(200, text=search_html()))) as client:
        result = await WebResearch(client=client).search('math')
    assert [r['url'] for r in result['results']] == ['https://school.edu/math', 'https://other.edu/math']
    assert result['results'][0]['snippet'] == 'Learn math here'
    assert all(r['status'] == 'snippet' for r in result['results'])


async def test_captcha_is_error_not_empty_success():
    async with httpx.AsyncClient(transport=httpx.MockTransport(
            lambda r: httpx.Response(200, text='<form id="challenge-form">bots use DuckDuckGo</form>'))) as client:
        with pytest.raises(ValueError, match='CAPTCHA'):
            await WebResearch(client=client).search('math')


def searxng_json(*results, unresponsive=()):
    return {"results": [{"title": t, "url": u, "content": c} for t, u, c in results],
            "unresponsive_engines": [list(x) for x in unresponsive]}


async def test_searxng_is_the_default_and_needs_no_key():
    seen = []

    def respond(request):
        seen.append(request)
        return httpx.Response(200, json=searxng_json(
            ("Math", "https://school.edu/math?utm_source=x", "Course"), ("Dup", "https://school.edu/math", "again"),
            ("Other", "https://other.edu/math", "More")), headers={"content-type": "application/json"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await WebResearch(client=client).search("производная", limit=5)
    assert [(request.url.host, request.url.path) for request in seen] == [("127.0.0.1", "/search")]
    assert seen[0].url.params["format"] == "json" and seen[0].url.params["q"] == "производная"
    assert result["provider"] == "searxng" and "note" not in result
    assert [r["url"] for r in result["results"]] == ["https://school.edu/math", "https://other.edu/math"]
    assert result["results"][0]["snippet"] == "Course"


async def test_searxng_address_comes_from_settings(tmp_path):
    store = Store(tmp_path)
    store.prefs["searxng_url"] = "http://search.lan:9000/"
    hosts = []

    def respond(request):
        hosts.append((request.url.host, request.url.port))
        return httpx.Response(200, json=searxng_json(("Math", "https://school.edu/math", "")),
                              headers={"content-type": "application/json"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        await WebResearch(store, client=client).search("math")
    assert hosts == [("search.lan", 9000)]


@pytest.mark.parametrize("failure", ["down", "json_off", "engines_failed", "not_json"])
async def test_search_falls_back_to_duckduckgo_when_searxng_cannot_answer(failure):
    def respond(request):
        if request.url.host != "127.0.0.1":
            return httpx.Response(200, text=search_html())
        if failure == "down":
            raise httpx.ConnectError("refused", request=request)
        if failure == "json_off":
            return httpx.Response(403, text="forbidden")
        if failure == "engines_failed":
            return httpx.Response(200, json=searxng_json(unresponsive=[("brave", "CAPTCHA")]),
                                  headers={"content-type": "application/json"})
        return httpx.Response(200, text="<html>no json</html>", headers={"content-type": "text/html"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await WebResearch(client=client).search("math")
    assert result["provider"] == "duckduckgo" and "npm run search" in result["note"]
    assert [r["url"] for r in result["results"]] == ["https://school.edu/math", "https://other.edu/math"]


async def test_searxng_with_no_hits_is_an_empty_answer_not_a_fallback():
    seen = []

    def respond(request):
        seen.append(request.url.host)
        return httpx.Response(200, json=searxng_json(), headers={"content-type": "application/json"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await WebResearch(client=client).search("zzzzqqqq")
    assert seen == ["127.0.0.1"] and result["results"] == [] and result["provider"] == "searxng"


async def test_brave_key_only_sent_to_search(tmp_path):
    store = Store(tmp_path)
    store.prefs['web_provider'] = 'brave'
    seen = []

    def respond(request):
        seen.append(request)
        if request.url.host == 'api.search.brave.com':
            return httpx.Response(200, json={'web': {'results': [
                {'title': 'Math', 'url': 'https://school.edu/math', 'description': 'Course'}]}},
                headers={'content-type': 'application/json'})
        return httpx.Response(200, text='<title>Course</title><p>Real material</p>')

    # Credential is deliberately stored through the same API used by /web.
    store.set_credential('web-search', {'key': 'test-private-key'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        web = WebResearch(store, client=client)
        result = await web.search('math', limit=3)
        await web.read(result['results'][0]['url'])
    assert seen[0].headers['X-Subscription-Token'] == 'test-private-key'
    assert seen[0].url.params['count'] == '3'
    assert 'X-Subscription-Token' not in seen[1].headers


async def test_read_metadata_limits_and_document_status():
    def respond(request):
        if request.url.path.endswith('.pdf'):
            return httpx.Response(200, content=b'%PDF', headers={'content-type': 'application/pdf'})
        return httpx.Response(200, text='<title>Algebra</title><meta name="author" content="Teacher">'
            '<meta property="article:published_time" content="2025-01-01">'
            '<nav>Ignore navigation</nav><script>Ignore script</script><p>' + 'a' * (MAX_BYTES + 5) + '</p>', headers={'content-type': 'text/html'})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        web = WebResearch(client=client)
        page = await web.read('https://school.edu/math')
        assert page['title'] == 'Algebra' and page['author'] == 'Teacher'
        assert page['published'] == '2025-01-01'
        assert page['truncated'] and len(page['text']) == MAX_TEXT
        assert 'Ignore' not in page['text']
        document = await web.read('https://school.edu/book.pdf')
        assert document['status'] == 'document' and not document['text']


async def test_cancel_search_propagates():
    async def respond(request):
        raise asyncio.CancelledError

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(asyncio.CancelledError):
            await WebResearch(client=client).search('math')


async def test_web_tools_return_results_to_the_model_without_any_source_bookkeeping(tmp_path):
    session = Session(tmp_path, tmp_path)

    def respond(request):
        if request.url.host == 'html.duckduckgo.com':
            return httpx.Response(200, text=search_html())
        return httpx.Response(200, text='<title>Math</title><p>Actual lesson</p>', headers={'content-type': 'text/html'})

    try:
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            tools = LearningTools(tmp_path, session, web=WebResearch(client=client))
            found = await tools.execute({'id': 's', 'name': 'web_search', 'arguments': {'query': 'math'}})
            page = await tools.execute({'id': 'r', 'name': 'web_read', 'arguments': {'url': 'https://school.edu/math'}})
            assert not found.get('error') and 'school.edu/math' in found['content']
            assert not page.get('error') and 'Actual lesson' in page['content']
            names = {d['name'] for d in tools.declarations}
            assert {'web_search', 'web_read'} <= names and not {'find_sources', 'recommend_sources'} & names
            assert not [e for e in session.events if e['type'].startswith('learning_source')]
    finally:
        session.close()


def test_old_chats_with_source_events_still_open_and_ignore_them(tmp_path):
    session = Session(tmp_path, tmp_path)
    path = session.path
    session.close()
    with path.open('a') as stream:
        stream.write(json.dumps({'type': 'learning_sources', 'time': 1, 'data': {
            'sources': [{'url': 'https://school.edu/m', 'title': 'M', 'status': 'snippet', 'excerpt': 'x'}],
            'status': 'partial'}}) + '\n')
        stream.write(json.dumps({'type': 'learning_source_notes', 'time': 2, 'data': {'recommendations': []}}) + '\n')
    reopened = Session(tmp_path, tmp_path, path=path)
    try:
        assert reopened.learning is not None and not hasattr(reopened.learning, 'sources')
    finally:
        reopened.close()


@pytest.mark.parametrize('url', ['file:///tmp/x', 'https://user:secret@site.org', 'javascript:alert(1)'])
def test_invalid_url(url):
    with pytest.raises(ValueError):
        canonical_url(url)


async def test_paged_snapshot_survives_restart_without_losing_long_line_text(tmp_path):
    original = "a" * (MAX_TEXT + 123) + "\nsecond line\nlast line"
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, text=original if len(requests) == 1 else "changed content",
                              headers={"content-type": "text/plain"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        first = await WebResearch(client=client, cache_dir=tmp_path).read("https://school.edu/page", limit=1)
        assert first["next_offset"] == 1 and first["next_column"] == MAX_TEXT + 1
        restored = WebResearch(client=client, cache_dir=tmp_path)
        text, page = first["text"], first
        while page["next_offset"] is not None:
            page = await restored.read("https://school.edu/page", offset=page["next_offset"],
                                       column=page["next_column"] or 1, limit=1)
            assert page["snapshot"] == first["snapshot"]
            text += page["text"]
        assert text == original and len(requests) == 1
