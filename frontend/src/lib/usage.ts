/** Token and cost accounting: the overview of GET /usage plus the helpers the charts and the composer chip share. */
import { useCallback, useEffect, useState } from "react";
import { describe, get } from "./api";
import { locale, t } from "./i18n";

export type UsageRange = "7d" | "30d" | "all";

/** What every counter of the overview carries. `cost` is the sum of the known costs only. */
export interface UsageCounts {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  tokens: number;
  cost: number;
  known_cost: boolean;
  unknown_cost: boolean;
  calls: number;
}
export interface UsageDay extends UsageCounts { day: string; lessons: number }
export interface UsageTotals extends UsageCounts { lessons: number; cache_hit: number | null }
export interface UsageModel extends UsageCounts { model: string }
export interface UsageSession extends UsageCounts { id: string; name: string }
export interface UsageOverview {
  range: UsageRange;
  today: string;
  from: string | null;
  totals: UsageTotals;
  days: UsageDay[];
  heatmap: UsageDay[];
  models: UsageModel[];
  sessions: UsageSession[];
}

/** Running totals of one lesson, as the snapshot and the `usage` event report them. */
export interface SessionUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost: number;
  unknown_cost: boolean;
}

export const emptyUsage: SessionUsage = { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0, unknown_cost: false };

export function parseSessionUsage(u: unknown): SessionUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const rec = u as Record<string, unknown>;
  // an empty or foreign object is "no data", not an all-zero total that would wipe the chip
  if (!["input", "output", "cache_read", "cache_write", "cost"].some((k) => typeof rec[k] === "number")) return undefined;
  const n = (k: string) => Math.max(0, Number(rec[k]) || 0);
  return { input: n("input"), output: n("output"), cache_read: n("cache_read"), cache_write: n("cache_write"), cost: n("cost"), unknown_cost: (u as Record<string, unknown>).unknown_cost === true };
}

/** One more provider call (the `usage` of a finished assistant message). */
export function addUsage(total: SessionUsage | undefined, call: unknown): SessionUsage {
  const base = total ?? emptyUsage;
  const c = parseSessionUsage(call);
  if (!c) return base;
  const cost = (call as { cost?: unknown }).cost;
  const priced = typeof cost === "number" && Number.isFinite(cost) && cost >= 0;
  return {
    input: base.input + c.input,
    output: base.output + c.output,
    cache_read: base.cache_read + c.cache_read,
    cache_write: base.cache_write + c.cache_write,
    cost: base.cost + (priced ? cost : 0),
    unknown_cost: base.unknown_cost || !priced,
  };
}

export const sessionTokens = (u: Pick<SessionUsage, "input" | "output" | "cache_read" | "cache_write">) => u.input + u.output + u.cache_read + u.cache_write;

/** Share of the input that was served from the provider's cache, or null with no input at all. */
export function cacheHit(u: Pick<SessionUsage, "input" | "cache_read" | "cache_write">): number | null {
  const basis = u.input + u.cache_read + u.cache_write;
  return basis > 0 ? u.cache_read / basis : null;
}

export function fmtTokens(n: number): string {
  return new Intl.NumberFormat(locale(), { notation: "compact", maximumFractionDigits: n < 1000 ? 0 : 1 }).format(n);
}
export const fmtInt = (n: number) => new Intl.NumberFormat(locale()).format(Math.round(n));
export const fmtPercent = (ratio: number | null | undefined) =>
  ratio == null ? "—" : `${new Intl.NumberFormat(locale(), { maximumFractionDigits: ratio < 0.1 && ratio > 0 ? 1 : 0 }).format(ratio * 100)}%`;

function money(cost: number): string {
  if (cost === 0) return "$0";
  const digits = cost >= 100 ? 0 : cost >= 1 ? 2 : cost >= 0.01 ? 3 : 4;
  return `$${new Intl.NumberFormat(locale(), { minimumFractionDigits: digits === 0 ? 0 : 2, maximumFractionDigits: digits }).format(cost)}`;
}

/** Cost for display. Unknown stays unknown ("—"); a partial sum is marked "≥", never extrapolated. */
export function fmtCost(cost: number, unknown: boolean): string {
  if (unknown && cost <= 0) return "—";
  return `${unknown ? "≥ " : ""}${money(cost)}`;
}

/** Spoken/tooltip form of fmtCost. */
export function costNote(unknown: boolean, cost: number): string {
  if (unknown && cost <= 0) return t("Стоимость неизвестна: у провайдера или модели нет цены");
  if (unknown) return t("Не для всех запросов известна цена: показана сумма известных");
  return t("По ценам модели или данным провайдера");
}

