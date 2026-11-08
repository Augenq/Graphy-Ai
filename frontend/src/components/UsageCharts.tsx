/** Hand-written SVG/CSS charts of the usage overview. Colour is never the only cue: fills carry a pattern,
 *  every mark has a text value, and each chart can be explored with the pointer and with the arrow keys. */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { locale, plural, t } from "../lib/i18n";
import {
  addDays, fmtCost, fmtDay, fmtInt, fmtPercent, fmtTokens, heatGrid, niceScale, parseDay,
  type Bucket, type UsageDay,
} from "../lib/usage";

/** Pattern k paints series k: the same colour tokens as the legend swatches, plus a texture. */
const PATTERN_KINDS = 6;
export const SERIES = ["in", "out", "cache"] as const;
export type PaintKey = number | (typeof SERIES)[number];
const paintIndex = (k: PaintKey) => (typeof k === "number" ? k : SERIES.indexOf(k) + 10);
const paintVar = (k: PaintKey) => (typeof k === "number" ? `var(--u-s${k + 1})` : `var(--u-${k})`);

function texture(i: number): ReactNode {
  const line = { stroke: "var(--u-texture)", strokeWidth: 1.4 } as const;
  switch (i % PATTERN_KINDS) {
    case 1: return <path d="M-1 7L7 -1M-1 1L1 -1M5 9L9 5" {...line} />;
    case 2: return <><circle cx="2" cy="2" r="1" fill="var(--u-texture)" /><circle cx="6" cy="6" r="1" fill="var(--u-texture)" /></>;
    case 3: return <path d="M0 2H8M0 6H8" {...line} />;
    case 4: return <path d="M2 0V8M6 0V8" {...line} />;
    case 5: return <path d="M0 0L8 8M8 0L0 8" {...line} />;
    default: return null;
  }
}
/** Which texture goes with each paint: input solid, output diagonal, cache dots, models by rank. */
const textureOf = (k: PaintKey) => (typeof k === "number" ? k : SERIES.indexOf(k));

export function Patterns({ uid, paints }: { uid: string; paints: PaintKey[] }) {
  return (
    <defs>
      {paints.map((k) => (
        <pattern key={paintIndex(k)} id={`${uid}-p${paintIndex(k)}`} width="8" height="8" patternUnits="userSpaceOnUse">
          <rect width="8" height="8" fill={paintVar(k)} />
          {texture(textureOf(k))}
        </pattern>
      ))}
    </defs>
  );
}
const fillOf = (uid: string, k: PaintKey) => `url(#${uid}-p${paintIndex(k)})`;
const clean = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "");

/** A small legend swatch painted exactly like the chart marks. */
export function Swatch({ paint, uid }: { paint: PaintKey; uid: string }) {
  return (
    <svg className="usage-swatch" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <Patterns uid={`${uid}s`} paints={[paint]} />
      <rect width="14" height="14" rx="3" fill={fillOf(`${uid}s`, paint)} />
    </svg>
  );
}

/** Pointer + keyboard scrubbing over `count` equal slots. */
function useScrub(count: number, width: number, left: number, right: number, onKey?: (e: KeyboardEvent, i: number | null) => number | null) {
  const [active, setActive] = useState<number | null>(null);
  const move = (clientX: number, el: Element) => {
    const box = el.getBoundingClientRect();
    const x = ((clientX - box.left) / box.width) * width;
    const slot = (width - left - right) / count;
    setActive(Math.max(0, Math.min(count - 1, Math.floor((x - left) / slot))));
  };
  const props = {
    tabIndex: 0,
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => move(e.clientX, e.currentTarget),
    onPointerLeave: () => setActive(null),
    onBlur: () => setActive(null),
    onFocus: (e: React.FocusEvent<HTMLElement>) => { if (e.target === e.currentTarget && active == null) setActive(count - 1); },
    onKeyDown: (e: KeyboardEvent) => {
      const next = onKey?.(e, active) ?? (e.key === "ArrowLeft" ? (active ?? count) - 1 : e.key === "ArrowRight" ? (active ?? -1) + 1 : e.key === "Home" ? 0 : e.key === "End" ? count - 1 : null);
      if (e.key === "Escape") return setActive(null);
      if (next == null) return;
      e.preventDefault();
      setActive(Math.max(0, Math.min(count - 1, next)));
    },
  };
  return { active, props, setActive };
}

