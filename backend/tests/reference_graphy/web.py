"""Bounded web search, page reading and source selection for a single teacher."""

import hashlib
import json
import os
from html.parser import HTMLParser
from urllib.parse import parse_qs, parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

import httpx

from .questions import TEXT, obj
from .storage import read_json, write_json

MAX_BYTES = 512 * 1024
MAX_TEXT = 12000
USER_AGENT = "graphy-learning/0.3"
SEARCH_SCHEMA = obj({"query": TEXT | {"maxLength": 512},
                     "limit": {"type": "integer", "minimum": 1, "maximum": 10}}, ["query"])
READ_SCHEMA = obj({"url": TEXT | {"maxLength": 4096}}, ["url"])
# SearXNG runs on this machine (`npm run search`): no key, no sign-up, no rate limit of its own.
PROVIDERS = ("searxng", "duckduckgo", "brave")
DEFAULT_PROVIDER = "searxng"
DEFAULT_SEARXNG_URL = "http://127.0.0.1:8888"
DEFINITIONS = {
    "web_search": ("Search the web: titles, URLs, snippets (not verified page text).", SEARCH_SCHEMA),
    "web_read": ("Read an HTTP(S) page; cite its URL.", READ_SCHEMA),
}


def canonical_url(value):
    parts = urlsplit(value)
    if (parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password):
        raise ValueError("Use an HTTP(S) URL without embedded credentials")
    _ = parts.port
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if not k.lower().startswith("utm_") and k.lower() not in ("fbclid", "gclid")]
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path or "/", urlencode(query), ""))


class SearchHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.results = []
        self.anchor = None
        self.snippet = None
        self.depth = 0

    def handle_starttag(self, tag, attrs):
        data = dict(attrs)
        if tag == "a" and "result__a" in data.get("class", "").split():
            self.anchor = {"url": data.get("href", ""), "title": "", "snippet": ""}
        if "result__snippet" in data.get("class", "").split():
            self.snippet = {"tag": tag, "depth": 1, "text": ""}
        elif self.snippet and tag not in ("br", "img", "meta", "input", "hr", "link"):
            self.snippet["depth"] += 1

    def handle_endtag(self, tag):
        if tag == "a" and self.anchor is not None:
            self.results.append(self.anchor)
            self.anchor = None
        if self.snippet:
            self.snippet["depth"] -= 1
            if self.snippet["depth"] <= 0:
                if self.results:
                    self.results[-1]["snippet"] = self.snippet["text"].strip()
                self.snippet = None

    def handle_data(self, data):
        if self.anchor is not None:
            self.anchor["title"] += data
        if self.snippet:
            self.snippet["text"] += data


class PageHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.author = ""
        self.published = ""
        self.parts = []
        self.hidden = 0
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript", "svg", "nav", "footer"):
            self.hidden += 1
        if tag == "title":
            self.in_title = True
        if tag == "meta":
            data = dict(attrs)
            key = (data.get("name") or data.get("property") or "").lower()
            if key == "author":
                self.author = data.get("content", "")
            if key in ("article:published_time", "date", "dc.date"):
                self.published = data.get("content", "")
        if tag in ("p", "div", "article", "section", "li", "br", "h1", "h2", "h3", "pre", "tr"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript", "svg", "nav", "footer"):
            self.hidden = max(0, self.hidden - 1)
        if tag == "title":
            self.in_title = False

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        elif not self.hidden:
            self.parts.append(data)

    def text(self):
        return "\n".join(line for part in "".join(self.parts).splitlines()
                         if (line := " ".join(part.split())))


class WebResearch:
    def __init__(self, store=None, *, client=None, cache_dir=None):
        self.store, self.client = store, client
        self._owned = client is None
        self.snapshots: dict[str, dict] = {}
        self.cache_dir = cache_dir

    async def close(self):
        if self._owned and self.client:
            await self.client.aclose()
            self.client = None

    async def _get(self, url, *, params=None, headers=None):
        if self.client is None:
            self.client = httpx.AsyncClient(timeout=12, follow_redirects=True, max_redirects=5)
        async with self.client.stream("GET", canonical_url(url), params=params,
                                      headers={"User-Agent": USER_AGENT, **(headers or {})}) as response:
            response.raise_for_status()
            url = canonical_url(str(response.url))
            mime = response.headers.get("content-type", "").split(";", 1)[0].lower()
            if mime == "application/pdf" or urlsplit(url).path.lower().endswith(".pdf"):
                return {"url": url, "mime": mime, "body": "", "document": True, "truncated": False}
            if mime and mime not in ("text/html", "text/plain", "application/xhtml+xml", "application/json"):
                raise ValueError(f"Unsupported web content type: {mime}; process the document with bash")
            chunks, size, truncated = [], 0, False
            async for chunk in response.aiter_bytes():
                room = MAX_BYTES - size
                chunks.append(chunk[:room])
                size += len(chunk[:room])
                if len(chunk) > room or size >= MAX_BYTES:
                    truncated = True
                    break
            encoding = response.encoding or "utf-8"
            return {"url": url, "mime": mime, "body": b"".join(chunks).decode(encoding, errors="replace"),
                    "document": False, "truncated": truncated}

    @property
    def searxng_url(self):
        prefs = self.store.prefs if self.store else {}
        return (prefs.get("searxng_url") or os.environ.get("SEARXNG_URL") or DEFAULT_SEARXNG_URL).rstrip("/")

    async def _searxng(self, query):
        result = await self._get(self.searxng_url + "/search", params={"q": query, "format": "json"})
        try:
            data = json.loads(result["body"])
            rows = data["results"]
        except (ValueError, KeyError, TypeError):
            raise ValueError("SearXNG did not answer with JSON: allow `formats: [html, json]` in its settings.yml") from None
        if not rows and data.get("unresponsive_engines"):
            raise ValueError("every SearXNG engine failed: " + ", ".join(
                f"{name} ({why})" for name, why in data["unresponsive_engines"][:4]))
        return [{"title": r.get("title") or "", "url": r.get("url") or "", "snippet": r.get("content") or ""}
                for r in rows if isinstance(r, dict)]

    async def search(self, query, limit=6):
        if not query.strip():
            raise ValueError("query must not be empty")
        provider = self.store.prefs.get("web_provider", DEFAULT_PROVIDER) if self.store else DEFAULT_PROVIDER
        note = ""
        if provider == "searxng":
            try:
                raw = await self._searxng(query)
            except (httpx.HTTPError, ValueError) as error:
                # the local instance is not running or not configured: the agent must still be able to search
                why = ("is not running" if isinstance(error, (httpx.ConnectError, httpx.TimeoutException))
                       else f"answered with HTTP {error.response.status_code}" if isinstance(error, httpx.HTTPStatusError)
                       else f"failed: {error}")
                note = (f"SearXNG at {self.searxng_url} {why[:200]}; DuckDuckGo was used instead "
                        "(start SearXNG with `npm run search`)")
                provider = "duckduckgo"
        if provider == "brave":
            key = (self.store.credential("web-search").get("key", "") if self.store else "")
            key = key or os.environ.get("BRAVE_SEARCH_API_KEY", "")
            if not key:
                raise ValueError("Brave Search needs an API key. Configure /web or BRAVE_SEARCH_API_KEY")
            result = await self._get("https://api.search.brave.com/res/v1/web/search",
                                     params={"q": query, "count": limit},
                                     headers={"Accept": "application/json", "X-Subscription-Token": key})
            raw = json.loads(result["body"]).get("web", {}).get("results", [])
            raw = [{"title": r.get("title", ""), "url": r.get("url", ""),
                    "snippet": r.get("description", "")} for r in raw if isinstance(r, dict)]
        elif provider == "searxng":
            pass  # raw results are already in hand
        elif provider == "duckduckgo":
            result = await self._get("https://html.duckduckgo.com/html/", params={"q": query})
            parser = SearchHTML()
            parser.feed(result["body"])
            raw = parser.results
            if not raw and any(marker in result["body"].lower() for marker in (
                    "anomaly.js", "challenge-form", "bots use duckduckgo")):
                raise ValueError("DuckDuckGo requested a CAPTCHA. Try later, start SearXNG (`npm run search`) "
                                 "or configure Brave Search via /web")
        else:
            raise ValueError("Unknown web search provider; configure /web")
        results, seen = [], set()
        for row in raw:
            url = urljoin("https://duckduckgo.com", row["url"])
            parsed = urlsplit(url)
            if parsed.hostname and parsed.hostname.endswith("duckduckgo.com"):
                url = parse_qs(parsed.query).get("uddg", [""])[0]
            try:
                url = canonical_url(url)
            except ValueError:
                continue
            if url in seen:
                continue
            seen.add(url)
            results.append({"title": " ".join(row["title"].split())[:300] or url,
                            "url": url, "snippet": " ".join(row["snippet"].split())[:1000],
                            "status": "snippet"})
            if len(results) == limit:
                break
        return {"query": query, "provider": provider, "results": results, **({"note": note} if note else {})}

    async def read(self, url, offset=1, limit=120, column=1):
        if (type(offset) is not int or type(limit) is not int or type(column) is not int
                or offset < 1 or column < 1 or not 1 <= limit <= 300):
            raise ValueError("offset/column start at 1; limit must be from 1 to 300 lines")
        url = canonical_url(url)
        cache = self.cache_dir / (hashlib.sha256(url.encode()).hexdigest() + ".json") if self.cache_dir else None
        if url in self.snapshots:
            snapshot = self.snapshots[url]
        else:
            try:
                snapshot = read_json(cache, {}) if cache else {}
            except ValueError:
                snapshot = {}  # a damaged cache entry is only a cache: fetch the page again
            if not snapshot:
                snapshot = await self._read_snapshot(url)
                if cache:
                    write_json(cache, snapshot)
            if len(self.snapshots) >= 8:
                self.snapshots.pop(next(iter(self.snapshots)))
            self.snapshots[url] = snapshot
        if snapshot["status"] == "document":
            return dict(snapshot)
        lines = snapshot["text"].splitlines(keepends=True)
        selected: list[str] = []
        size, end, next_column = 0, offset - 1, None
        for index, line in enumerate(lines[offset - 1:offset - 1 + limit], offset):
            start = column - 1 if index == offset else 0
            if start > len(line):
                raise ValueError("column exceeds this snapshot line")
            part = line[start:start + MAX_TEXT - size]
            selected.append(part)
            size += len(part)
            if len(part) < len(line) - start:
                end, next_column = index, start + len(part) + 1
                break
            end = index
            if size >= MAX_TEXT:
                break
        more = next_column is not None or end < len(lines)
        return snapshot | {"text": "".join(selected), "offset": offset, "end": end,
                           "next_offset": (end if next_column else end + 1) if more else None,
                           "next_column": next_column,
                           "truncated": more or snapshot["truncated"]}

    async def _read_snapshot(self, url):
        page = await self._get(url)
        if page["document"]:
            return {"url": page["url"], "title": urlsplit(page["url"]).path.rsplit("/", 1)[-1][:300] or "PDF",
                    "status": "document", "text": "", "author": "", "published": "",
                    "note": "Document is reachable. Use bash to download/extract text, e.g. pdftotext if installed."}
        if page["mime"] in ("text/plain", "application/json"):
            text, title, author, published = page["body"], page["url"], "", ""
        else:
            parser = PageHTML()
            parser.feed(page["body"])
            text, title, author, published = parser.text(), parser.title.strip(), parser.author, parser.published
        if not text.strip():
            raise ValueError("The page has no readable text (it may require JavaScript or login)")
        return {"url": page["url"], "title": title[:300] or page["url"], "status": "read",
                "text": text, "author": author[:300], "published": published[:100],
                "snapshot": hashlib.sha256(text.encode()).hexdigest()[:12], "truncated": page["truncated"]}

    def _error(self, error):
        text = str(error)
        return (self.store.redact(text) if self.store else text)[:500]
