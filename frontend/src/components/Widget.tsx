import { Button, IconButton } from "./ui/index";
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { Modal } from "./Modal";
import { send, isRunning } from "../lib/engine";
import { readWidgetTheme, staticWidgetImage, widgetDocument, type WidgetTheme } from "../lib/widget-doc";
import type { Block } from "../lib/types";

const MAX_HEIGHT = 1600;
const PROMPT_GAP_MS = 1000;

/** The host colors, kept current: the widget follows light/dark mode and palette changes without reloading. */
function useWidgetTheme(onChange: (theme: WidgetTheme) => void) {
  const callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => {
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => callback.current(readWidgetTheme()));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);
}

/**
 * A visual the agent drew (diagram, chart, simulation). It runs in a sandboxed iframe without access to the app
 * (opaque origin, no network); the only ways out are the messages handled here: its height, a link, and a prompt
 * that the learner triggers with a click (lib/widget-doc.ts).
 */
function WidgetFrame({ sessionId, block }: { sessionId: string; block: Extract<Block, { kind: "widget" }> }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const lastPrompt = useRef(0);
  const [height, setHeight] = useState(0);
  const initial = useRef(readWidgetTheme());
  const srcDoc = useMemo(() => widgetDocument(block.code, initial.current), [block.code]);

  useWidgetTheme((theme) => {
    frame.current?.contentWindow?.postMessage({ graphy: "theme", scheme: theme.scheme, vars: theme.vars }, "*");
  });

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { graphy?: string; type?: string; height?: number; width?: number; text?: string; url?: string } | null;
      if (event.source !== frame.current?.contentWindow || data?.graphy !== "widget") return;
      if (data.type === "height" && typeof data.height === "number" && Number.isFinite(data.height)) {
        // A subframe can use different CSS pixels under browser/page zoom.
        // Convert its measured height using the two viewport widths, preserving the drawing's ratio.
        const ratio = data.width && Number.isFinite(data.width) && data.width > 0
          ? (frame.current?.clientWidth ?? data.width) / data.width : 1;
        setHeight(Math.min(Math.max(0, Math.ceil(data.height * ratio)), MAX_HEIGHT));
      }
      else if (data.type === "link" && typeof data.url === "string" && /^https?:\/\//i.test(data.url)) window.open(data.url, "_blank", "noopener,noreferrer");
      else if (data.type === "prompt" && typeof data.text === "string" && Date.now() - lastPrompt.current > PROMPT_GAP_MS) {
        lastPrompt.current = Date.now();
        void send(sessionId, data.text, { followup: isRunning(sessionId) });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [sessionId]);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const measure = () => el.contentWindow?.postMessage({ graphy: "measure" }, "*");
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      measure();
    });
    observer.observe(el);
    el.addEventListener("load", measure);
    measure();
    return () => { observer.disconnect(); el.removeEventListener("load", measure); };
  }, []);

  return (
    <iframe
      ref={frame}
      title={block.title}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      scrolling="auto"
      style={{ height: height || 80 }}
      className="widget-frame block w-full border-0 bg-transparent"
    />
  );
}


function Drawing({ sessionId, block }: { sessionId: string; block: Extract<Block, { kind: "widget" }> }) {
  const [theme, setTheme] = useState(readWidgetTheme);
  useWidgetTheme(setTheme);
  const image = useMemo(() => staticWidgetImage(block.code, theme), [block.code, theme]);
  return image ? <img className="widget-svg" src={image} alt={block.title} draggable={false} /> : <WidgetFrame sessionId={sessionId} block={block} />;
}

/** The whole drawing fits the conversation; a larger viewer preserves readable labels. */
export function WidgetBlock({ sessionId, block }: { sessionId: string; block: Extract<Block, { kind: "widget" }> }) {
  const [expanded, setExpanded] = useState(false);
  const [inlineZoom, setInlineZoom] = useState(1);
  const inlineViewport = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const viewer = useRef<HTMLDivElement>(null);
  const fit = () => {
    setZoom(1);
    viewer.current?.scrollTo({ left: 0, top: 0 });
  };
  return <div className="widget-visual">
    <div ref={inlineViewport} className="widget-inline-scroll" tabIndex={inlineZoom > 1 ? 0 : undefined} aria-label={t("Рисунок")}>
      <div style={{ width: `${inlineZoom * 100}%` }}><Drawing sessionId={sessionId} block={block} /></div>
    </div>
    <div className="widget-toolbar">
      <IconButton variant="ghost" aria-label={t("Уменьшить масштаб")} disabled={inlineZoom <= 1} onClick={() => setInlineZoom(v => Math.max(1, v - .5))}><md-icon aria-hidden="true">remove</md-icon></IconButton>
      <Button variant="ghost" aria-label={t("Вписать в экран")} onClick={() => { setInlineZoom(1); inlineViewport.current?.scrollTo({ left: 0, top: 0 }); }}>{Math.round(inlineZoom * 100)}%</Button>
      <IconButton variant="ghost" aria-label={t("Увеличить масштаб")} disabled={inlineZoom >= 3} onClick={() => setInlineZoom(v => Math.min(3, v + .5))}><md-icon aria-hidden="true">add</md-icon></IconButton>
      <Button variant="ghost" onClick={() => { setZoom(1); setExpanded(true); }} aria-label={t("Увеличить рисунок")}>
        <md-icon slot="icon" aria-hidden="true">open_in_full</md-icon>{t("Увеличить рисунок")}
      </Button>
    </div>
    {expanded && <Modal label={t("Рисунок")} size="visual" onClose={() => setExpanded(false)} className="widget-viewer">
      <header className="widget-viewer-header">
        <h2>{t("Рисунок")}</h2>
        <IconButton variant="ghost" aria-label={t("Уменьшить масштаб")} disabled={zoom <= 1} onClick={() => setZoom(v => Math.max(1, v - .5))}><md-icon aria-hidden="true">remove</md-icon></IconButton>
        <Button variant="ghost" aria-label={t("Вписать в экран")} onClick={fit}>{Math.round(zoom * 100)}%</Button>
        <IconButton variant="ghost" aria-label={t("Увеличить масштаб")} disabled={zoom >= 3} onClick={() => setZoom(v => Math.min(3, v + .5))}><md-icon aria-hidden="true">add</md-icon></IconButton>
        <IconButton variant="ghost" aria-label={t("Закрыть рисунок")} onClick={() => setExpanded(false)}><md-icon aria-hidden="true">close</md-icon></IconButton>
      </header>
      <div ref={viewer} className="widget-viewer-scroll" tabIndex={0} aria-label={t("Рисунок")}>
        <div className="widget-viewer-content" style={{ width: `${zoom * 100}%` }}><Drawing sessionId={sessionId} block={block} /></div>
      </div>
    </Modal>}
  </div>;
}
