/**
 * What the learner can do in a lesson, sent to the backend. The outcome of every action arrives as events
 * (lib/sync.ts), so nothing here edits the transcript except the interface-only state around it.
 */
import { ApiError, describe, patch, post, put, sessionPath } from "./api";
import { getRemote } from "./remote";
import { appendBlock, getState, mergeSession, patchBlock, patchSession, setActive, uid } from "./store";
import { loadSession, applySnapshot } from "./sync";
import { markAttached } from "./queue";
import { hasOpenQuestion, isBusy, type NoticeAction } from "./types";
import { retryLast, unansweredText } from "./run-errors";
import { answerToWire, type Snapshot } from "./wire";

function failure(id: string, error: unknown) {
  const text = error instanceof ApiError && error.code === "network" ? "Нет связи с бэкендом. Проверьте, что он запущен." : describe(error);
  appendBlock(id, { id: uid("n"), kind: "notice", severity: "error", title: "Не получилось", detail: text, actions: [] });
}

/** Opens a lesson in the interface: loads it from the backend unless it already is. */
export async function openSession(id: string) {
  setActive(id);
  const s = getState().sessions[id];
  if (s && !s.loaded) {
    try {
      await loadSession(id);
    } catch (error) {
      failure(id, error);
    }
  }
}

/** Creates an empty lesson and returns its id; nothing is saved until the learner writes. */
export async function newSession(style: import("./styles").ExplanationStyle = "structured_reference", selection?: { model?: string; thinking?: string; quality?: "fast"|"balanced"|"deep" }): Promise<string> {
  const snapshot = await post<Snapshot>("/sessions", { explanation_style: style, ...(selection ?? {}), quality: selection?.quality ?? (selection?.model ? undefined : "balanced") });
  applySnapshot(snapshot);
  return snapshot.id;
}

export function isRunning(id: string) {
  const s = getState().sessions[id];
  return !!s && isBusy(s.agent);
}

export async function send(id: string, text: string, opts: { followup?: boolean } = {}) {
  const s = getState().sessions[id];
  if (!s) return;
  const typed = text.trim();
  let value = typed;
  if (!value && !s.chips.length) return;
  if (hasOpenQuestion(s)) return;
  const chips = s.chips;
  const paths = chips.filter((c) => c.kind !== "folder").map((c) => c.path).filter((p): p is string => !!p);
  const folders = chips.map((c) => c.context).filter(Boolean);
  if (folders.length) value = [value, ...folders].filter(Boolean).join("\n\n");
  if (chips.length && isBusy(s.agent)) markAttached(id, value);
  patchSession(id, (x) => ({ ...x, draft: "", chips: [] }));
  try {
    await post(sessionPath(id, "/messages"), { text: value, followup: !!opts.followup, paths });
  } catch (error) {
    // nothing was sent: the words and files go back where they were
    mergeSession(id, (x) => ({ ...x, draft: x.draft || typed, chips: [...chips, ...x.chips] }));
    failure(id, error);
  }
}

export function stop(id: string) {
  void post(sessionPath(id, "/abort")).catch((error) => failure(id, error));
}

/** Takes queued messages back into the editor (the backend drops its queue). */
export async function restoreQueue(id: string) {
  try {
    const { text } = await post<{ text: string }>(sessionPath(id, "/restore"));
    mergeSession(id, (s) => ({ ...s, queue: [], draft: [text, s.draft].filter(Boolean).join("\n\n") }));
  } catch (error) {
    failure(id, error);
  }
}

export async function noticeAction(id: string, blockId: string, action: NoticeAction["id"]) {
  if (!getState().sessions[id]) return;
  patchBlock(id, blockId, (b) => (b.kind === "notice" ? { ...b, actions: [] } : b));
  if (action === "continue") return send(id, "Продолжай");
  const last = unansweredText(id);
  if (action === "retry" && last !== null) {
    try {
      await retryLast(id, last);
    } catch (error) {
      failure(id, error);
    }
  }
  if ((action === "retry" || action === "edit") && last === null) failure(id, new ApiError(409, "retry_not_allowed", "Повтор невозможен: ответ уже начался. Напишите «Продолжай»."));
  if (action === "edit" && last !== null) mergeSession(id, (s) => ({ ...s, draft: last }));
}

