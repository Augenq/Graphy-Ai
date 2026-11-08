import { useSyncExternalStore } from "react";

/**
 * Find in chat. The search runs over the rendered transcript (no DOM rewriting): text nodes are joined per block,
 * matches become Ranges, and the CSS Custom Highlight API paints them. Folded rows (reasoning, tool details) are not
 * in the DOM, so while a query is active they ask `useFindForce` whether their text matches and open themselves.
 */

export interface FindQuery {
  query: string;
  caseSensitive: boolean;
}

let current: FindQuery = { query: "", caseSensitive: false };
const listeners = new Set<() => void>();

export function setFindQuery(next: FindQuery) {
  if (next.query === current.query && next.caseSensitive === current.caseSensitive) return;
  current = next;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/** Lower-casing that never changes the string length, so offsets of the folded text stay valid. */
export function fold(s: string, caseSensitive: boolean): string {
  if (caseSensitive) return s;
  let out = "";
  for (const ch of s) {
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out;
}

export const textMatches = (text: string | undefined, q: FindQuery) =>
  !!text && q.query.length > 0 && fold(text, q.caseSensitive).includes(fold(q.query, q.caseSensitive));

/** True while the find bar holds a query that occurs in `text`: a folded row opens to show it. */
export function useFindForce(...texts: (string | undefined)[]): boolean {
  return useSyncExternalStore(subscribe, () => texts.some((x) => textMatches(x, current)));
}

const BLOCK = "p,li,div,h1,h2,h3,h4,h5,h6,pre,td,th,blockquote,section,button,summary";

/** Never searched: LaTeX source in the KaTeX MathML twin, icon ligatures, copy buttons, scripts, widget frames. */
const SKIP = "script,style,iframe,[data-find-skip],.katex-mathml,.copy-action,md-icon,md-ripple,md-focus-ring,[role=tooltip]";

/** Not on screen: display:none / visibility:hidden, or aria-hidden outside KaTeX's visible layer (which is aria-hidden by design). */
function hidden(el: Element): boolean {
  const vis = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (vis && !vis.call(el, { visibilityProperty: true })) return true;
  const aria = el.closest('[aria-hidden="true"]');
  return !!aria && !aria.closest(".katex-html") && !aria.classList.contains("katex-html");
}

/** All occurrences of the query under `root`, in document order. Matches never span two blocks. */
export function findMatches(root: HTMLElement, q: FindQuery): Range[] {
  if (!q.query) return [];
  const needle = fold(q.query, q.caseSensitive);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      if (!p || p.closest(SKIP) || hidden(p)) return NodeFilter.FILTER_REJECT;
      return n.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: { node: Text; start: number }[] = [];
  let joined = "";
  let lastBlock: Element | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const block = n.parentElement!.closest(BLOCK);
    if (lastBlock && block !== lastBlock) joined += "\u0000";
    lastBlock = block;
    nodes.push({ node: n, start: joined.length });
    joined += n.nodeValue!;
  }
  const hay = fold(joined, q.caseSensitive);
  const at = (offset: number, end: boolean) => {
    // binary search: the node containing `offset` (for an end offset, the node whose text ends there)
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (nodes[mid].start < offset || (!end && nodes[mid].start === offset)) lo = mid;
      else hi = mid - 1;
    }
    return { node: nodes[lo].node, offset: offset - nodes[lo].start };
  };
  const out: Range[] = [];
  for (let i = hay.indexOf(needle); i >= 0 && out.length < 2000; i = hay.indexOf(needle, i + needle.length)) {
    const a = at(i, false);
    const b = at(i + needle.length, true);
    const r = document.createRange();
    r.setStart(a.node, Math.min(a.offset, a.node.length));
    r.setEnd(b.node, Math.min(b.offset, b.node.length));
    out.push(r);
  }
  return out;
}

type Highlights = { set(name: string, h: unknown): void; delete(name: string): void };
const registry = (): Highlights | undefined => (CSS as unknown as { highlights?: Highlights }).highlights;
export const highlightSupported = () => !!registry() && typeof (window as unknown as { Highlight?: unknown }).Highlight === "function";

/** Paints all matches and the current one. Without the Highlight API the current match is selected instead. */
export function paint(ranges: Range[], index: number) {
  const reg = registry();
  const H = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (reg && H) {
    reg.set("graphy-find", new H(...ranges));
    reg.set("graphy-find-current", ranges[index] ? new H(ranges[index]) : new H());
    return;
  }
  const sel = getSelection();
  sel?.removeAllRanges();
  if (ranges[index]) sel?.addRange(ranges[index]);
}

export function clearPaint() {
  const reg = registry();
  reg?.delete("graphy-find");
  reg?.delete("graphy-find-current");
}

/** Scrolls `scroller` so the range sits in the upper third of the view. */
export function reveal(scroller: HTMLElement, range: Range) {
  const r = range.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  if (r.top >= box.top + 56 && r.bottom <= box.bottom - 24) return;
  scroller.scrollTop += r.top - box.top - box.height / 3;
}
