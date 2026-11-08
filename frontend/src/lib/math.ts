/**
 * Models write math in whatever shape they like: `$$…$$` right inside a paragraph, `\[…\]`, `\(…\)`.
 * remark-math understands `$…$` and `$$…$$` as blocks of their own, so the text is rewritten into that shape
 * before rendering: display formulas become blocks separated by blank lines, formulas in the middle of a
 * sentence become inline. Code (fenced or inline) is never touched.
 */

const CODE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g;

/** What replaces a `$$…$$` found at [start, end) of `text`: a range of the text and its new content. */
function place(text: string, start: number, end: number, body: string): { from: number; to: number; text: string } {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const found = text.indexOf("\n", end);
  const lineEnd = found === -1 ? text.length : found;
  const before = text.slice(lineStart, start);
  const after = text.slice(end, lineEnd);
  const inner = body.trim();
  if (!inner) return { from: start, to: end, text: "" };
  const alone = !before.trim() && !after.trim();
  if (!alone && !inner.includes("\n")) return { from: start, to: end, text: `$${inner}$` };
  // keep the indentation of a list item, so the formula stays inside it
  const indent = /^[ \t]*/.exec(before)?.[0] ?? "";
  const lines = inner.split("\n").map((l) => indent + l.trim());
  const block = `${indent}$$\n${lines.join("\n")}\n${indent}$$`;
  if (!alone) {
    return { from: start, to: end, text: `${before.trim() ? "\n\n" : ""}$$\n${lines.join("\n")}\n${indent}$$${after.trim() ? "\n\n" : ""}` };
  }
  const previous = text.slice(0, Math.max(0, lineStart - 1));
  const next = text.slice(Math.min(text.length, lineEnd + 1));
  const lead = previous && !previous.endsWith("\n") ? "\n" : "";
  const trail = next && !next.startsWith("\n") ? "\n" : "";
  return { from: lineStart, to: lineEnd, text: lead + block + trail };
}

function convert(segment: string): string {
  let s = segment;
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, (_m, body: string) => `$${body.trim()}$`);
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_m, body: string) => `$$${body}$$`);
  let out = "";
  let last = 0;
  for (const m of s.matchAll(/\$\$([\s\S]*?)\$\$/g)) {
    const start = m.index ?? 0;
    const put = place(s, start, start + m[0].length, m[1]);
    const from = Math.max(put.from, last);
    out += s.slice(last, from) + put.text;
    last = Math.max(put.to, last);
  }
  out += s.slice(last);
  return out.replace(/\n{3,}/g, "\n\n");
}

export function normalizeMath(md: string): string {
  if (!md.includes("$$") && !md.includes("\\(") && !md.includes("\\[")) return md;
  return md
    .split(CODE)
    .map((part, i) => (i % 2 ? part : convert(part)))
    .join("");
}

/** While text is still streaming, hide constructs that would otherwise flash as raw source. */
export function repairStreaming(md: string): string {
  let out = md;
  const fences = (out.match(/^```/gm) ?? []).length;
  if (fences % 2 === 1) return out + "\n```";
  const open = (a: string, b: string) => out.split(a).length - out.split(b).length;
  for (const [a, b] of [["\\[", "\\]"], ["\\(", "\\)"]] as const) {
    if (open(a, b) > 0) out = out.slice(0, out.lastIndexOf(a));
  }
  const dd = out.split("$$").length - 1;
  if (dd % 2 === 1) return out.slice(0, out.lastIndexOf("$$"));
  const singles = out.replace(/\$\$/g, "").split("$").length - 1;
  if (singles % 2 === 1) out = out.slice(0, out.lastIndexOf("$"));
  return out;
}
