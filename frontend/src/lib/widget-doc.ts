/**
 * The page inside a widget's sandboxed iframe: the agent's HTML/SVG fragment wrapped with the app's colors,
 * pre-styled controls and SVG classes, and a small bridge to the chat (sendPrompt, openLink, height).
 * The iframe has no same-origin access and a strict CSP, so the fragment can draw and compute but cannot
 * reach the application, its storage or the network.
 */

export type Scheme = "light" | "dark";

/** The app colors a widget inherits, read from the host page: surfaces and ink come from the Material roles. */
export interface WidgetTheme {
  scheme: Scheme;
  vars: Record<string, string>;
}

const ROLES: Record<string, string> = {
  "--ink": "--md-sys-color-on-surface",
  "--ink-2": "--md-sys-color-on-surface-variant",
  "--surface": "--md-sys-color-surface",
  "--surface-2": "--md-sys-color-surface-container",
  "--surface-3": "--md-sys-color-surface-container-high",
};

export function readWidgetTheme(): WidgetTheme {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const vars: Record<string, string> = {};
  for (const [name, role] of Object.entries(ROLES)) vars[name] = style.getPropertyValue(role).trim();
  return { scheme: root.dataset.theme === "dark" ? "dark" : "light", vars };
}

/** [fill, stroke, title text, subtitle text] per color ramp for light and dark. */
const RAMPS: Record<string, [Scheme, string[]][]> = {
  purple: [["light", ["#EEEDFE", "#534AB7", "#3C3489", "#534AB7"]], ["dark", ["#3C3489", "#7F77DD", "#CECBF6", "#AFA9EC"]]],
  teal: [["light", ["#E1F5EE", "#0F6E56", "#085041", "#0F6E56"]], ["dark", ["#085041", "#1D9E75", "#9FE1CB", "#5DCAA5"]]],
  coral: [["light", ["#FAECE7", "#993C1D", "#712B13", "#993C1D"]], ["dark", ["#712B13", "#D85A30", "#F5C4B3", "#F0997B"]]],
  pink: [["light", ["#FBEAF0", "#993556", "#72243E", "#993556"]], ["dark", ["#72243E", "#D4537E", "#F4C0D1", "#ED93B1"]]],
  gray: [["light", ["#F1EFE8", "#5F5E5A", "#444441", "#5F5E5A"]], ["dark", ["#444441", "#888780", "#D3D1C7", "#B4B2A9"]]],
  blue: [["light", ["#E6F1FB", "#185FA5", "#0C447C", "#185FA5"]], ["dark", ["#0C447C", "#378ADD", "#B5D4F4", "#85B7EB"]]],
  green: [["light", ["#EAF3DE", "#3B6D11", "#27500A", "#3B6D11"]], ["dark", ["#27500A", "#639922", "#C0DD97", "#97C459"]]],
  amber: [["light", ["#FAEEDA", "#854F0B", "#633806", "#854F0B"]], ["dark", ["#633806", "#BA7517", "#FAC775", "#EF9F27"]]],
  red: [["light", ["#FCEBEB", "#A32D2D", "#791F1F", "#A32D2D"]], ["dark", ["#791F1F", "#E24B4A", "#F7C1C1", "#F09595"]]],
};

/** background, text, border per semantic color. */
const SEMANTIC: Record<string, [Scheme, string[]][]> = {
  info: [["light", ["#E6F1FB", "#0C447C", "#378ADD"]], ["dark", ["#0C447C", "#85B7EB", "#85B7EB"]]],
  success: [["light", ["#EAF3DE", "#27500A", "#639922"]], ["dark", ["#27500A", "#97C459", "#97C459"]]],
  warning: [["light", ["#FAEEDA", "#633806", "#BA7517"]], ["dark", ["#633806", "#EF9F27", "#EF9F27"]]],
  danger: [["light", ["#FCEBEB", "#791F1F", "#E24B4A"]], ["dark", ["#791F1F", "#F09595", "#F09595"]]],
};

const rampCss = Object.entries(RAMPS)
  .flatMap(([name, schemes]) =>
    schemes.map(([scheme, [fill, stroke, title, sub]]) => {
      const on = `html[data-scheme="${scheme}"] svg`;
      return (
        `${on} .c-${name}>rect,${on} .c-${name}>circle,${on} .c-${name}>ellipse,${on} .c-${name}>path,` +
        `${on} rect.c-${name},${on} circle.c-${name},${on} ellipse.c-${name},${on} path.c-${name}{fill:${fill};stroke:${stroke};stroke-width:1}` +
        `${on} .c-${name}>.th,${on} .c-${name}>.t{fill:${title}}${on} .c-${name}>.ts{fill:${sub}}`
      );
    }),
  )
  .join("\n");

