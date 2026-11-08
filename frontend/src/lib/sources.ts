import type { Block } from "./types";

export interface Source { url: string; title: string }
type Action = Extract<Block, { kind: "action" }>;
type Hit = { url?: unknown; title?: unknown };

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The links one tool call returned. Parsed once per action block object (blocks are replaced, never mutated). */
const parsed = new WeakMap<Action, Source[]>();

function hitsOf(a: Action): Source[] {
  const out: Source[] = [];
  const add = (url: unknown, title: unknown) => {
    try {
      if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) return;
      const u = url.trim();
      out.push({ url: u, title: text(title) || new URL(u).hostname.replace(/^www\./, "") });
    } catch {
      /* a malformed URL drops only itself */
    }
  };
  try {
    if (a.state !== "done" || (a.tool !== "web_search" && a.tool !== "researcher" && a.tool !== "web_read")) return out;
    let data: { url?: unknown; title?: unknown; results?: Hit[]; sources?: Hit[] } | null = null;
    try { data = a.output ? JSON.parse(a.output) : null; } catch { /* not JSON */ }
    if (a.tool === "web_read") add(data?.url ?? a.detail, data?.title ?? a.result);
    for (const r of Array.isArray(data?.results) ? data.results : []) add(r?.url, r?.title);
    for (const r of Array.isArray(data?.sources) ? data.sources : []) add(r?.url, r?.title);
  } catch {
    /* nothing to list */
  }
  return out;
}

/** Links tools already returned (web_search results, researcher sources, a page that was read), de-duplicated. Never throws. */
export function sourcesOf(actions: Action[]): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const a of actions) {
    let hits = parsed.get(a);
    if (!hits) parsed.set(a, (hits = hitsOf(a)));
    for (const h of hits) {
      const key = h.url.replace(/#.*$/, "").replace(/\/$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(h);
    }
  }
  return out;
}
