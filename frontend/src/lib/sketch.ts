/** Pure drawing model of the sketch editor: operations are kept as a list, so undo, redo and theme changes are exact. */
export type SketchTool = "pen" | "eraser" | "line" | "arrow" | "rect" | "ellipse" | "text";
export interface SketchOp { tool: SketchTool; color: string; width: number; points: [number, number][]; text?: string }
export interface SketchState { ops: SketchOp[]; redo: SketchOp[] }

export const SKETCH_W = 800;
export const SKETCH_H = 520;
/** "ink" follows the theme; the others are fixed colours that read on both backgrounds. */
export const SKETCH_COLORS = [
  { id: "ink", label: "Чернила" },
  { id: "#d55e00", label: "Красный" },
  { id: "#0072b2", label: "Синий" },
  { id: "#009e73", label: "Зелёный" },
  { id: "#e69f00", label: "Жёлтый" },
] as const;

export const emptySketch = (): SketchState => ({ ops: [], redo: [] });
export const addOp = (s: SketchState, op: SketchOp): SketchState => ({ ops: [...s.ops, op], redo: [] });
export const undo = (s: SketchState): SketchState => (s.ops.length ? { ops: s.ops.slice(0, -1), redo: [...s.redo, s.ops[s.ops.length - 1]] } : s);
export const redo = (s: SketchState): SketchState => (s.redo.length ? { ops: [...s.ops, s.redo[s.redo.length - 1]], redo: s.redo.slice(0, -1) } : s);
export const clearSketch = (s: SketchState): SketchState => (s.ops.length ? { ops: [], redo: [] } : s);

export interface SketchPalette { bg: string; ink: string }
export const LIGHT: SketchPalette = { bg: "#ffffff", ink: "#1b1b1f" };
export const DARK: SketchPalette = { bg: "#1b1b1f", ink: "#f2f0f4" };

export function drawOp(ctx: CanvasRenderingContext2D, op: SketchOp, p: SketchPalette) {
  const [a, b] = [op.points[0], op.points[op.points.length - 1]];
  if (!a) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = op.tool === "eraser" ? op.width * 4 : op.width;
  ctx.strokeStyle = op.tool === "eraser" ? p.bg : op.color === "ink" ? p.ink : op.color;
  ctx.fillStyle = ctx.strokeStyle;
  if (op.tool === "pen" || op.tool === "eraser") {
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    if (op.points.length === 1) ctx.lineTo(a[0] + 0.01, a[1]);
    for (const q of op.points.slice(1)) ctx.lineTo(q[0], q[1]);
    ctx.stroke();
  } else if (op.tool === "line" || op.tool === "arrow") {
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
    if (op.tool === "arrow" && (a[0] !== b[0] || a[1] !== b[1])) {
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const len = 10 + op.width * 2;
      ctx.beginPath();
      ctx.moveTo(b[0], b[1]);
      ctx.lineTo(b[0] - len * Math.cos(ang - 0.45), b[1] - len * Math.sin(ang - 0.45));
      ctx.moveTo(b[0], b[1]);
      ctx.lineTo(b[0] - len * Math.cos(ang + 0.45), b[1] - len * Math.sin(ang + 0.45));
      ctx.stroke();
    }
  } else if (op.tool === "rect") {
    ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
  } else if (op.tool === "ellipse") {
    ctx.beginPath();
    ctx.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (op.tool === "text" && op.text) {
    ctx.font = `${14 + op.width * 3}px Roboto, sans-serif`;
    ctx.textBaseline = "top";
    op.text.split("\n").forEach((line, i) => ctx.fillText(line, a[0], a[1] + i * (18 + op.width * 3)));
  }
  ctx.restore();
}

export function renderSketch(canvas: HTMLCanvasElement, ops: SketchOp[], p: SketchPalette, scale = 1) {
  canvas.width = SKETCH_W * scale;
  canvas.height = SKETCH_H * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, SKETCH_W, SKETCH_H);
  for (const op of ops) drawOp(ctx, op, p);
}

/** PNG at twice the size on a white page with dark ink, whatever the theme: legible for any vision model. */
export function exportSketch(ops: SketchOp[]): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  renderSketch(canvas, ops, LIGHT, 2);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}
