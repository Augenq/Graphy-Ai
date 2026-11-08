import { useSyncExternalStore } from "react";

export type ToastKind = "info" | "success" | "warn" | "error";
export interface ToastAction { label: string; run: () => void }
export interface Toast { id: number; rev: number; text: string; kind: ToastKind; action?: ToastAction; duration: number }
export interface NotifyOptions { kind?: ToastKind; action?: ToastAction; duration?: number }

const MAX_VISIBLE = 4;
let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** The one way to tell the user something short. Returns an id for `dismissToast`. Errors stay longer. */
export function notify(text: string, opts: NotifyOptions = {}): number {
  const kind = opts.kind ?? "info";
  // The same message again: keep the toast (no new announcement), only restart its timer.
  const same = toasts.find((x) => x.text === text && x.kind === kind);
  if (same) { toasts = toasts.map((x) => (x.id === same.id ? { ...x, rev: x.rev + 1 } : x)); emit(); return same.id; }
  const toast: Toast = { id: nextId++, rev: 0, text, kind, action: opts.action, duration: opts.duration ?? (kind === "error" ? 9000 : opts.action ? 8000 : 5000) };
  toasts = [...toasts, toast].slice(-MAX_VISIBLE);
  emit();
  return toast.id;
}

export function dismissToast(id: number) {
  const before = toasts.length;
  toasts = toasts.filter((x) => x.id !== id);
  if (toasts.length !== before) emit();
}

export const clearToasts = () => { toasts = []; emit(); };
export const getToasts = () => toasts;

export function useToasts(): Toast[] {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), getToasts);
}
