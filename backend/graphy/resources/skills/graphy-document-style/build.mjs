#!/usr/bin/env node
// Graphy document builder: turns a source HTML file (body markup + LaTeX math in $...$ / $$...$$)
// into ONE self-contained HTML file: document.css and Computer Modern fonts are inlined (data: URIs),
// math is rendered to MathML with KaTeX (no scripts, works in the sandboxed viewer and in print).
//
//   node build.mjs source.html output.html [--flat]   (--flat: numbers without section prefix, for documents with no <h2>)
//   node build.mjs slides.src.html deck.html --slides  (slide deck: every top-level <section> is a 16:9 slide, prints one slide per page)
//
// The source may be a full document or just the markup that goes inside <main class="doc">: a missing shell is added.
// Needs only Node (no npm install): katex.min.cjs lies next to this file.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const katex = createRequire(import.meta.url)("./katex.min.cjs");
const flat = process.argv.includes("--flat");
const slides = process.argv.includes("--slides");
const [src, out] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!src || !out) { console.error("usage: node build.mjs source.html output.html"); process.exit(2); }

const face = (family, file, style = "normal", weight = 400) =>
  `@font-face{font-family:"${family}";font-style:${style};font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${fs.readFileSync(path.join(here, "fonts", file)).toString("base64")}) format("woff2")}`;
const fonts = [
  face("Graphy CM", "CMUSerif-Roman.woff2"), face("Graphy CM", "CMUSerif-Italic.woff2", "italic"),
  face("Graphy CM", "CMUSerif-Bold.woff2", "normal", 700), face("Graphy CM", "CMUSerif-BoldItalic.woff2", "italic", 700),
  face("Graphy Mono", "CMUTypewriter-Regular.woff2"), face("Graphy Math", "LatinModernMath.woff2"),
].join("\n");
const css = fs.readFileSync(path.join(here, "document.css"), "utf8") + (slides ? "\n" + fs.readFileSync(path.join(here, "slides.css"), "utf8") : "");

const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/<br\s*\/?>/g, " ");
let bad = 0;
const render = (tex, display) => {
  try {
    const m = katex.renderToString(decode(tex).trim(), { output: "mathml", displayMode: display, throwOnError: true, strict: "ignore", trust: false });
    // a minus or plus right after an opening sign is unary: MathML needs form="prefix" to drop the infix spacing
    const clean = m.replace(/<annotation[\s\S]*?<\/annotation>/g, "")
      .replace(/(<mo[^>]*>(?:\(|\[|\{|,|;|=|≤|≥|&lt;|&gt;|\+|−|±|⇒|⇔|→|:)<\/mo>)<mo>([−+±])<\/mo>/g, '$1<mo form="prefix">$2</mo>').replace(/<span class="katex-display">([\s\S]*)<\/span>$/, "$1");
    return display ? `<div class="display">${clean}</div>` : clean;
  } catch (e) { bad++; console.error("math error:", String(e.message).split("\n")[0], "in", tex.slice(0, 80)); return `<span style="color:#b00">[${tex.replace(/</g, "&lt;")}]</span>`; }
};
// split into raw regions (skipped) and text regions (math is replaced)
const SKIP = /<(pre|code|script|style|math|textarea|svg)\b[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi;
const mathify = (html) => {
  let res = "", last = 0, m;
  const text = (t) => t
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, x) => render(x, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, x) => render(x, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, x) => render(x, false))
    .replace(/(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\w$])/g, (_, x) => render(x, false));
  // math may contain a raw "<": only code, scripts, svg, comments and ready MathML are skipped
  while ((m = SKIP.exec(html))) { res += text(html.slice(last, m.index)) + m[0]; last = m.index + m[0].length; }
  return res + text(html.slice(last));
};

let html = fs.readFileSync(src, "utf8");
const hasShell = /<html[\s>]/i.test(html);
html = mathify(html);
const style = `<style>\n${fonts}\n${css}\n</style>`;
if (!hasShell) {
  const t = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [, "Документ"])[1].replace(/<[^>]+>/g, "").trim();
  html = `<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${t}</title>\n${style}\n</head>\n<body>\n<main class="${slides ? "deck" : "doc"}${flat ? " flat" : ""}">\n${html}\n</main>\n</body>\n</html>\n`;
} else if (/<!--\s*graphy-style\s*-->/i.test(html)) html = html.replace(/<!--\s*graphy-style\s*-->/i, () => style);
else html = html.replace(/<\/head>/i, () => `${style}\n</head>`);
fs.writeFileSync(out, html);
console.log(`${out}: ${(fs.statSync(out).size / 1024).toFixed(0)} KiB${bad ? `, ${bad} math error(s)` : ""}`);
process.exit(bad ? 1 : 0);
