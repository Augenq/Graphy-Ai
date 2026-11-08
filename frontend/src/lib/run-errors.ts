/**
 * Failed and stalled agent runs: the typed reason shown to the learner, the retry rules and the tiny store
 * behind the «агент завис» banner. Retrying re-sends the last learner message only while the agent has not
 * started to answer it, and never replays a tool by itself.
 */
import { useSyncExternalStore } from "react";
import { ApiError, describe, post, sessionPath } from "./api";
import { getState, mergeSession } from "./store";
import type { NoticeAction } from "./types";

export type RunErrorCode = "stalled" | "rate_limit" | "auth" | "network" | "context" | "model" | "empty" | "error";

const TITLES: Record<RunErrorCode, [string, string?]> = {
  stalled: ["Агент завис", "Запрос остановлен, написанное сохранено."],
  rate_limit: ["Лимит запросов провайдера", "Подождите немного и повторите."],
  auth: ["Нет доступа к провайдеру", "Проверьте вход или ключ в настройках."],
  network: ["Нет связи с провайдером", "Проверьте подключение и повторите."],
  context: ["Не хватает места в контексте", "Сожмите историю занятия и повторите."],
  model: ["Модель не подходит", "Выберите модель с поддержкой инструментов."],
  empty: ["Модель не ответила"],
  error: ["Не удалось продолжить"],
};

export const runErrorTitle = (code: string | undefined) => (TITLES[code as RunErrorCode] ?? TITLES.error)[0];
export const runErrorHint = (code: string | undefined) => (TITLES[code as RunErrorCode] ?? TITLES.error)[1];

/** Actions under a failed run: retry only if the learner's last message is still unanswered. */
export function runErrorActions(code: string | undefined, canRetry: boolean): NoticeAction[] {
  const base: NoticeAction[] = [{ id: "choose_model", label: "Сменить модель" }];
  if (canRetry) return [{ id: "retry", label: "Повторить" }, { id: "edit", label: "Изменить и отправить" }, ...base];
  return [{ id: "continue", label: "Продолжить" }, ...base];
}

/** The text of the learner's last message, if the agent has not answered it yet. */
export function unansweredText(id: string): string | null {
  const blocks = getState().sessions[id]?.blocks ?? [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === "user") return b.text;
    if (b.kind === "text" || b.kind === "action" || b.kind === "widget" || b.kind === "object") return null;
  }
  return null;
}

/** Re-sends the last message (the backend does not add it twice). Throws the typed refusal. */
export async function retryLast(id: string, text: string) {
  await post(sessionPath(id, "/messages"), { text, retry: true });
}

/* ----------------------------------------------------------------------- stalled banner */

export interface Stalled {
  phase: "model" | "tool";
  seconds: number;
}
const stalled = new Map<string, Stalled>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setStalled(id: string, value: Stalled | null) {
  if (value) stalled.set(id, value);
  else if (!stalled.delete(id)) return;
  emit();
}
export function useStalled(id: string): Stalled | undefined {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => stalled.get(id),
  );
}

/** «Подождать»: the backend gives the run another period. */
export async function waitMore(id: string): Promise<string | null> {
  setStalled(id, null);
  try {
    await post(sessionPath(id, "/stall/wait"));
    return null;
  } catch (error) {
    return describe(error);
  }
}

/* ------------------------------------------------------------------------ queue items */

/** Edits (`text`) or removes (no `text`) a queued message; `index` counts within its kind. Returns an error text or null. */
export async function changeQueued(id: string, position: number, text?: string): Promise<string | null> {
  const queue = getState().sessions[id]?.queue ?? [];
  const item = queue[position];
  if (!item) return null;
  const index = queue.slice(0, position).filter((q) => q.followup === item.followup).length;
  try {
    await post(sessionPath(id, "/queue/edit"), { followup: item.followup, index, ...(text === undefined ? {} : { text }) });
    mergeSession(id, (s) => ({ ...s, queue: text === undefined ? s.queue.filter((_, i) => i !== position) : s.queue.map((q, i) => (i === position ? { ...q, text } : q)) }));
    return null;
  } catch (error) {
    // the message already left the queue: drop it from the list instead of pretending it is still there
    if (error instanceof ApiError && error.code === "queue_item_gone") mergeSession(id, (s) => ({ ...s, queue: s.queue.filter((_, i) => i !== position) }));
    return describe(error);
  }
}