/* ------------------------------------------------------------------------- test form */

type QBlock = Extract<import("./types").Block, { kind: "question" }>;

const questionBlock = (id: string, blockId: string): QBlock | undefined => {
  const b = getState().sessions[id]?.blocks.find((x) => x.id === blockId);
  return b?.kind === "question" ? b : undefined;
};

const wireAnswers = (block: QBlock) => block.questions.map((q) => answerToWire(q, block.answers[q.id]));
const wireStep = (block: QBlock) => (block.view === "review" ? block.questions.length : block.step);

/** Writes the form's current answers to the backend. Returns true when they are stored. */
export async function saveDraft(id: string, blockId: string): Promise<boolean> {
  const block = questionBlock(id, blockId);
  if (!block || block.state === "submitted" || block.state === "cancelled") return false;
  try {
    await put(sessionPath(id, `/questions/${encodeURIComponent(blockId)}/draft`), { answers: wireAnswers(block), step: wireStep(block) });
    return true;
  } catch {
    return false;
  }
}

/** The learner pressed «Отправить ответы»: the whole block goes to the agent at once. */
export async function submitQuestions(id: string, blockId: string) {
  const block = questionBlock(id, blockId);
  if (!block) return;
  try {
    await post(sessionPath(id, `/questions/${encodeURIComponent(blockId)}/submit`), { answers: wireAnswers(block) });
  } catch (error) {
    patchBlock(id, blockId, (b) => (b.kind === "question" ? { ...b, warn: describe(error) } : b));
  }
}

export async function cancelQuestions(id: string, blockId: string) {
  try {
    await post(sessionPath(id, `/questions/${encodeURIComponent(blockId)}/cancel`));
  } catch (error) {
    failure(id, error);
  }
}

/* ------------------------------------------------------------------------ lesson settings */

/** `rethrow`: the caller shows the refusal itself (the rename dialog) instead of a notice in the lesson. */
export async function renameLesson(id: string, title: string, rethrow = false) {
  try {
    await patch(sessionPath(id), { name: title });
    mergeSession(id, (s) => ({ ...s, title }));
  } catch (error) {
    if (rethrow) throw error;
    failure(id, error);
  }
}

/** Sets the model and/or reasoning level of a lesson. */
export async function setLessonModel(id: string, model: string, thinking?: string, quality?: "fast"|"balanced"|"deep") {
  mergeSession(id, (s) => ({ ...s, model, thinking: thinking ?? s.thinking })); // optimistic: the menu answers at once, the server confirms below
  try {
    const summary = await put<import("./wire").SessionSummary>(sessionPath(id, "/model"), quality ? { quality } : { model, thinking });
    mergeSession(id, (s) => ({ ...s, model: summary.model ?? s.model, thinking: summary.thinking ?? s.thinking }));
  } catch (error) {
    failure(id, error);
  }
}

export async function setLessonStyle(id: string, explanationStyle: import("./styles").ExplanationStyle) {
  try {
    const summary = await put<import("./wire").SessionSummary>(sessionPath(id, "/style"), { explanation_style: explanationStyle });
    mergeSession(id, (s) => ({ ...s, explanationStyle: summary.explanation_style ?? s.explanationStyle }));
  } catch (error) {
    failure(id, error);
  }
}

export async function compactLesson(id: string) {
  try {
    await post(sessionPath(id, "/compact"));
  } catch (error) {
    failure(id, error);
  }
}

/** Reasoning levels the lesson's model offers (empty when the model is unknown). */
export function reasoningLevels(model: string): string[] {
  return getRemote().models.find((m) => m.id === model)?.thinking_levels ?? [];
}