// ---- dates (all local, "YYYY-MM-DD") ----
export function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
export const fmtDay = (day: string, long = false) =>
  parseDay(day).toLocaleDateString(locale(), long ? { weekday: "short", day: "numeric", month: "long" } : { day: "numeric", month: "short" });

// ---- chart data ----
export interface Bucket extends UsageCounts { start: string; end: string; lessons: number }

const zero = (): UsageCounts => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0, known_cost: false, unknown_cost: false, calls: 0 });

/** Every day of the period, empty days included; long periods are folded into weeks so bars stay readable. */
export function buckets(o: Pick<UsageOverview, "days" | "from" | "today">, maxBars = 62): Bucket[] {
  const first = o.from ?? o.today;
  const dayCount = Math.round((parseDay(o.today).getTime() - parseDay(first).getTime()) / 86_400_000) + 1;
  const size = Math.max(1, Math.ceil(dayCount / maxBars));
  const byDay = new Map(o.days.map((d) => [d.day, d]));
  const out: Bucket[] = [];
  for (let i = 0; i < dayCount; i += size) {
    const acc = zero();
    let lessons = 0;
    const last = Math.min(i + size, dayCount) - 1;
    for (let j = i; j <= last; j++) {
      const d = byDay.get(dayKey(addDays(parseDay(first), j)));
      if (!d) continue;
      acc.input += d.input; acc.output += d.output; acc.cache_read += d.cache_read; acc.cache_write += d.cache_write;
      acc.tokens += d.tokens; acc.cost += d.cost; acc.calls += d.calls;
      acc.known_cost ||= d.known_cost; acc.unknown_cost ||= d.unknown_cost;
      lessons = Math.max(lessons, d.lessons);
    }
    out.push({ ...acc, lessons, start: dayKey(addDays(parseDay(first), i)), end: dayKey(addDays(parseDay(first), last)) });
  }
  return out;
}

/** A round axis maximum at or above `max` and ticks that divide it evenly. */
export function niceScale(max: number, ticks = 4): { max: number; step: number } {
  if (max <= 0) return { max: 1, step: 1 / ticks };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  return { max: step * ticks, step };
}

export interface HeatCell { day: string; tokens: number; lessons: number; level: 0 | 1 | 2 | 3 | 4; future: boolean }
/** Monday-first weeks (columns) ending with the week of `today`. */
export function heatGrid(days: UsageDay[], today: string, weeks = 26): HeatCell[][] {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const end = parseDay(today);
  const lastMonday = addDays(end, -((end.getDay() + 6) % 7));
  const max = Math.max(0, ...days.map((d) => d.tokens));
  const grid: HeatCell[][] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const col: HeatCell[] = [];
    for (let r = 0; r < 7; r++) {
      const date = addDays(lastMonday, -7 * w + r);
      const key = dayKey(date);
      const d = byDay.get(key);
      const tokens = d?.tokens ?? 0;
      const level = tokens <= 0 || max <= 0 ? 0 : (Math.min(4, Math.max(1, Math.ceil((tokens / max) * 4))) as 1 | 2 | 3 | 4);
      col.push({ day: key, tokens, lessons: d?.lessons ?? 0, level, future: date > end });
    }
    grid.push(col);
  }
  return grid;
}

/** Shares of a total, largest first; the tail beyond `keep` is folded into one "other" entry. */
export function shares<T extends { tokens: number }>(rows: T[], keep: number): { row: T | null; tokens: number; share: number; rest: number }[] {
  const total = rows.reduce((s, r) => s + r.tokens, 0);
  const sorted = [...rows].sort((a, b) => b.tokens - a.tokens);
  const head: { row: T | null; tokens: number; share: number; rest: number }[] = sorted.slice(0, keep).map((row) => ({ row, tokens: row.tokens, rest: 0, share: total ? row.tokens / total : 0 }));
  const tail = sorted.slice(keep);
  if (tail.length) {
    const tokens = tail.reduce((s, r) => s + r.tokens, 0);
    head.push({ row: null, tokens, rest: tail.length, share: total ? tokens / total : 0 });
  }
  return head;
}

// ---- loading ----
export type UsageLoad = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: UsageOverview };

export function useUsageOverview(range: UsageRange) {
  const [load, setLoad] = useState<UsageLoad>({ state: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
    get<UsageOverview>(`/usage?range=${range}`).then(
      (data) => live && setLoad({ state: "ready", data }),
      (error) => live && setLoad({ state: "error", message: describe(error) }),
    );
    return () => { live = false; };
  }, [range, tick]);
  return { load, reload: useCallback(() => setTick((n) => n + 1), []) };
}
