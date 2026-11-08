/**
 * Allowlist sanitizers for markup that comes from a model: ```svg and ```html blocks in agent questions.
 * Both parse into an inert document (DOMParser never runs scripts or fetches), rebuild a new tree from allowed
 * elements and attributes only, and serialize that tree. Nothing here ever lets the page reach the network:
 * no external href/src, no url() outside the document, no CSS imports, no scripts, no event handlers.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

const SVG_TAGS = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "defs",
  "lineargradient", "radialgradient", "stop", "title", "desc", "clippath", "marker", "symbol",
]);
const SVG_ATTRS = new Set([
  "viewbox", "width", "height", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "transform",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin",
  "stroke-dasharray", "stroke-dashoffset", "stroke-miterlimit", "opacity", "offset", "stop-color", "stop-opacity",
  "gradientunits", "gradienttransform", "id", "class", "font-family", "font-size", "font-weight", "font-style",
  "text-anchor", "dominant-baseline", "dx", "dy", "clip-path", "marker-start", "marker-mid", "marker-end", "markerwidth",
  "markerheight", "refx", "refy", "orient", "markerunits", "preserveaspectratio", "role", "aria-label", "aria-hidden",
  "clippathunits", "fx", "fy", "spreadmethod", "letter-spacing", "xmlns",
]);
/** A value may mention only a fragment of the same document in url(...), never an address. */
const LOCAL_URL = /^\s*url\(\s*#[\w.\-:]+\s*\)\s*$/;
const BAD_VALUE = /javascript:|vbscript:|data:|@import|expression\s*\(|<|\\/i;

function cleanSvgValue(name: string, value: string): string | null {
  if (BAD_VALUE.test(value) && name !== "d") return null;
  if (/url\s*\(/i.test(value) && !LOCAL_URL.test(value)) return null;
  if (name === "id" || name === "class") return /^[\w\-:.\s]{1,80}$/.test(value) ? value : null;
  return value.length > 4000 ? null : value;
}

function copySvg(from: Element, into: Element, doc: Document, depth: number): void {
  if (depth > 40) return;
  for (const node of Array.from(from.childNodes)) {
    if (node.nodeType === 3) {
      into.appendChild(doc.createTextNode(node.textContent ?? ""));
    } else if (node.nodeType === 1) {
      const el = node as Element;
      const tag = el.localName.toLowerCase();
      if (el.namespaceURI !== SVG_NS) continue; // foreign elements (HTML inside foreignObject etc.) are dropped with their subtree
      if (!SVG_TAGS.has(tag)) continue; // script, style, foreignObject, image, use, a, animate, set ... are dropped with their subtree
      const out = doc.createElementNS(SVG_NS, el.localName);
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on") || !SVG_ATTRS.has(name)) continue;
        const value = cleanSvgValue(name, attr.value);
        if (value !== null) out.setAttribute(attr.name, value);
      }
      copySvg(el, out, doc, depth + 1);
      into.appendChild(out);
    }
  }
}

/** Returns a safe, self-contained SVG string, or null when the input is not an SVG document. */
export function sanitizeSvg(source: string): string | null {
  if (source.length > 100_000) return null;
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = parsed.documentElement;
  if (!root || parsed.querySelector("parsererror") || root.localName.toLowerCase() !== "svg" || root.namespaceURI !== SVG_NS) return null;
  const doc = document.implementation.createDocument(SVG_NS, "svg", null);
  const out = doc.documentElement;
  for (const attr of Array.from(root.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith("on") || !SVG_ATTRS.has(name)) continue;
    const value = cleanSvgValue(name, attr.value);
    if (value !== null) out.setAttribute(attr.name, value);
  }
  copySvg(root, out, doc, 0);
  if (!out.getAttribute("viewBox") && !(out.getAttribute("width") && out.getAttribute("height"))) out.setAttribute("viewBox", "0 0 300 150");
  out.removeAttribute("width");
  out.removeAttribute("height");
  return new XMLSerializer().serializeToString(out);
}

/** An SVG as an image URL: shown through <img>, so even a sanitizer bug could not run script or load anything. */
export const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/* ------------------------------------------------------------------------------------------- HTML */

const HTML_TAGS = new Set([
  "div", "span", "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "strong", "b", "em", "i", "u", "s",
  "code", "pre", "blockquote", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col", "a", "small",
  "sub", "sup", "mark", "details", "summary", "figure", "figcaption", "dl", "dt", "dd", "kbd", "abbr", "img", "section", "article",
  "header", "footer", "aside", "main", "nav", "del", "ins", "q", "cite", "time", "wbr",
]);
/** Elements whose content must vanish with them (everything else unknown is unwrapped, keeping its text). */
const HTML_DROP = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "template", "noscript", "svg", "math", "form",
  "input", "button", "select", "textarea", "link", "meta", "base", "title", "head", "audio", "video", "source", "track", "canvas",
  "dialog", "portal", "slot", "xmp", "plaintext", "noembed", "noframes", "param",
]);
const HTML_ATTRS = new Set(["href", "src", "alt", "title", "colspan", "rowspan", "scope", "open", "lang", "dir", "datetime", "width", "height", "align", "style", "role", "aria-label", "aria-hidden", "cite"]);

