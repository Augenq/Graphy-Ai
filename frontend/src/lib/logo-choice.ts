import { useSyncExternalStore } from "react";
import { logoCandidates } from "./logo-candidates";

/** A traced logo shape (filled path, drawn with currentColor). */
export type LogoShape = { id: string; name: string; viewBox: string; transform: string; d: string };

/** The clean vector of logo 16 «ROUTE» (GraphyMark's own drawing, a stroked route with a tail). It is not in the traced sheet. */
export const ROUTE_ID = "route";
/** Logo 2 «FOLD» is the mark of Graphy until the learner chooses another one in Settings → Appearance. */
export const DEFAULT_LOGO = "02";
export const LOGO_IDS: string[] = [ROUTE_ID, ...logoCandidates.map(shape => shape.id)];

const KEY = "graphy-logo-v1";
const ROUTE_PATH = "M18.52 3.75A9.341 9.341 0 1 0 20.644 6.899M21.341 10.439V22.902";

export const shapeOf = (id: string): LogoShape | null => logoCandidates.find(shape => shape.id === id) ?? null;
const valid = (id: string | null | undefined): id is string => !!id && LOGO_IDS.includes(id);

function read(): string {
  try { const saved = localStorage.getItem(KEY); return valid(saved) ? saved : DEFAULT_LOGO; } catch { return DEFAULT_LOGO; }
}

let current = read();
const listeners = new Set<() => void>();

export const getLogoId = () => current;

/** Tab icon: the same mark, with the light ink on a dark browser theme. The static public/favicon.svg is the default one. */
function applyFavicon(id: string) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  link.dataset.original ??= link.getAttribute("href") ?? "/favicon.svg";
  if (id === DEFAULT_LOGO) { link.setAttribute("href", link.dataset.original); return; }
  const shape = shapeOf(id);
  const style = "<style>.m{fill:#1f1f1f}@media (prefers-color-scheme:dark){.m{fill:#f0f0f0}}</style>";
  const svg = shape
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${shape.viewBox}">${style}<g transform="${shape.transform}"><path class="m" d="${shape.d}"/></g></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2.196" stroke-linecap="round"><style>.m{stroke:#1f1f1f}@media (prefers-color-scheme:dark){.m{stroke:#f0f0f0}}</style><path class="m" d="${ROUTE_PATH}"/></svg>`;
  link.setAttribute("href", `data:image/svg+xml,${encodeURIComponent(svg)}`);
}

export function initLogo() { applyFavicon(current); }

export function setLogoChoice(id: string) {
  const next = valid(id) ? id : DEFAULT_LOGO;
  if (next === current) return;
  current = next;
  try { localStorage.setItem(KEY, next); } catch { /* the choice just is not remembered */ }
  applyFavicon(next);
  listeners.forEach(listener => listener());
}

export const useLogoId = () => useSyncExternalStore(
  listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  () => current,
);

/** The chosen traced shape, or null when the clean ROUTE is chosen. */
export const useLogoChoice = (): LogoShape | null => shapeOf(useLogoId());