const semanticCss = (scheme: Scheme) =>
  Object.entries(SEMANTIC)
    .map(([name, schemes]) => {
      const [bg, text, border] = schemes.find(([s]) => s === scheme)![1];
      return `--color-background-${name}:${bg};--color-text-${name}:${text};--color-border-${name}:${border};`;
    })
    .join("");

const BASE_CSS = `
:root{
  --color-text-primary:var(--ink);--color-text-secondary:var(--ink-2);
  --color-text-tertiary:color-mix(in srgb,var(--ink-2) 70%,transparent);
  --color-background-primary:var(--surface);--color-background-secondary:var(--surface-2);--color-background-tertiary:var(--surface-3);
  --color-border-tertiary:color-mix(in srgb,var(--ink) 15%,transparent);
  --color-border-secondary:color-mix(in srgb,var(--ink) 30%,transparent);
  --color-border-primary:color-mix(in srgb,var(--ink) 40%,transparent);
  --font-sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--font-serif:Georgia,"Times New Roman",serif;
  --font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --border-radius-md:8px;--border-radius-lg:12px;--border-radius-xl:16px;
}
html[data-scheme="light"]{color-scheme:light;${semanticCss("light")}}
html[data-scheme="dark"]{color-scheme:dark;${semanticCss("dark")}}
html,body{margin:0;padding:0;background:transparent}
body{display:flow-root;font:400 14px/1.6 var(--font-sans);color:var(--color-text-primary)}
h1,h2,h3,h4{margin:0 0 .4em;font-weight:500;color:var(--color-text-primary)}
h1{font-size:20px}h2{font-size:18px}h3,h4{font-size:16px}
p{margin:0 0 .6em}
svg{display:block;max-width:100%;height:auto;overflow:visible}
canvas,img,video{max-width:100%;height:auto}
svg text{font-family:var(--font-sans)}
svg .t{font-size:14px;fill:var(--color-text-primary)}
svg .ts{font-size:12px;fill:var(--color-text-secondary)}
svg .th{font-size:14px;font-weight:500;fill:var(--color-text-primary)}
svg .box{fill:var(--color-background-secondary);stroke:var(--color-border-secondary);stroke-width:1}
svg .arr{stroke:var(--color-text-tertiary);stroke-width:1.5;fill:none}
svg .leader{stroke:var(--color-text-tertiary);stroke-width:.5;stroke-dasharray:4 3;fill:none}
svg .node{cursor:pointer}svg .node:hover{opacity:.8}
${rampCss}
button{font:inherit;font-size:14px;background:transparent;border:.5px solid var(--color-border-secondary);border-radius:var(--border-radius-md);color:var(--color-text-primary);padding:6px 14px;cursor:pointer}
button:hover{background:var(--color-background-secondary)}
button:active{transform:scale(.98)}
button:disabled{opacity:.5;cursor:default}
input[type=range]{-webkit-appearance:none;appearance:none;height:4px;background:var(--color-border-secondary);border-radius:2px;outline:none;vertical-align:middle}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:var(--color-text-primary);cursor:pointer}
input[type=text],input[type=number],textarea,select{font:inherit;font-size:14px;height:36px;box-sizing:border-box;background:var(--color-background-primary);border:.5px solid var(--color-border-tertiary);border-radius:var(--border-radius-md);color:var(--color-text-primary);padding:0 10px;outline:none}
textarea{height:auto;padding:8px 10px}
input:hover,textarea:hover,select:hover{border-color:var(--color-border-secondary)}
input:focus,textarea:focus,select:focus{border-color:var(--color-border-primary)}
a{color:var(--color-text-info)}
code{font-family:var(--font-mono);font-size:.92em}
`;

/** Libraries may come from these hosts only; there is no network access otherwise. */
export const WIDGET_CDNS = ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://unpkg.com", "https://esm.sh"];

const CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${WIDGET_CDNS.join(" ")}`,
  `style-src 'unsafe-inline' ${WIDGET_CDNS.join(" ")}`,
  `font-src data: ${WIDGET_CDNS.join(" ")}`,
  "img-src data: blob:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Runs before the agent's code: the page API and the messages to the chat. */
const BRIDGE = `
(function () {
  var host = window.parent;
  function post(message) { host.postMessage(Object.assign({ graphy: "widget" }, message), "*"); }
  function gesture() { return !navigator.userActivation || navigator.userActivation.isActive; }
  window.sendPrompt = function (text) {
    if (typeof text !== "string" || !text.trim() || !gesture()) return;
    post({ type: "prompt", text: text.slice(0, 2000) });
  };
  window.openLink = function (url) {
    if (typeof url === "string" && /^https?:\\/\\//i.test(url) && gesture()) post({ type: "link", url: url });
  };
  document.addEventListener("click", function (event) {
    var node = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!node) return;
    event.preventDefault();
    window.openLink(node.getAttribute("href"));
  }, true);
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== host || !data) return;
    if (data.graphy === "measure") { report(true); return; }
    if (data.graphy !== "theme") return;
    document.documentElement.setAttribute("data-scheme", data.scheme);
    for (var name in data.vars) document.documentElement.style.setProperty(name, data.vars[name]);
  });
  window.addEventListener("error", function (event) { post({ type: "error", message: String(event.message || "error").slice(0, 300) }); });
  function fitSvg() {
    document.querySelectorAll("svg").forEach(function (svg) {
      if (svg.ownerSVGElement) return;
      try {
        var box = svg.getBBox();
        if (!box.width || !box.height) return;
        var view = svg.viewBox.baseVal;
        var w = view.width || svg.width.baseVal.value || box.x + box.width;
        var h = view.height || svg.height.baseVal.value || box.y + box.height;
        var x = view.width ? view.x : 0, y = view.height ? view.y : 0;
        var left = Math.min(x, box.x - 4), top = Math.min(y, box.y - 4);
        var right = Math.max(x + w, box.x + box.width + 4);
        var bottom = Math.max(y + h, box.y + box.height + 4);
        if (!view.width || left < x || top < y || right > x + w || bottom > y + h) {
          svg.setAttribute("viewBox", [left, top, right - left, bottom - top].join(" "));
        }
      } catch (_) { /* An empty or not-yet-mounted SVG will be measured later. */ }
    });
  }
  var last = -1, lastWidth = -1;
  function report(force) {
    fitSvg();
    var h = Math.ceil(document.body.getBoundingClientRect().height);
    var width = document.documentElement.clientWidth;
    if (force === true || h !== last || width !== lastWidth) {
      last = h; lastWidth = width;
      post({ type: "height", height: h, width: width });
    }
  }
  new ResizeObserver(report).observe(document.body);
  window.addEventListener("load", report);
  report();
})();
`;

const attr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** Removes what a fragment must not contain (a Markdown fence, a full-document wrapper); the rest is left to the HTML parser. */
export function widgetFragment(code: string): string {
  return code
    .trim()
    .replace(/^```[\w-]*\s*\n/, "")
    .replace(/\n```\s*$/, "")
    .replace(/<!doctype[^>]*>/gi, "")
    .replace(/<\/?(?:html|head|body)\b[^>]*>/gi, "");
}

export function widgetDocument(code: string, theme: WidgetTheme): string {
  const vars = Object.entries(theme.vars)
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
  return (
    `<!doctype html><html data-scheme="${theme.scheme}" style="${attr(vars)}"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${attr(CSP)}">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${BASE_CSS}</style></head>` +
    `<body><script>${BRIDGE}</script>${widgetFragment(code)}</body></html>`
  );
}


/** Static diagrams can use the browser's native SVG image renderer, avoiding subframe zoom/compositing. */
export function staticWidgetImage(code: string, theme: WidgetTheme): string | null {
  const parsed = new DOMParser().parseFromString(widgetFragment(code), "image/svg+xml");
  const svg = parsed.documentElement;
  if (svg.localName !== "svg" || parsed.querySelector("parsererror, script, foreignObject, a, animate, animateTransform, set, image")) return null;
  for (const node of [svg, ...svg.querySelectorAll("*")]) {
    if ([...node.attributes].some(a => /^on/i.test(a.name) || (a.localName === "href" && !a.value.startsWith("#")))) return null;
  }
  const view = svg.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (!view || view.length !== 4 || !view.every(Number.isFinite) || view[2] <= 0 || view[3] <= 0) return null;
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("width", String(view[2]));
  svg.setAttribute("height", String(view[3]));
  svg.setAttribute("data-scheme", theme.scheme);
  // Custom properties and the exact same SVG classes as the sandboxed renderer.
  svg.setAttribute("style", Object.entries(theme.vars).map(([key, value]) => `${key}:${value}`).join(";") + ";font-family:system-ui,sans-serif");
  const style = parsed.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = BASE_CSS.replace(/html(\[data-scheme="(?:light|dark)"\]) svg/g, "svg$1").replaceAll("html[data-scheme", "svg[data-scheme");
  svg.insertBefore(style, svg.firstChild);
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(svg));
}