/** Text alternative of a chart: the same numbers as a table, visible to screen readers only. */
function DataTable({ caption, head, rows }: { caption: string; head: string[]; rows: string[][] }) {
  return (
    <table className="usage-sr">
      <caption>{caption}</caption>
      <thead><tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
      <tbody>{rows.map((r) => <tr key={r[0]}>{r.map((c, i) => (i === 0 ? <th key={i} scope="row">{c}</th> : <td key={i}>{c}</td>))}</tr>)}</tbody>
    </table>
  );
}

function Tip({ at, children }: { at: number; children: ReactNode }) {
  const side = at > 0.62 ? "end" : at < 0.38 ? "start" : "mid";
  return <div className="usage-tip" data-side={side} style={{ left: `${at * 100}%` }} role="status">{children}</div>;
}

const dayLabel = (b: Bucket) => (b.start === b.end ? fmtDay(b.start, true) : `${fmtDay(b.start)} – ${fmtDay(b.end)}`);

const W = 640;
const L = 46;
const R = 8;
const TOP = 10;
const BOTTOM = 26;

function Axes({ n, height, scale, buckets, format }: { n: number; height: number; scale: { max: number; step: number }; buckets: Bucket[]; format: (v: number) => string }) {
  const inner = height - TOP - BOTTOM;
  const slot = (W - L - R) / n;
  const marks = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <g className="usage-axes">
      {[0, 1, 2, 3, 4].map((i) => {
        const y = TOP + inner - (inner * i) / 4;
        return <g key={i}><line x1={L} x2={W - R} y1={y} y2={y} className={i === 0 ? "usage-base" : "usage-grid"} /><text x={L - 6} y={y + 4} textAnchor="end">{format(scale.step * i)}</text></g>;
      })}
      {marks.map((i) => (
        <text key={i} x={L + slot * (i + 0.5)} y={height - 7} textAnchor={i === 0 && n > 1 ? "start" : i === n - 1 && n > 1 ? "end" : "middle"} dx={i === 0 && n > 1 ? -slot / 2 : i === n - 1 && n > 1 ? slot / 2 : 0}>{fmtDay(buckets[i].start)}</text>
      ))}
    </g>
  );
}

/** Stacked daily tokens: input, output, cache. */
export function TokenBars({ buckets, height = 230 }: { buckets: Bucket[]; height?: number }) {
  const uid = clean(useId());
  const n = buckets.length;
  const scale = niceScale(Math.max(...buckets.map((b) => b.tokens), 0));
  const inner = height - TOP - BOTTOM;
  const slot = (W - L - R) / n;
  const bar = Math.max(2, Math.min(28, slot * 0.72));
  const { active, props } = useScrub(n, W, L, R);
  const a = active == null ? null : buckets[active];
  const stack = (b: Bucket) => [
    { key: "in" as const, v: b.input },
    { key: "out" as const, v: b.output },
    { key: "cache" as const, v: b.cache_read + b.cache_write },
  ];
  return (
    <div className="usage-plot" {...props} role="group" aria-label={t("Токены по дням. Стрелки влево и вправо перебирают дни.")}>
      <svg viewBox={`0 0 ${W} ${height}`} className="usage-svg" role="img" aria-label={t("Столбчатая диаграмма токенов по дням: ввод, вывод, кэш")}>
        <Patterns uid={uid} paints={[...SERIES]} />
        <Axes n={n} height={height} scale={scale} buckets={buckets} format={fmtTokens} />
        {buckets.map((b, i) => {
          let y = TOP + inner;
          const x = L + slot * i + (slot - bar) / 2;
          return (
            <g key={b.start} className="usage-bar" data-active={active === i || undefined}>
              {active === i && <rect x={L + slot * i} y={TOP} width={slot} height={inner} className="usage-hover" />}
              {stack(b).map((seg) => {
                const h = (seg.v / scale.max) * inner;
                y -= h;
                return h > 0 ? <rect key={seg.key} x={x} y={y} width={bar} height={Math.max(h, 1)} rx={bar > 4 ? 1.5 : 0} fill={fillOf(uid, seg.key)} /> : null;
              })}
            </g>
          );
        })}
      </svg>
      <DataTable caption={t("Токены по дням")} head={[t("День"), t("Ввод"), t("Вывод"), t("Кэш"), t("Стоимость")]}
        rows={buckets.map((b) => [dayLabel(b), fmtInt(b.input), fmtInt(b.output), fmtInt(b.cache_read + b.cache_write), fmtCost(b.cost, b.unknown_cost || (!b.known_cost && b.tokens > 0))])} />
      {a && active != null && (
        <Tip at={(L + slot * (active + 0.5)) / W}>
          <b>{dayLabel(a)}</b>
          {SERIES.map((k) => <span key={k} className="usage-tip-row"><Swatch uid={uid} paint={k} />{k === "in" ? t("Ввод") : k === "out" ? t("Вывод") : t("Кэш")}<i>{fmtInt(k === "in" ? a.input : k === "out" ? a.output : a.cache_read + a.cache_write)}</i></span>)}
          <span className="usage-tip-row usage-tip-sum">{t("Стоимость")}<i>{fmtCost(a.cost, a.unknown_cost || (!a.known_cost && a.tokens > 0))}</i></span>
        </Tip>
      )}
    </div>
  );
}

