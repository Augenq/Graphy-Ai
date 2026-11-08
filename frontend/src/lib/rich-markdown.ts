/**
 * Rich Markdown in agent questions: ```chart blocks are small JSON documents drawn as an accessible SVG.
 * Everything here is pure (strings in, strings out) and every number and label is validated and escaped,
 * so a chart can never carry markup. The SVG and HTML blocks are handled by lib/sanitize.ts.
 */

export type ChartKind = "bar" | "line" | "pie";
export interface ChartSpec {
  type: ChartKind;
  title: string;
  unit: string;
  labels: string[];
  series: { name: string; values: number[] }[];
}

export const MAX_POINTS = 24;
export const MAX_SERIES = 6;
const MAX_JSON = 8_000;

const escapeXml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const clip = (v: unknown, n: number) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates the JSON of a chart block. Returns the spec, or a short reason it cannot be drawn. */
export function parseChart(source: string): { spec: ChartSpec } | { error: string } {
  if (source.length > MAX_JSON) return { error: "слишком большой график" };
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return { error: "не удалось прочитать JSON графика" };
  }
  if (!isObj(raw)) return { error: "график должен быть объектом JSON" };
  const type = raw.type;
  if (type !== "bar" && type !== "line" && type !== "pie") return { error: "тип графика: bar, line или pie" };
  let labels: string[] = [];
  let series: ChartSpec["series"] = [];
  if (Array.isArray(raw.data)) {
    // shorthand: [{label, value}]
    const rows = raw.data;
    if (!rows.every((r) => isObj(r) && typeof r.value === "number")) return { error: "data: нужны элементы {label, value} с числами" };
    labels = rows.map((r) => clip((r as Record<string, unknown>).label, 40));
    series = [{ name: clip(raw.name ?? "", 40), values: rows.map((r) => (r as Record<string, number>).value) }];
  } else if (Array.isArray(raw.labels) && Array.isArray(raw.series)) {
    labels = raw.labels.map((l) => clip(l, 40));
    if (!raw.series.every((s) => isObj(s) && Array.isArray(s.values) && s.values.every((v) => typeof v === "number"))) return { error: "series: values должны быть числами" };
    series = (raw.series as Record<string, unknown>[]).map((s) => ({ name: clip(s.name, 40), values: s.values as number[] }));
  } else {
    return { error: "нужны data или labels и series" };
  }
  if (!labels.length || labels.length > MAX_POINTS) return { error: `точек от 1 до ${MAX_POINTS}` };
  if (!series.length || series.length > MAX_SERIES) return { error: `рядов от 1 до ${MAX_SERIES}` };
  if (series.some((s) => s.values.length !== labels.length)) return { error: "число значений должно совпадать с числом подписей" };
  if (series.some((s) => s.values.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e12))) return { error: "значения должны быть конечными числами" };
  if (type === "pie") {
    if (series.length !== 1) return { error: "круговая диаграмма — один ряд" };
    if (series[0].values.some((v) => v < 0)) return { error: "в круговой диаграмме значения неотрицательны" };
    if (series[0].values.every((v) => v === 0)) return { error: "все значения равны нулю" };
  }
  return { spec: { type, title: clip(raw.title, 80), unit: clip(raw.unit, 12), labels, series } };
}

export const CHART_COLORS = ["var(--u-s1, #0072b2)", "var(--u-s2, #e69f00)", "var(--u-s3, #009e73)", "var(--u-s4, #cc79a7)", "var(--u-s5, #56b4e9)", "var(--u-s6, #7b8088)"];

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

/** 1, 2, 5 × 10^k axis maximum and tick step covering `max`. */
export function niceAxis(min: number, max: number): { lo: number; hi: number; step: number } {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  const span = hi - lo || 1;
  const rough = span / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 5, 10].find((m) => m * mag >= rough) ?? 10) * mag;
  return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
}

/** Text alternative: every number the picture shows. */
export function chartSummary(spec: ChartSpec): string {
  const u = spec.unit ? ` ${spec.unit}` : "";
  const head = spec.title ? `${spec.title}. ` : "";
  return head + spec.labels.map((l, i) => `${l || i + 1}: ${spec.series.map((s) => `${s.name ? `${s.name} ` : ""}${fmt(s.values[i])}${u}`).join(", ")}`).join("; ");
}

const W = 360;
const H = 220;
const PAD = { l: 40, r: 12, t: 12, b: 38 };

