/** MAX mini-app layer: sign-in through WebApp.initData, roles, classes and invites.
 *  Active only when the web server runs the MAX hub (`/graphy-config.json` has `hub: true`); the local app is unaffected. */
import { useSyncExternalStore } from "react";
import { setTeacherMode } from "./teaching-api";
import { notify } from "./toast";

export interface MaxUser { id: string; first_name: string; last_name: string; username: string; photo_url: string; language: string; role: "student" | "teacher" | null; name: string }
export interface HubStudent { id: string; name: string; photo_url: string; joined: number }
export interface HubClass { code: string; title: string; created: number; invite: string; teacher: { id: string; name: string; photo_url: string } | null; students?: HubStudent[] }

export interface MaxState {
  hub: boolean;
  status: "off" | "auth" | "ready" | "needs-max";
  /** the administrator blocked this account: show the server message instead of "open the link from the bot" */
  blocked?: boolean;
  user?: MaxUser;
  token?: string;
  bot?: string;
  start?: string;
  message?: string;
}

interface WebAppApi { initData?: string; ready?: () => void; openLink?: (url: string) => void; openMaxLink?: (url: string) => void; close?: () => void }
declare global { interface Window { WebApp?: WebAppApi } }

let state: MaxState = { hub: false, status: "off" };
const listeners = new Set<() => void>();
const set = (patch: Partial<MaxState>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };
export const getMax = () => state;
export const useMax = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);

function loadBridge(): Promise<void> {
  if (window.WebApp) return Promise.resolve();
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "https://st.max.ru/js/max-web-app.js";
    s.onload = () => resolve();
    s.onerror = () => resolve();
    document.head.append(s);
    setTimeout(resolve, 4000);
  });
}

export class HubError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export async function hub<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, { method, headers: { ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new HubError(0, "Нет связи с сервером"); }
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new HubError(r.status, (data as { error?: { message?: string } } | null)?.error?.message ?? `Ошибка ${r.status}`);
  return data as T;
}

/** Called by initBackend with the parsed /graphy-config.json. Returns the connection to use, or null when this is not hub mode. */
export async function initMax(config: { hub?: boolean; bot?: string }): Promise<{ url: string; token: string } | null> {
  if (!config.hub) return null;
  set({ hub: true, status: "auth", bot: config.bot });
  await loadBridge();
  const initData = window.WebApp?.initData;
  const ticket = new URLSearchParams(location.search).get("t");
  let stored = "";
  try { stored = localStorage.getItem("graphy-hub-token") || ""; } catch { /* private mode */ }
  let blockedStored = false;
  const viaStored = async () => {
    if (!stored) return null;
    try {
      const r = await fetch("/hub/me", { headers: { Authorization: `Bearer ${stored}` } });
      if (r.ok) { const d = await r.json(); set({ status: "ready", user: d.user, token: stored, bot: d.bot || config.bot }); return { url: location.origin, token: stored }; }
      if (r.status === 403) { const d = await r.json().catch(() => ({})); if (d?.error?.code === "blocked") { set({ status: "needs-max", message: d.error.message, blocked: true }); blockedStored = true; } }
    } catch { /* fall through */ }
    return null;
  };
  if (!initData && !ticket) { const s = await viaStored(); if (s) return s; if (!blockedStored) set({ status: "needs-max" }); return null; }
  // network hiccups are retried quietly; a rejected link falls back to the saved session, then to the «open from the bot» screen
  let lastMessage = "", lastBlocked = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch("/hub/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(initData ? { initData } : { ticket }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { lastMessage = data?.error?.message || ""; lastBlocked = data?.error?.code === "blocked"; break; }
      set({ status: "ready", user: data.user, token: data.token, bot: data.bot || config.bot, start: data.start });
      if (!initData) { try { localStorage.setItem("graphy-hub-token", data.token); history.replaceState(null, "", location.pathname + location.hash); } catch { /* optional */ } }
      try { window.WebApp?.ready?.(); } catch { /* optional */ }
      return { url: location.origin, token: data.token };
    } catch { await new Promise((res) => setTimeout(res, 1500)); }
  }
  if (lastBlocked) { set({ status: "needs-max", message: lastMessage, blocked: true }); return null; }
  const saved = await viaStored();
  if (saved) return saved;
  if (!blockedStored) set({ status: "needs-max", message: lastMessage });
  return null;
}

export async function chooseRole(role: "student" | "teacher") {
  const r = await hub<{ user: MaxUser }>("PUT", "/hub/role", { role });
  set({ user: r.user });
  await setTeacherMode(role === "teacher").catch(() => undefined);
}

export function openExternal(url: string) {
  try { if (window.WebApp?.openMaxLink && /^https:\/\/max\.ru\//.test(url)) return window.WebApp.openMaxLink(url); window.WebApp?.openLink?.(url); } catch { /* fall through */ }
  if (!window.WebApp?.openLink) window.open(url, "_blank", "noopener");
}
export const shareInvite = (cls: HubClass) => openExternal(`https://max.ru/:share?text=${encodeURIComponent(`Присоединяйся к моему классу «${cls.title}» в Graphy: ${cls.invite}`)}`);

// ---------- student ----------
const wantsJoin = () => /^j_[0-9a-f]{10}$/.test(state.start || "") ? state.start! : "";
let syncing = false;
/** Joins a class from a deep link (`startapp=j_<code>`). Safe to call often. */
export async function syncStudent() {
  if (!state.hub || state.status !== "ready" || state.user?.role !== "student" || syncing) return;
  syncing = true;
  try {
    const code = wantsJoin();
    if (!code) return;
    set({ start: "" });
    try { const r = await hub<{ class: HubClass }>("POST", "/hub/join", { code }); notify(`Вы в классе «${r.class.title}»${r.class.teacher ? ` · учитель ${r.class.teacher.name}` : ""}`, { kind: "success" }); } catch (e) { notify(e instanceof Error ? e.message : String(e), { kind: "error" }); }
  } finally { syncing = false; }
}

export function startMaxLoops() {
  const tick = () => { void syncStudent(); };
  tick();
  const timer = setInterval(tick, 90_000);
  const onVis = () => { if (document.visibilityState === "hidden") tick(); };
  document.addEventListener("visibilitychange", onVis);
  return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVis); };
}
