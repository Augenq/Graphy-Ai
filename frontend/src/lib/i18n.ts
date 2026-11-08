import { getSettings, useSettings } from "./settings";
import { en as enBase } from "./locales/en";

/** Feature dictionaries: `locales/en.<feature>.ts` each export `default` Record<ru, en>; merged with the base file. */
const featureEn = Object.values(
  import.meta.glob<{ default: Record<string, string> }>("./locales/en.*.ts", { eager: true }),
).reduce<Record<string, string>>((all, m) => Object.assign(all, m.default), {});
const en: Record<string, string> = { ...enBase, ...featureEn };

/** Russian source messages are stable keys; lesson content is never translated implicitly. */
export function t(message: string, values: readonly unknown[] = []): string {
  const translated = getSettings().language === "en" ? (en[message] ?? message) : message;
  return translated.replace(/\{(\d+)\}/g, (token, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : token,
  );
}

export const locale = () => getSettings().language === "en" ? "en-US" : "ru-RU";
export const useLanguage = () => useSettings().language;

/** Select a plural form without assembling English sentences from Russian word endings. */
export function plural(n: number, one: string, few: string, many: string): string {
  const category = new Intl.PluralRules(locale()).select(n);
  return t(category === "one" ? one : category === "few" ? few : many);
}
