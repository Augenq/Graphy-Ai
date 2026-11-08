/**
 * Streaming markdown is cut into chunks at "stable" boundaries: a blank line that is outside a code fence and outside a
 * math block, and that does not separate the parts of one list / quote. Everything before such a boundary can no longer
 * change while more text arrives, so a chunk can be rendered once and kept; only the last (open) chunk is parsed again.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s/;
const REF = /^ {0,3}\[[^\]\n]+\]:\s|\[\^[^\]\n]+\]/m;
const count = (s: string, sub: string) => s.split(sub).length - 1;

export function splitStable(text: string): string[] {
  if (REF.test(text)) return [text];
  const chunks: string[] = [];
  let start = 0;
  let pos = 0;
  let fence = "";
  let dollars = false;
  let bracket = 0;
  let prevBlockList = false;
  let prevBlockQuote = false;
  let sawBlank = false;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    if (nl === -1) break; // partial last line: decided when it is complete
    const end = nl;
    const line = text.slice(pos, end);
    const blank = line.trim() === "";
    if (!blank && sawBlank && !fence && !dollars && bracket === 0) {
      const indented = /^( {2,}|\t)/.test(line);
      const list = LIST.test(line);
      const quote = line.trimStart().startsWith(">");
      if (!indented && !(list && prevBlockList) && !(quote && prevBlockQuote)) {
        chunks.push(text.slice(start, pos));
        start = pos;
      }
    }
    if (blank) sawBlank = true;
    else if (!/^( {2,}|\t)/.test(line) && (sawBlank || pos === 0)) {
      sawBlank = false;
      prevBlockList = LIST.test(line);
      prevBlockQuote = line.trimStart().startsWith(">");
    } else if (!blank) sawBlank = false;
    const fm = FENCE.exec(line);
    if (fence) {
      if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length && line.trim() === fm[1]) fence = "";
    } else if (fm) {
      fence = fm[1];
    } else if (!blank) {
      if (count(line, "$$") % 2 === 1) dollars = !dollars;
      bracket = Math.max(0, bracket + count(line, "\\[") - count(line, "\\]"));
    }
    pos = end + 1;
  }
  chunks.push(text.slice(start));
  return chunks;
}
