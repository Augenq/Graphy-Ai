/**
 * Messages written while the agent works wait in the backend's queue (steering = delivered at the next step,
 * follow-up = after the answer). The backend can only drain the whole queue, so editing, removing, reordering
 * or "send now" drains it (the restore route) and posts the new list back in order.
 */
import { describe, post, sessionPath } from "./api";
import { appendBlock, getState, mergeSession, patchSession, uid } from "./store";

export interface QueuedMessage { text: string; followup: boolean }

/** typed text of messages that were queued together with attachments: they cannot be re-posted without losing the files */
const withFiles = new Map<string, Set<string>>();

export function markAttached(id: string, typed: string) {
  const set = withFiles.get(id) ?? new Set<string>();
  set.add(typed.trim());
  withFiles.set(id, set);
}

/** True when a queued message carries attachments (its text starts with what was typed). */
export function isLocked(id: string, queued: QueuedMessage): boolean {
  for (const typed of withFiles.get(id) ?? []) if (typed && queued.text.startsWith(typed)) return true;
  return false;
}

/** True when any waiting message carries files: the list is then read-only except "back to the editor". */
export const queueLocked = (id: string, queue: QueuedMessage[]) => queue.some((m) => isLocked(id, m));

export type QueueOp =
  | { kind: "remove"; index: number }
  | { kind: "move"; index: number; by: -1 | 1 }
  | { kind: "edit"; index: number }
  | { kind: "steer"; index: number };

/** Pure: the queue after the operation, and the text to put in the editor (for edit). */
export function applyQueueOp(queue: QueuedMessage[], op: QueueOp): { queue: QueuedMessage[]; draft?: string } | null {
  const item = queue[op.index];
  if (!item) return null;
  const rest = queue.filter((_, i) => i !== op.index);
  switch (op.kind) {
    case "remove": return { queue: rest };
    case "edit": return { queue: rest, draft: item.text };
    case "steer": return item.followup ? { queue: [{ ...item, followup: false }, ...rest.filter((m) => !m.followup), ...rest.filter((m) => m.followup)] } : null;
    case "move": {
      const to = op.index + op.by;
      if (to < 0 || to >= queue.length) return null;
      const next = queue.slice();
      [next[op.index], next[to]] = [next[to], next[op.index]];
      return { queue: next };
    }
  }
}

let chain: Promise<void> = Promise.resolve();

/** Applies an operation to the backend queue. Operations run one after another. */
export function queueOperation(id: string, op: QueueOp): Promise<void> {
  chain = chain.then(async () => {
    const before = getState().sessions[id]?.queue ?? [];
    if (queueLocked(id, before)) return; // re-posting would drop the files of a message that carries them
    const result = applyQueueOp(before, op);
    if (!result) return;
    try {
      await post(sessionPath(id, "/restore"));
      mergeSession(id, (s) => ({ ...s, queue: [] }));
      for (const m of result.queue) await post(sessionPath(id, "/messages"), { text: m.text, followup: m.followup, paths: [] });
      if (result.draft !== undefined) patchSession(id, (s) => ({ ...s, draft: [result.draft, s.draft].filter(Boolean).join("\n\n") }));
    } catch (error) {
      appendBlock(id, { id: uid("n"), kind: "notice", severity: "error", title: "Не получилось", detail: describe(error), actions: [] });
    }
  });
  return chain;
}