export function TokenLegend() {
  const uid = clean(useId());
  return (
    <ul className="usage-legend" aria-label={t("Обозначения")}>
      {SERIES.map((k) => <li key={k}><Swatch uid={uid} paint={k} />{k === "in" ? t("Ввод") : k === "out" ? t("Вывод") : t("Кэш (чтение и запись)")}</li>)}
    </ul>
  );
}

/** Cost per day: an area and a line over the days whose price is known. Hollow marks: the day is only partly priced. */
export function CostLine({ buckets, height = 190 }: { buckets: Bucket[]; height?: number }) {
  const n = buckets.length;
  const priced = (b: Bucket) => b.known_cost && b.cost >= 0;
  const scale = niceScale(Math.max(...buckets.filter(priced).map((b) => b.cost), 0));
  const inner = height - TOP - BOTTOM;
  const slot = (W - L - R) / n;
  const { active, props } = useScrub(n, W, L, R);
  const px = (i: number) => L + slot * (i + 0.5);
  const py = (v: number) => TOP + inner - (v / scale.max) * inner;
  const runs: number[][] = [];
  buckets.forEach((b, i) => {
    if (!priced(b)) return;
    if (runs.length && runs[runs.length - 1].at(-1) === i - 1) runs[runs.length - 1].push(i);
    else runs.push([i]);
  });
  const a = active == null ? null : buckets[active];
  const fmtAxis = (v: number) => fmtCost(v, false).replace(/\.?0+$/, (m) => (m.includes(".") ? "" : m));
  return (
    <div className="usage-plot" {...props} role="group" aria-label={t("Стоимость по дням. Стрелки влево и вправо перебирают дни.")}>
      <svg viewBox={`0 0 ${W} ${height}`} className="usage-svg" role="img" aria-label={t("График стоимости по дням")}>
        <Axes n={n} height={height} scale={scale} buckets={buckets} format={fmtAxis} />
        {runs.map((run) => (
          <g key={run[0]}>
            {run.length > 1 && <path className="usage-area" d={`M${px(run[0])} ${py(0)}${run.map((i) => `L${px(i)} ${py(buckets[i].cost)}`).join("")}L${px(run.at(-1)!)} ${py(0)}Z`} />}
            {run.length > 1 && <path className="usage-line" d={run.map((i, k) => `${k ? "L" : "M"}${px(i)} ${py(buckets[i].cost)}`).join("")} />}
          </g>
        ))}
        {buckets.map((b, i) => priced(b) && (
          <circle key={b.start} cx={px(i)} cy={py(b.cost)} r={active === i ? 5 : n > 40 ? 2.2 : 3.4} className={b.unknown_cost ? "usage-dot usage-dot-partial" : "usage-dot"} />
        ))}
        {active != null && <line x1={px(active)} x2={px(active)} y1={TOP} y2={TOP + inner} className="usage-cursor" />}
      </svg>
      <DataTable caption={t("Стоимость по дням")} head={[t("День"), t("Стоимость")]}
        rows={buckets.map((b) => [dayLabel(b), b.tokens === 0 ? "—" : fmtCost(b.cost, b.unknown_cost || !b.known_cost)])} />
      {a && active != null && (
        <Tip at={px(active) / W}>
          <b>{dayLabel(a)}</b>
          <span className="usage-tip-row">{t("Стоимость")}<i>{fmtCost(a.cost, a.unknown_cost || (!a.known_cost && a.tokens > 0))}</i></span>
          <span className="usage-tip-note">{a.tokens === 0 ? t("В этот день расходов не было") : !a.known_cost ? t("Цена неизвестна") : a.unknown_cost ? t("Не для всех запросов известна цена: показана сумма известных") : t("Все цены известны")}</span>
        </Tip>
      )}
    </div>
  );
}

