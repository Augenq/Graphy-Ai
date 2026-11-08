import { Component, type ReactNode } from "react";
import { t } from "../lib/i18n";

const FLAG = "graphy-chunk-reload";

/** A lazy chunk that cannot load (offline, or a tab left open across a redeploy: the old file names are gone) reloads the page once;
 *  the sessionStorage flag keeps a persistent failure from looping. It is cleared a while after a successful start. */
export function reloadOnce(): boolean {
  try {
    if (sessionStorage.getItem(FLAG)) return false;
    sessionStorage.setItem(FLAG, "1");
  } catch {
    return false;
  }
  location.reload();
  return true;
}
export function clearReloadFlag() {
  try { sessionStorage.removeItem(FLAG); } catch { /* storage unavailable */ }
}
if (typeof window !== "undefined") {
  window.addEventListener("vite:preloadError", (e) => { if (reloadOnce()) e.preventDefault(); });
}

interface Props { children: ReactNode; /** what the surface is, for the failure note */ label?: string }
/** Wraps a lazy surface: a failed load shows a small «Обновить» action instead of blanking the app. */
export class LazyBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) {
    if (/dynamically imported module|importing a module script|ChunkLoadError|Failed to fetch|Load failed/i.test(String((error as Error)?.message ?? error))) reloadOnce();
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" style={{ position: "fixed", insetInline: 0, bottom: 16, zIndex: 80, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
        <div style={{ pointerEvents: "auto", display: "flex", gap: 12, alignItems: "center", padding: "8px 8px 8px 16px", borderRadius: 12, background: "var(--surface-page, #fff)", color: "var(--ink, #111)", boxShadow: "0 0 0 1px var(--rule, #ccc), 0 4px 16px rgb(0 0 0 / 0.16)", font: "400 14px/20px var(--font-sans, sans-serif)" }}>
          <span>{t("Не удалось загрузить экран. Проверьте соединение.")}</span>
          <button type="button" onClick={() => { clearReloadFlag(); location.reload(); }} style={{ height: 32, padding: "0 12px", border: 0, borderRadius: 8, background: "var(--ink, #111)", color: "var(--surface-page, #fff)", font: "inherit", cursor: "pointer" }}>{t("Обновить")}</button>
        </div>
      </div>
    );
  }
}