/** Style properties that may appear; no url(), no imports, nothing positioned over the page. */
const CSS_PROPS = new Set([
  "color", "background", "background-color", "font-size", "font-weight", "font-style", "font-family", "text-align", "text-decoration",
  "line-height", "letter-spacing", "margin", "margin-top", "margin-bottom", "margin-left", "margin-right", "padding", "padding-top",
  "padding-bottom", "padding-left", "padding-right", "border", "border-top", "border-bottom", "border-left", "border-right",
  "border-radius", "border-color", "border-width", "border-style", "border-collapse", "width", "max-width", "min-width", "height",
  "max-height", "min-height", "display", "gap", "row-gap", "column-gap", "grid-template-columns", "flex", "flex-direction",
  "flex-wrap", "justify-content", "align-items", "white-space", "vertical-align", "opacity", "text-transform", "overflow",
]);
const CSS_BAD = /url\s*\(|image-set|@|expression|javascript:|behavior|binding|\\|<|\/\*|var\s*\(\s*--[^)]*\)\s*,\s*url/i;

export function sanitizeCss(style: string): string {
  const kept: string[] = [];
  for (const part of style.split(";")) {
    const i = part.indexOf(":");
    if (i < 1) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).trim();
    if (!CSS_PROPS.has(prop) || !value || value.length > 200 || CSS_BAD.test(value)) continue;
    if (prop === "display" && !/^(block|inline|inline-block|flex|inline-flex|grid|none)$/i.test(value)) continue;
    kept.push(`${prop}: ${value}`);
  }
  return kept.join("; ");
}

const SAFE_LINK = /^(https?:|mailto:|#)/i;
const SAFE_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

function copyHtml(from: Node, into: Node, doc: Document, depth: number): void {
  if (depth > 40) return;
  for (const node of Array.from(from.childNodes)) {
    if (node.nodeType === 3) {
      into.appendChild(doc.createTextNode(node.textContent ?? ""));
      continue;
    }
    if (node.nodeType !== 1) continue; // comments, processing instructions
    const el = node as Element;
    const tag = el.localName.toLowerCase();
    if (el.namespaceURI !== "http://www.w3.org/1999/xhtml" || HTML_DROP.has(tag)) continue;
    if (!HTML_TAGS.has(tag)) {
      copyHtml(el, into, doc, depth + 1); // unknown: keep its text, lose the element
      continue;
    }
    const out = doc.createElement(tag);
    let drop = false;
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      if (name.startsWith("on") || !HTML_ATTRS.has(name)) continue;
      if (name === "style") {
        const css = sanitizeCss(value);
        if (css) out.setAttribute("style", css);
      } else if (name === "href") {
        if (tag === "a" && SAFE_LINK.test(value.trim())) out.setAttribute("href", value.trim());
      } else if (name === "src") {
        if (tag === "img") {
          if (SAFE_IMAGE.test(value.trim())) out.setAttribute("src", value.trim());
          else drop = true; // a remote or relative picture is never fetched
        }
      } else if (name === "width" || name === "height") {
        if (/^\d{1,4}%?$/.test(value)) out.setAttribute(name, value);
      } else {
        out.setAttribute(name, value.slice(0, 500));
      }
    }
    if (tag === "img" && (drop || !out.getAttribute("src"))) {
      into.appendChild(doc.createTextNode(el.getAttribute("alt") ? `[${el.getAttribute("alt")}]` : ""));
      continue;
    }
    if (tag === "a") {
      out.setAttribute("target", "_blank");
      out.setAttribute("rel", "noopener noreferrer nofollow");
    }
    copyHtml(el, out, doc, depth + 1);
    into.appendChild(out);
  }
}

/** Safe static HTML: formatting, tables, lists, safe colours and layout; no script, form, frame, style sheet or network access. */
export function sanitizeHtml(source: string): string {
  if (source.length > 100_000) source = source.slice(0, 100_000);
  const parsed = new DOMParser().parseFromString(`<body>${source}`, "text/html");
  const doc = document.implementation.createHTMLDocument("");
  copyHtml(parsed.body, doc.body, doc, 0);
  return doc.body.innerHTML;
}
