import { applyMaterialTheme } from "./material-theme";
import { useSyncExternalStore } from "react";
import type { ColorPalette } from "./palette";

export type ThemePref = "system" | "light" | "dark";
export type Language = "ru" | "en";

export interface Settings {
  language: Language;
  theme: ThemePref;
  palette: ColorPalette;
  textSize: "s" | "m" | "l";
  width: "narrow" | "medium" | "wide";
  /** font of the answers in the dialog */
  font: "sans" | "serif";
  /** «off» overrides the system motion preference with reduced motion */
  motion: "system" | "off";

}

export const defaultSettings: Settings = {
  language: "ru",
  theme: "system",
  palette: "graphy",
  textSize: "m",
  width: "medium",
  font: "sans",
  motion: "system",
};

const KEY = "graphy-material-settings-v1";

function read(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Settings>;
      return { ...defaultSettings, language: saved.language === "en" ? "en" : "ru", theme: saved.theme === "light" || saved.theme === "dark" ? saved.theme : "system", palette: "graphy" /* MAX hidden for now */, textSize: saved.textSize === "s" || saved.textSize === "l" ? saved.textSize : "m", width: saved.width === "narrow" || saved.width === "wide" ? saved.width : "medium", font: saved.font === "serif" ? "serif" : "sans", motion: saved.motion === "off" ? "off" : "system" };
    }
    // migrate the old single-key theme preference
    const legacy = localStorage.getItem("graphy-material-theme");
    if (legacy === "light" || legacy === "dark") return { ...defaultSettings, theme: legacy };
  } catch {
    /* storage unavailable */
  }
  return defaultSettings;
}

let settings = read();
const listeners = new Set<() => void>();

export function applySettings(s: Settings) {
  const root = document.documentElement;
  root.lang = s.language;
  const dark = s.theme === "dark" || (s.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.palette = "graphy"; // MAX hidden for now
  applyMaterialTheme(dark);
  root.classList.toggle("dark", dark);
  root.dataset.textsize = s.textSize;
  root.dataset.width = s.width;
  root.dataset.font = s.font;
  if (s.motion === "off") root.dataset.motion = "off";
  else delete root.dataset.motion;
}

export function updateSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch, palette: "graphy" }; // MAX hidden for now
  applySettings(settings);
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

export const getSettings = () => settings;

export function useSettings(): Settings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => settings,
  );
}

export function initSettings() {
  applySettings(settings);
  // while the preference is "system", follow the OS
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (settings.theme === "system") applySettings(settings);
  });

}
