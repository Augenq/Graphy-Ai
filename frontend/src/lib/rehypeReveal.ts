/**
 * Cursor-style reveal: text that arrived while the answer was streaming is wrapped in `<span class="rv">` (a 150 ms
 * linear fade-in, see styles/stream.css). `starts` holds the source offsets where each flush of new text began; the text
 * before the first one is plain. Every flush gets its own span, so spans of earlier flushes keep their place in the DOM and
 * never restart their fade when the next flush is rendered. Code (inline or block) is never wrapped: a code block appears whole.
 */
interface N {
  type: string;
  value?: string;
  tagName?: string;
  children?: N[];
  properties?: Record<string, unknown>;
  position?: { start: { offset?: number }; end: { offset?: number } };
}

export function rehypeReveal(options: { starts: number[] }) {
  const starts = options.starts;
  const first = starts[0];
  const walk = (node: N) => {
    if (!node.children) return;
    if (node.type === "element" && (node.tagName === "code" || node.tagName === "pre")) return;
    const out: N[] = [];
    for (const c of node.children) {
      if (c.type !== "text" || !c.value) {
        walk(c);
        out.push(c);
        continue;
      }
      const s = c.position?.start.offset;
      const e = c.position?.end.offset;
      if (s === undefined || e === undefined || e <= first) {
        out.push(c);
        continue;
      }
      const cuts = starts.filter((b) => b > s && b < e).map((b) => Math.min(c.value!.length - 1, b - s)).filter((i) => i > 0);
      const bounds = [0, ...cuts, c.value.length];
      for (let i = 0; i < bounds.length - 1; i++) {
        const piece = c.value.slice(bounds[i], bounds[i + 1]);
        if (!piece) continue;
        const begin = i === 0 ? s : s + bounds[i];
        if (begin >= first) out.push({ type: "element", tagName: "span", properties: { className: ["rv"] }, children: [{ type: "text", value: piece }] });
        else out.push({ type: "text", value: piece });
      }
    }
    node.children = out;
  };
  return (tree: N) => walk(tree);
}
