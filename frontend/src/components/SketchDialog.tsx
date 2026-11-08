import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { t } from "../lib/i18n";
import { useSettings } from "../lib/settings";
import {
  DARK, LIGHT, SKETCH_COLORS, SKETCH_H, SKETCH_W, addOp, clearSketch, drawOp, emptySketch, exportSketch, redo, renderSketch, undo,
  type SketchOp, type SketchState, type SketchTool,
} from "../lib/sketch";
import { Modal } from "./Modal";
import { Button, IconButton } from "./ui/index";

const TOOLS: { id: SketchTool; label: string; icon: string; key: string }[] = [
  { id: "pen", label: "Перо", icon: "edit", key: "P" },
  { id: "eraser", label: "Ластик", icon: "ink_eraser", key: "E" },
  { id: "line", label: "Линия", icon: "horizontal_rule", key: "L" },
  { id: "arrow", label: "Стрелка", icon: "arrow_right_alt", key: "A" },
  { id: "rect", label: "Прямоугольник", icon: "crop_square", key: "R" },
  { id: "ellipse", label: "Эллипс", icon: "circle", key: "O" },
  { id: "text", label: "Текст", icon: "title", key: "T" },
];
const SIZES = [2, 4, 8];

/** A canvas dialog for quick sketches; "Прикрепить" hands a PNG to the composer. */
export function SketchDialog({ onClose, onDone }: { onClose: () => void; onDone: (png: Blob) => void }) {
  const settings = useSettings();
  const dark = document.documentElement.dataset.theme === "dark";
  const colors = getComputedStyle(document.documentElement);
  const palette = settings.palette === "max"
    ? { bg: colors.getPropertyValue("--sheet").trim(), ink: colors.getPropertyValue("--ink").trim() }
    : dark ? DARK : LIGHT;
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<SketchState>(emptySketch);
  const [tool, setTool] = useState<SketchTool>("pen");
  const [color, setColor] = useState<string>("ink");
  const [size, setSize] = useState(4);
  const [live, setLiveState] = useState<SketchOp | null>(null);
  const liveRef = useRef<SketchOp | null>(null);
  const setLive = (op: SketchOp | null) => { liveRef.current = op; setLiveState(op); };
  const [textAt, setTextAt] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    renderSketch(el, state.ops, palette);
    if (live) drawOp(el.getContext("2d")!, live, palette);
  }, [state, live, palette.bg, settings.theme]);

  const at = (e: RPointerEvent): [number, number] => {
    const box = canvas.current!.getBoundingClientRect();
    return [Math.max(0, Math.min(SKETCH_W, ((e.clientX - box.left) / box.width) * SKETCH_W)), Math.max(0, Math.min(SKETCH_H, ((e.clientY - box.top) / box.height) * SKETCH_H))];
  };
  const down = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    const p = at(e);
    if (tool === "text") return setTextAt({ x: p[0], y: p[1] });
    canvas.current!.setPointerCapture(e.pointerId);
    setLive({ tool, color, width: size, points: [p] });
  };
  const move = (e: RPointerEvent) => {
    if (!liveRef.current) return;
    const p = at(e);
    const o = liveRef.current;
    if (o) setLive({ ...o, points: o.tool === "pen" || o.tool === "eraser" ? [...o.points, p] : [o.points[0], p] });
  };
  const up = () => {
    const op = liveRef.current;
    if (!op) return;
    setLive(null);
    setState((s) => addOp(s, op));
  };
  const commitText = (value: string) => {
    if (textAt && value.trim()) setState((s) => addOp(s, { tool: "text", color, width: Math.min(size, 4), points: [[textAt.x, textAt.y]], text: value }));
    setTextAt(null);
  };

  const attach = async () => {
    setBusy(true);
    setError("");
    const png = await exportSketch(state.ops);
    setBusy(false);
    if (!png || png.size > 5 * 1024 * 1024) return setError(t("Набросок не удалось сохранить: он слишком большой."));
    onDone(png);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") return e.preventDefault(), setState((s) => (e.shiftKey ? redo(s) : undo(s)));
    if (mod && e.key.toLowerCase() === "y") return e.preventDefault(), setState(redo);
    if (!mod && !e.altKey) {
      const hit = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
      if (hit) return e.preventDefault(), setTool(hit.id);
    }
  };

  return <Modal label={t("Набросок")} onClose={onClose} className="sketch-dialog">
    <div onKeyDown={onKeyDown} className="sketch" data-sketch>
      <div className="sketch-bar" role="toolbar" aria-label={t("Инструменты наброска")}>
        <div className="sketch-group" role="group" aria-label={t("Инструмент")}>
          {TOOLS.map((x) => <IconButton key={x.id} variant={tool === x.id ? "secondary" : "ghost"} className="sketch-tool" aria-pressed={tool === x.id} aria-label={`${t(x.label)} (${x.key})`} title={`${t(x.label)} (${x.key})`} data-tool={x.id} onClick={() => setTool(x.id)}>
            <md-icon aria-hidden="true">{x.icon}</md-icon></IconButton>)}
        </div>
        <div className="sketch-group" role="group" aria-label={t("Цвет")}>
          {SKETCH_COLORS.map((c) => <button key={c.id} type="button" className="sketch-swatch" aria-pressed={color === c.id} aria-label={t(c.label)} title={t(c.label)} data-color={c.id}
            style={{ background: c.id === "ink" ? palette.ink : c.id }} onClick={() => setColor(c.id)} />)}
        </div>
        <div className="sketch-group" role="group" aria-label={t("Толщина")}>
          {SIZES.map((s) => <IconButton key={s} variant={size === s ? "secondary" : "ghost"} className="sketch-size" aria-pressed={size === s} aria-label={t("Толщина {0}", [s])} onClick={() => setSize(s)}><span className="sketch-line" style={{ height: s }} /></IconButton>)}
        </div>
        <span className="flex-1" />
        <IconButton variant="ghost" disabled={!state.ops.length} aria-label={t("Отменить (Ctrl+Z)")} title={t("Отменить (Ctrl+Z)")} data-undo onClick={() => setState(undo)}><md-icon aria-hidden="true">undo</md-icon></IconButton>
        <IconButton variant="ghost" disabled={!state.redo.length} aria-label={t("Повторить (Ctrl+Shift+Z)")} title={t("Повторить (Ctrl+Shift+Z)")} data-redo onClick={() => setState(redo)}><md-icon aria-hidden="true">redo</md-icon></IconButton>
        <IconButton variant="ghost" disabled={!state.ops.length} aria-label={t("Очистить")} title={t("Очистить")} data-clear onClick={() => setState(clearSketch)}><md-icon aria-hidden="true">delete_sweep</md-icon></IconButton>
      </div>
      <div ref={stage} className="sketch-stage">
        <canvas ref={canvas} width={SKETCH_W} height={SKETCH_H} role="img" aria-label={t("Холст наброска: рисуйте мышью или пальцем")} style={{ touchAction: "none", cursor: tool === "text" ? "text" : "crosshair" }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
        {textAt && <input autoFocus className="sketch-text" aria-label={t("Текст на наброске")} placeholder={t("Текст, Enter")} style={{ left: `${(textAt.x / SKETCH_W) * 100}%`, top: `${(textAt.y / SKETCH_H) * 100}%` }}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") commitText(e.currentTarget.value); if (e.key === "Escape") setTextAt(null); }} onBlur={(e) => commitText(e.currentTarget.value)} />}
      </div>
      <p className="sketch-note">{t("Набросок уйдёт модели как картинка на белом фоне. Рисунок остаётся на этом компьютере, пока вы не отправите сообщение.")}</p>
      {error && <p role="alert" className="sketch-error">{error}</p>}
      <div className="sketch-actions">
        <Button variant="ghost" onClick={onClose}>{t("Отмена")}</Button>
        <Button variant="primary" disabled={!state.ops.length || busy} data-sketch-attach onClick={() => void attach()}>{t("Прикрепить")}</Button>
      </div>
    </div>
  </Modal>;
}