/** The chart as an inline SVG string. Text uses the page ink colour, series use the colour-blind-safe palette plus a pattern in the legend. */
export function chartSvg(spec: ChartSpec): string {
  const label = escapeXml(chartSummary(spec));
  const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}" class="rm-chart-svg" preserveAspectRatio="xMidYMid meet">`;
  const all = spec.series.flatMap((s) => s.values);
  const parts: string[] = [open];
  if (spec.type === "pie") {
    const values = spec.series[0].values;
    const total = values.reduce((a, b) => a + b, 0);
    const cx = 110, cy = 110, r = 90;
    let angle = -Math.PI / 2;
    values.forEach((v, i) => {
      if (v <= 0) return;
      const frac = v / total;
      const next = angle + frac * Math.PI * 2;
      const color = CHART_COLORS[i % CHART_COLORS.length];
      if (frac >= 0.9999) parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" stroke="var(--sheet, #fff)" stroke-width="1.5"/>`);
      else {
        const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
        const x2 = cx + r * Math.cos(next), y2 = cy + r * Math.sin(next);
        parts.push(`<path d="M${cx} ${cy}L${x1.toFixed(2)} ${y1.toFixed(2)}A${r} ${r} 0 ${frac > 0.5 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}Z" fill="${color}" stroke="var(--sheet, #fff)" stroke-width="1.5"/>`);
      }
      angle = next;
    });
    spec.labels.forEach((l, i) => {
      const y = 22 + i * 16;
      if (y > H - 6) return;
      const pct = Math.round((values[i] / total) * 100);
      parts.push(`<rect x="224" y="${y - 9}" width="10" height="10" rx="2" fill="${CHART_COLORS[i % CHART_COLORS.length]}"/><text x="240" y="${y}" font-size="11" fill="currentColor">${escapeXml(l || String(i + 1))} · ${pct}%</text>`);
    });
    parts.push("</svg>");
    return parts.join("");
  }

  const { lo, hi, step } = niceAxis(Math.min(...all), Math.max(...all));
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
  for (let v = lo; v <= hi + step / 2; v += step) {
    parts.push(`<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="currentColor" stroke-opacity="${v === 0 ? 0.5 : 0.15}"/>`);
    parts.push(`<text x="${PAD.l - 5}" y="${(y(v) + 3.5).toFixed(1)}" font-size="10" text-anchor="end" fill="currentColor" fill-opacity="0.75">${escapeXml(fmt(v))}</text>`);
  }
  const n = spec.labels.length;
  const band = iw / n;
  const skip = Math.ceil(n / Math.max(1, Math.floor(iw / 46)));
  spec.labels.forEach((l, i) => {
    if (i % skip) return;
    parts.push(`<text x="${(PAD.l + band * (i + 0.5)).toFixed(1)}" y="${H - PAD.b + 14}" font-size="10" text-anchor="middle" fill="currentColor" fill-opacity="0.8">${escapeXml(l.length > 9 ? `${l.slice(0, 8)}…` : l)}</text>`);
  });
  const k = spec.series.length;
  if (spec.type === "bar") {
    const bw = Math.max(2, Math.min(36, (band * 0.7) / k));
    spec.series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        const x = PAD.l + band * (i + 0.5) - (bw * k) / 2 + bw * si;
        const y0 = y(0), y1 = y(v);
        parts.push(`<rect x="${x.toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(y0 - y1)).toFixed(1)}" rx="2" fill="${CHART_COLORS[si % CHART_COLORS.length]}"/>`);
      });
    });
  } else {
    spec.series.forEach((s, si) => {
      const color = CHART_COLORS[si % CHART_COLORS.length];
      const pts = s.values.map((v, i) => `${(PAD.l + band * (i + 0.5)).toFixed(1)},${y(v).toFixed(1)}`);
      parts.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${si % 2 ? ' stroke-dasharray="5 3"' : ""}/>`);
      pts.forEach((p) => parts.push(`<circle cx="${p.split(",")[0]}" cy="${p.split(",")[1]}" r="3" fill="${color}"/>`));
    });
  }
  if (k > 1) {
    spec.series.forEach((s, si) => {
      parts.push(`<rect x="${PAD.l + si * 90}" y="${H - 12}" width="10" height="10" rx="2" fill="${CHART_COLORS[si % CHART_COLORS.length]}"/><text x="${PAD.l + si * 90 + 14}" y="${H - 3}" font-size="10" fill="currentColor">${escapeXml(s.name || `#${si + 1}`)}</text>`);
    });
  }
  parts.push("</svg>");
  return parts.join("");
}

/* ----------------------------------------------------------------------------------------- images */

export type ImageKind = { kind: "data"; src: string } | { kind: "remote"; href: string } | { kind: "workspace"; path: string } | { kind: "blocked" };

/**
 * Images in model text. Inline data images are shown. A remote address is never fetched: it becomes a link the learner
 * may open on purpose. A relative path names a file in the lesson folder; there is no safe way to load it here, so it
 * is shown as a labelled name. Anything else (file:, javascript:, ../ escapes) is dropped.
 */
export function classifyImage(src: string | undefined): ImageKind {
  const s = (src ?? "").trim();
  if (/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(s) && s.length < 2_000_000) return { kind: "data", src: s };
  if (/^https?:\/\//i.test(s)) return { kind: "remote", href: s };
  if (!s || /^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("/") || s.startsWith("\\") || /(^|[\\/])\.\.([\\/]|$)/.test(s) || /[\u0000-\u001f]/.test(s)) return { kind: "blocked" };
  return { kind: "workspace", path: s };
}
