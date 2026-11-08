import { t, locale } from "../lib/i18n";
// Layout only. Colors, typography, shape, states and focus are Material Web defaults.
export const btnPrimary = "material-button";
export const btnOutline = "material-button";
export const btnGhost = "material-button";
export const sm = "";
export const iconBtn = "material-icon-button";
export const sheet = "rounded-sheet bg-sheet";
export const field = "material-field w-full";

export const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });

export function fmtAgo(ts: number): string {
  const diff = Date.now() - ts;
  const h = diff / 3_600_000;
  if (h < 1) return t("сейчас");
  if (h < 24) return t("{0} ч", [Math.floor(h)]);
  const d = Math.floor(h / 24);
  if (d === 1) return t("вчера");
  if (d < 7) return t("{0} дн", [d]);
  return new Date(ts).toLocaleDateString(locale(), { day: "numeric", month: "short" }).replace(".", "");
}

export function groupLabel(ts: number): string {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  if (ts >= start.getTime()) return t("Сегодня");
  if (ts >= start.getTime() - day) return t("Вчера");
  if (ts >= start.getTime() - 7 * day) return t("На этой неделе");
  return t("Раньше");
}

export const fmtBytes = (n?: number) =>
  n === undefined ? "" : n < 1024 ? t("{0} Б", [n]) : n < 1_048_576 ? t("{0} КБ", [Math.round(n / 1024)]) : t("{0} МБ", [(n / 1_048_576).toFixed(1)]);

