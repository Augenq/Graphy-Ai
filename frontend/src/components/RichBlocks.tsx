import { useEffect, useMemo, useRef } from "react";
import { t } from "../lib/i18n";
import { chartSummary, chartSvg, classifyImage, parseChart } from "../lib/rich-markdown";
import { sanitizeHtml, sanitizeSvg, svgDataUrl } from "../lib/sanitize";

function Problem({ lang, why }: { lang: string; why: string }) {
  return <div role="note" className="rm-problem"><md-icon aria-hidden="true">error_outline</md-icon><span>{t("Блок «{0}» не показан: {1}", [lang, t(why)])}</span></div>;
}

/** ```chart: bar, line or pie from a small JSON document, drawn as SVG with a text alternative. */
export function ChartBlock({ source }: { source: string }) {
  const parsed = useMemo(() => parseChart(source), [source]);
  if ("error" in parsed) return <Problem lang="chart" why={parsed.error} />;
  const { spec } = parsed;
  return <figure className="rm-chart" aria-label={spec.title || t("График")}>
    {spec.title && <figcaption>{spec.title}</figcaption>}
    <div dangerouslySetInnerHTML={{ __html: chartSvg(spec) }} />
    <details className="rm-data"><summary>{t("Данные")}</summary><p>{chartSummary(spec)}</p></details>
  </figure>;
}

/** ```svg: sanitized, then shown as an image so it cannot run or load anything. */
export function SvgBlock({ source }: { source: string }) {
  const svg = useMemo(() => sanitizeSvg(source), [source]);
  if (!svg) return <Problem lang="svg" why="это не корректный SVG" />;
  return <figure className="rm-svg"><img src={svgDataUrl(svg)} alt={t("Рисунок от агента")} /></figure>;
}

const SHADOW_CSS = `:host{display:block}.rm-html{font:inherit;color:inherit;line-height:1.5;overflow-wrap:anywhere}
.rm-html img{max-width:100%}.rm-html table{border-collapse:collapse}.rm-html th,.rm-html td{border:1px solid color-mix(in srgb,currentColor 25%,transparent);padding:4px 8px}
.rm-html a{color:var(--md-sys-color-primary,#06c)}.rm-html pre,.rm-html code{font-family:ui-monospace,monospace;font-size:.92em}.rm-html pre{overflow:auto}`;

/** ```html: sanitized static HTML inside a shadow root, so its styles stay in and the page's stay out. */
export function HtmlBlock({ source }: { source: string }) {
  const host = useRef<HTMLDivElement>(null);
  const clean = useMemo(() => sanitizeHtml(source), [source]);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${SHADOW_CSS}</style><div class="rm-html">${clean}</div>`;
  }, [clean]);
  return <div ref={host} className="rm-html-host" role="group" aria-label={t("Вставка HTML")} />;
}

/** An image in model text: inline pictures are shown, remote ones become links, folder files are named, never fetched. */
export function RichImage({ src, alt }: { src?: string; alt?: string }) {
  const k = classifyImage(src);
  if (k.kind === "data") return <img src={k.src} alt={alt ?? ""} className="rm-img" />;
  if (k.kind === "remote") return <a href={k.href} target="_blank" rel="noopener noreferrer" className="rm-remote-img">{alt || t("Изображение")} ↗ <small>{t("(не загружается автоматически)")}</small></a>;
  if (k.kind === "workspace") return <span className="rm-remote-img" title={k.path}>{alt || t("Изображение")} · {k.path}</span>;
  return <span className="rm-remote-img">{alt || t("Изображение")}</span>;
}
