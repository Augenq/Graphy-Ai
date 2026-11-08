import { useCallback, useEffect, useState } from "react";

export const SETTINGS_SECTION_IDS = ["profile", "general", "appearance", "agent", "skills", "memory", "data", "usage", "keyboard", "about"] as const;
export type SettingsSection = (typeof SETTINGS_SECTION_IDS)[number];

/** Settings are a page of their own and live in the hash: `#settings/<section>`.
 *  `#settings` alone is the old entry: «Внешний вид» on a desktop, the list of sections on a phone (section = null). */
export type SettingsRoute = { open: boolean; section: SettingsSection | null };
const CLOSED: SettingsRoute = { open: false, section: null };

const isSection = (value: string | undefined): value is SettingsSection => !!value && (SETTINGS_SECTION_IDS as readonly string[]).includes(value);

export function parseSettingsHash(hash: string): SettingsRoute {
  let text = hash.replace(/^#/, "");
  try { text = decodeURIComponent(text); } catch { /* keep the raw text */ }
  const [head, tail] = text.split("/");
  if (head === "settings") return { open: true, section: isSection(tail) ? tail : null };
  if (head === "skills" || head === "memory") return { open: true, section: head }; // older deep links
  return CLOSED;
}

export const settingsHash = (section: SettingsSection | null) => section ? `#settings/${section}` : "#settings";
export const isPhone = () => window.matchMedia("(max-width: 600px)").matches;

/** Each history entry written here remembers how many steps back the screen was before Settings opened (state.graphySettings),
 *  so «Back» leaves exactly as the browser's Back would. After a reload (or a link) that depth is unknown: the hash is just removed. */
const depthOf = (): number => {
  const depth = (history.state as { graphySettings?: unknown } | null)?.graphySettings;
  return typeof depth === "number" ? depth : -1;
};
/** What had the focus when Settings opened. It must be read before the page makes the workspace inert (the browser then drops the focus), so it is kept here. */
let opener: HTMLElement | null = null;
export function returnFocus() {
  const el = opener;
  opener = null;
  if (el?.isConnected && !el.closest("[inert]")) el.focus({ preventScroll: true });
}
const here = () => window.location.pathname + window.location.search;

export function useSettingsRoute() {
  const [route, setRoute] = useState<SettingsRoute>(() => parseSettingsHash(window.location.hash));
  const set = useCallback((next: SettingsRoute) => setRoute(prev => (prev.open === next.open && prev.section === next.section ? prev : next)), []);

  useEffect(() => {
    const sync = () => set(parseSettingsHash(window.location.hash));
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => { window.removeEventListener("hashchange", sync); window.removeEventListener("popstate", sync); };
  }, [set]);

  // the old bare `#settings` (and `#skills`, `#memory`) open «Внешний вид» (or the section) on a desktop; the address becomes the canonical one
  useEffect(() => {
    if (!route.open) return;
    const wanted = route.section ?? (isPhone() ? null : "appearance");
    if (settingsHash(wanted) !== window.location.hash) history.replaceState(history.state, "", here() + settingsHash(wanted));
    if (wanted !== route.section) set({ open: true, section: wanted });
  }, [route, set]);

  /** Open a section; without one: «Внешний вид» on a desktop, the list on a phone. */
  const open = useCallback((section?: SettingsSection | null) => {
    const current = parseSettingsHash(window.location.hash);
    const target = section === undefined ? (isPhone() ? null : "appearance") : section;
    if (current.open && current.section === target) return;
    if (!current.open) opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const depth = depthOf();
    history.pushState({ graphySettings: current.open ? (depth > 0 ? depth + 1 : -1) : 1 }, "", here() + settingsHash(target));
    set({ open: true, section: target });
  }, [set]);

  /** Leave Settings for the screen they were opened from (the workspace stayed mounted under the page). */
  const close = useCallback(() => {
    if (!parseSettingsHash(window.location.hash).open) { set(CLOSED); return; }
    const depth = depthOf();
    set(CLOSED);
    if (depth > 0) history.go(-depth);
    else history.replaceState(null, "", here());
  }, [set]);

  /** A phone: from a section back to the list of sections. */
  const up = useCallback(() => {
    if (depthOf() >= 2) history.back();
    else { history.replaceState(history.state, "", here() + settingsHash(null)); set({ open: true, section: null }); }
  }, [set]);

  /** The section to show: the bare `#settings` is «Внешний вид» on a desktop (null = the list of sections, a phone only). */
  const section = route.open ? (route.section ?? (isPhone() ? null : "appearance")) : null;
  return { isOpen: route.open, section, open, close, up };
}
