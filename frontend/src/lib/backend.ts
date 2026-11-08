import { useSyncExternalStore } from "react";
import { initMax } from "./max";

/** Browser connection settings; the web server keeps the API token on the server. */
export interface BackendStatus {
  state: "connecting" | "ready" | "error" | "missing";
  url?: string;
  token?: string;
  message?: string;
}

let status: BackendStatus = { state: "connecting" };
const listeners = new Set<() => void>();

function set(next: BackendStatus) {
  status = next;
  listeners.forEach((l) => l());
}

export async function initBackend() {
  set({ state: "connecting" });
  const url = import.meta.env.VITE_GRAPHY_URL as string | undefined;
  const token = import.meta.env.VITE_GRAPHY_TOKEN as string | undefined;
  if (url && token) {
    set({ state: "ready", url: url.replace(/\/$/, ""), token });
    return;
  }
  try {
    const response = await fetch("/graphy-config.json", { cache: "no-store" });
    if (!response.ok) throw new Error("connection settings unavailable");
    const config = await response.json();
    if (typeof config.url !== "string" || typeof config.token !== "string") throw new Error("invalid connection settings");
    if (config.hub) {
      const hubConn = await initMax(config);
      if (hubConn) set({ state: "ready", url: hubConn.url, token: hubConn.token });
      else set({ state: "missing", message: "" });
      return;
    }
    set({ state: "ready", url: config.url || location.origin, token: config.token });
  } catch {
    set({ state: "error", message: "Не удалось подключиться к серверу. Обновите страницу или повторите подключение." });
  }
}

export function retryBackend() { void initBackend(); }

export const getBackend = () => status;

export function subscribeBackend(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const useBackend = () => useSyncExternalStore(subscribeBackend, () => status);
