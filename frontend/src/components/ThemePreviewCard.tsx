import { useId, useSyncExternalStore } from "react";
import { t } from "../lib/i18n";
import { paletteFor } from "../lib/palette";
import { radioKeys } from "../lib/radio-keys";
import { updateSettings, useSettings, type ThemePref } from "../lib/settings";

type Palette = Record<keyof ReturnType<typeof paletteFor>, string>;

/** The OS preference, live: the «Системная» card says what it follows right now. */
function useSystemDark() {
  return useSyncExternalStore(
    listener => { const query = window.matchMedia("(prefers-color-scheme: dark)"); query.addEventListener("change", listener); return () => query.removeEventListener("change", listener); },
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
}

/** A miniature of the real app in one palette: the side panel (mark, new lesson, lessons with one selected), an answer, the learner's message and the input panel.
 *  Colors are the app's own palette values, not the page's current theme, so each card shows the theme it would apply. */
function Mini({ p, dark }: { p: Palette; dark: boolean }) {
  const ink = (opacity: number) => ({ fill: p.ink, opacity });
  const ring = dark ? "rgba(255,255,255,.14)" : "rgba(20,20,20,.16)";
  return (
    <g>
      <rect width="160" height="100" fill={p.paper} />
      {/* side panel */}
      <rect width="42" height="100" fill={p.rail} />
      <line x1="42" y1="0" x2="42" y2="100" stroke={p.rule} strokeWidth=".6" />
      <g transform="translate(7 7) scale(.3)" fill="none" stroke={p.ink} strokeWidth="2.6" strokeLinecap="round"><path d="M18.52 3.75A9.341 9.341 0 1 0 20.644 6.899M21.341 10.439V22.902" /></g>
      <rect x="18" y="10.2" width="16" height="3" rx="1.5" {...ink(.85)} />
      <rect x="6" y="21" width="30" height="8.5" rx="3" fill={dark ? p.wash : p.sheet} stroke={p.rule} strokeWidth=".6" />
      <rect x="10" y="24.2" width="16" height="2.2" rx="1.1" {...ink(.7)} />
      <rect x="5" y="36" width="32" height="8" rx="2.5" fill={p.ink} opacity=".09" />
      <rect x="9" y="38.9" width="20" height="2.2" rx="1.1" {...ink(.85)} />
      <rect x="9" y="50" width="24" height="2.2" rx="1.1" {...ink(.4)} />
      <rect x="9" y="58" width="18" height="2.2" rx="1.1" {...ink(.4)} />
      <rect x="9" y="66" width="22" height="2.2" rx="1.1" {...ink(.4)} />
      {/* an answer with a formula line */}
      <rect x="54" y="12" width="64" height="2.6" rx="1.3" {...ink(.8)} />
      <rect x="54" y="19" width="86" height="2.2" rx="1.1" {...ink(.42)} />
      <rect x="54" y="25" width="74" height="2.2" rx="1.1" {...ink(.42)} />
      <rect x="64" y="32" width="34" height="3.2" rx="1.6" {...ink(.62)} />
      {/* the learner's message */}
      <rect x="96" y="44" width="54" height="11" rx="5.5" fill={p.bubble} />
      <rect x="102" y="48.4" width="38" height="2.2" rx="1.1" {...ink(.55)} />
      {/* the input panel */}
      <rect x="50" y="71" width="102" height="21" rx="7" fill={dark ? p.wash : p.sheet} stroke={ring} strokeWidth=".8" />
      <rect x="56" y="77" width="48" height="2.2" rx="1.1" {...ink(.3)} />
      <circle cx="143" cy="84" r="4" fill="none" stroke={p.ink} strokeWidth=".9" opacity=".7" />
      <path d="M143 86.2V81.8M141.2 83.4 143 81.6l1.8 1.8" fill="none" stroke={p.ink} strokeWidth=".9" strokeLinecap="round" strokeLinejoin="round" opacity=".7" />
    </g>
  );
}

function Preview({ theme }: { theme: ThemePref }) {
  const id = useId();
  const { palette } = useSettings();
  const light = paletteFor(false, palette), dark = paletteFor(true, palette);
  return (
    <svg viewBox="0 0 160 100" className="theme-card-svg" aria-hidden="true" focusable="false">
      {theme === "system" ? (
        <>
          <defs>
            <clipPath id={`${id}-l`}><rect width="80" height="100" /></clipPath>
            <clipPath id={`${id}-d`}><rect x="80" width="80" height="100" /></clipPath>
          </defs>
          <g clipPath={`url(#${id}-l)`}><Mini p={light} dark={false} /></g>
          <g clipPath={`url(#${id}-d)`}><Mini p={dark} dark /></g>
          <line x1="80" y1="0" x2="80" y2="100" stroke="rgba(128,128,128,.55)" strokeWidth=".6" />
        </>
      ) : <Mini p={theme === "dark" ? dark : light} dark={theme === "dark"} />}
    </svg>
  );
}

function Dots({ theme }: { theme: ThemePref }) {
  const { palette } = useSettings();
  const l = paletteFor(false, palette), d = paletteFor(true, palette);
  const background = theme === "system" ? `linear-gradient(90deg, ${l.paper} 50%, ${d.paper} 50%)` : (theme === "dark" ? d : l).paper;
  const ink = theme === "system" ? `linear-gradient(90deg, ${l.ink} 50%, ${d.ink} 50%)` : (theme === "dark" ? d : l).ink;
  const wash = theme === "system" ? `linear-gradient(90deg, ${l.wash} 50%, ${d.wash} 50%)` : (theme === "dark" ? d : l).wash;
  return <span className="theme-card-dots" aria-hidden="true">{[background, wash, ink].map((value, i) => <i key={i} style={{ background: value }} />)}</span>;
}

const THEMES: { id: ThemePref; label: string }[] = [
  { id: "light", label: "Светлая" },
  { id: "dark", label: "Тёмная" },
  { id: "system", label: "Системная" },
];

export function ThemePreviewCard({ theme, selected, onSelect, hint }: { theme: ThemePref; selected: boolean; onSelect: (theme: ThemePref) => void; hint: string }) {
  const label = t(THEMES.find(item => item.id === theme)!.label);
  return (
    <button type="button" role="radio" aria-checked={selected} tabIndex={selected ? 0 : -1} data-value={theme} data-theme-card={theme}
      className="theme-card" onClick={() => onSelect(theme)}>
      <span className="theme-card-frame">
        <Preview theme={theme} />
        <span className="theme-card-check" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.4 6.6 11.5 12.5 4.8" /></svg>
        </span>
      </span>
      <span className="theme-card-meta">
        <span className="theme-card-text">
          <span className="theme-card-name">{label}</span>
          <span className="theme-card-hint">{hint}</span>
        </span>
        <Dots theme={theme} />
      </span>
    </button>
  );
}

/** Three radio cards: light, dark, follow the device. The choice applies at once and is remembered (lib/settings). */
export function ThemeChoice({ value }: { value: ThemePref }) {
  const systemDark = useSystemDark();
  const ids = THEMES.map(item => item.id);
  const hints: Record<ThemePref, string> = {
    light: t("Светлый фон"),
    dark: t("Тёмный фон"),
    system: systemDark ? t("Сейчас: тёмная") : t("Сейчас: светлая"),
  };
  return (
    <div role="radiogroup" aria-label={t("Тема")} className="theme-cards" onKeyDown={event => radioKeys(event, ids, value, id => updateSettings({ theme: id }))}>
      {THEMES.map(item => <ThemePreviewCard key={item.id} theme={item.id} selected={value === item.id} hint={hints[item.id]} onSelect={id => updateSettings({ theme: id })} />)}
    </div>
  );
}