export function CostLegend() {
  return (
    <ul className="usage-legend" aria-label={t("Обозначения")}>
      <li><svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4" className="usage-dot" /></svg>{t("Цена известна")}</li>
      <li><svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4" className="usage-dot usage-dot-partial" /></svg>{t("Известна не для всех запросов (≥)")}</li>
    </ul>
  );
}

// ---- donut ----
const TAU = Math.PI * 2;
function arc(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const end = Math.min(a1, a0 + TAU - 0.0005);
  const pt = (r: number, a: number) => `${(cx + r * Math.sin(a)).toFixed(2)} ${(cy - r * Math.cos(a)).toFixed(2)}`;
  const big = end - a0 > Math.PI ? 1 : 0;
  return `M${pt(r1, a0)}A${r1} ${r1} 0 ${big} 1 ${pt(r1, end)}L${pt(r0, end)}A${r0} ${r0} 0 ${big} 0 ${pt(r0, a0)}Z`;
}

export interface Slice { id: string; label: string; share: number; tokens: number; cost: string; detail?: string }

/** Share of tokens by model (or any list): a donut and a legend that doubles as its keyboard-accessible index. */
export function Donut({ slices, centerLabel }: { slices: Slice[]; centerLabel: string }) {
  const uid = clean(useId());
  const [active, setActive] = useState<string | null>(null);
  let angle = 0;
  const paintOf = (i: number) => Math.min(i, PATTERN_KINDS - 1);
  const shown = slices.find((s) => s.id === active);
  return (
    <div className="usage-donut">
      <div className="usage-donut-art">
        <svg viewBox="0 0 160 160" role="img" aria-label={t("Круговая диаграмма долей токенов")}>
          <Patterns uid={uid} paints={slices.map((_, i) => paintOf(i))} />
          {slices.map((s, i) => {
            const a0 = angle;
            angle += s.share * TAU;
            return s.share > 0 ? (
              <path key={s.id} d={arc(80, 80, 50, 76, a0, angle)} fill={fillOf(uid, paintOf(i))} className="usage-slice" data-dim={active != null && active !== s.id || undefined}
                onPointerEnter={() => setActive(s.id)} onPointerLeave={() => setActive(null)} />
            ) : null;
          })}
          <text x="80" y="76" textAnchor="middle" className="usage-donut-big">{shown ? fmtPercent(shown.share) : fmtTokens(slices.reduce((s, x) => s + x.tokens, 0))}</text>
          <text x="80" y="94" textAnchor="middle" className="usage-donut-small">{shown ? fmtTokens(shown.tokens) : centerLabel}</text>
        </svg>
      </div>
      <ul className="usage-shares" aria-label={t("Доли по моделям")}>
        {slices.map((s, i) => (
          <li key={s.id} tabIndex={0} data-active={active === s.id || undefined} onFocus={() => setActive(s.id)} onBlur={() => setActive(null)}
            onPointerEnter={() => setActive(s.id)} onPointerLeave={() => setActive(null)}
            aria-label={`${s.label}: ${fmtPercent(s.share)}, ${fmtInt(s.tokens)} ${t("токенов")}${s.cost ? `, ${s.cost}` : ""}`}>
            <Swatch uid={uid} paint={paintOf(i)} />
            <span className="usage-share-name" title={s.label}>{s.label}</span>
            <span className="usage-share-val">{fmtPercent(s.share)}</span>
            <span className="usage-share-sub">{s.cost ? `${fmtTokens(s.tokens)} · ${s.cost}` : fmtTokens(s.tokens)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- calendar heatmap ----
const CELL = 14;
const GAP = 3;
export function Heatmap({ days, today, weeks = 26 }: { days: UsageDay[]; today: string; weeks?: number }) {
  const grid = heatGrid(days, today, weeks);
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<[number, number] | null>(null);
  useEffect(() => { if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth; }, []);
  const labelW = 26;
  const width = labelW + weeks * (CELL + GAP);
  const height = 16 + 7 * (CELL + GAP);
  const names = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(parseDay("2026-11-02"), i).toLocaleDateString(locale(), { weekday: "short" }));
  const cellAt = (c: number, r: number) => grid[c]?.[r];
  const move = (dc: number, dr: number) => {
    const [c, r] = active ?? [weeks - 1, 6];
    let nc = c + dc, nr = r + dr;
    if (nr < 0) { nr = 6; nc -= 1; } else if (nr > 6) { nr = 0; nc += 1; }
    nc = Math.max(0, Math.min(weeks - 1, nc));
    // never rest on a day that has not happened yet
    while (cellAt(nc, nr)?.future && (nr > 0 || nc > 0)) { nr -= 1; if (nr < 0) { nr = 6; nc -= 1; } }
    setActive([nc, nr]);
  };
  const keys: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const a = active ? cellAt(active[0], active[1]) : null;
  const months = grid.map((col, c) => {
    const d = parseDay(col[0].day);
    const prev = c > 0 ? parseDay(grid[c - 1][0].day) : null;
    return !prev || prev.getMonth() !== d.getMonth() ? d.toLocaleDateString(locale(), { month: "short" }) : "";
  });
  const sentence = (c: ReturnType<typeof cellAt>) => !c ? "" : c.tokens > 0 ? `${fmtDay(c.day, true)}: ${fmtInt(c.tokens)} ${t("токенов")}, ${plural(c.lessons, "{0} занятие", "{0} занятия", "{0} занятий").replace("{0}", String(c.lessons))}` : `${fmtDay(c.day, true)}: ${t("без занятий")}`;
  return (
    <div className="usage-plot usage-heat" ref={ref} tabIndex={0} role="group" aria-label={t("Календарь занятий. Стрелки перебирают дни.")}
      onFocus={(e) => { if (e.target === e.currentTarget && !active) setActive([weeks - 1, Math.min(6, (parseDay(today).getDay() + 6) % 7)]); }}
      onBlur={() => setActive(null)}
      onKeyDown={(e) => { const k = keys[e.key]; if (k) { e.preventDefault(); move(...k); } else if (e.key === "Escape") setActive(null); }}>
      <svg viewBox={`0 0 ${width} ${height}`} className="usage-svg usage-heat-svg" role="img" aria-label={t("Календарь занятий за полгода")}>
        {months.map((m, c) => m && <text key={c} x={labelW + c * (CELL + GAP)} y={10} className="usage-heat-label">{m}</text>)}
        {[0, 2, 4].map((r) => <text key={r} x={0} y={16 + r * (CELL + GAP) + CELL - 3} className="usage-heat-label">{names[r]}</text>)}
        {grid.map((col, c) => col.map((cell, r) => !cell.future && (
          <rect key={cell.day} x={labelW + c * (CELL + GAP)} y={16 + r * (CELL + GAP)} width={CELL} height={CELL} rx={3}
            className={`usage-cell usage-lv${cell.level}`} data-today={cell.day === today || undefined} data-active={active?.[0] === c && active[1] === r || undefined}
            onPointerEnter={() => setActive([c, r])} onPointerLeave={() => setActive(null)} />
        )))}
      </svg>
      {a && active && (
        <Tip at={(labelW + active[0] * (CELL + GAP) + CELL / 2) / width}>
          <b>{fmtDay(a.day, true)}</b>
          <span className="usage-tip-note">{sentence(a).split(": ").slice(1).join(": ")}</span>
        </Tip>
      )}
      <div className="usage-heat-legend" aria-hidden="true">
        {t("Меньше")}
        {[0, 1, 2, 3, 4].map((l) => <svg key={l} width="14" height="14"><rect width="14" height="14" rx="3" className={`usage-cell usage-lv${l}`} /></svg>)}
        {t("Больше")}
      </div>
      <DataTable caption={t("Дни занятий")} head={[t("День"), t("Токены"), t("Занятия")]}
        rows={days.filter((d) => d.tokens > 0).map((d) => [fmtDay(d.day, true), fmtInt(d.tokens), String(d.lessons)])} />
      <span className="usage-sr" aria-live="polite">{a ? sentence(a) : ""}</span>
    </div>
  );
}
