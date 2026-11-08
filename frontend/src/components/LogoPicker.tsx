import { t } from "../lib/i18n";
import { logoCandidates } from "../lib/logo-candidates";
import { DEFAULT_LOGO, ROUTE_ID, setLogoChoice, useLogoId, type LogoShape } from "../lib/logo-choice";
import { radioKeys } from "../lib/radio-keys";
import { MarkGlyph } from "./GraphyMark";

/** shape is null for the clean ROUTE. Ids and names come from the sheet (logo-candidates.ts). */
const TILES: { id: string; shape: LogoShape | null; number: string; name: string; note?: "чистый" | "оригинал" }[] = [
  { id: ROUTE_ID, shape: null, number: "16", name: "ROUTE", note: "чистый" },
  ...logoCandidates.map(shape => ({ id: shape.id, shape, number: shape.id, name: shape.name.replace(/, оригинал$/, ""), note: shape.name.endsWith("оригинал") ? "оригинал" as const : undefined })),
];
const IDS = TILES.map(tile => tile.id);

/** «Логотип»: the mark in the side panel, on the first screen and in the tab icon. The choice applies at once and is remembered. */
export function LogoPicker() {
  const value = useLogoId();
  const current = TILES.find(tile => tile.id === value) ?? TILES.find(tile => tile.id === DEFAULT_LOGO)!;
  return (
    <div>
      <div role="radiogroup" aria-label={t("Логотип")} className="logo-grid" onKeyDown={event => radioKeys(event, IDS, value, setLogoChoice)}>
        {TILES.map(tile => {
          const selected = tile.id === value;
          return (
            <button key={tile.id} type="button" role="radio" aria-checked={selected} tabIndex={selected ? 0 : -1} data-value={tile.id} data-logo={tile.id}
              aria-label={`${tile.number} ${tile.name}${tile.note ? `, ${t(tile.note)}` : ""}`} className="logo-tile" onClick={() => setLogoChoice(tile.id)}>
              <MarkGlyph shape={tile.shape} size={34} className="logo-tile-mark" />
              <span className="logo-tile-label"><b>{tile.number}</b> {tile.name}</span>
              <span className="logo-tile-note" aria-hidden="true">{tile.note ? t(tile.note) : " "}</span>
              <span className="logo-tile-check" aria-hidden="true">
                <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.4 6.6 11.5 12.5 4.8" /></svg>
              </span>
            </button>
          );
        })}
      </div>
      <p className="logo-current" role="status" data-logo-current={current.id}>{t("Сейчас: {0}", [`${current.number} ${current.name}`])}</p>
    </div>
  );
}
