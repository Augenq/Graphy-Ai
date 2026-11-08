import { locale, t } from "./i18n";

/** «только что», «1 мин», «3 ч», then a date: the label under an answer. */
export function relativeTime(ts: number, now = Date.now()): string {
  const min = Math.max(0, Math.floor((now - ts) / 60_000));
  if (min < 1) return t("только что");
  if (min < 60) return t("{0} мин", [min]);
  const h = Math.floor(min / 60);
  if (h < 24) return t("{0} ч", [h]);
  const d = Math.floor(h / 24);
  if (d === 1) return t("вчера");
  if (d < 7) return t("{0} дн", [d]);
  return new Date(ts).toLocaleDateString(locale(), { day: "numeric", month: "short" }).replace(".", "");
}
