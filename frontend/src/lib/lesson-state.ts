import { useEffect, useSyncExternalStore } from "react";
import { getState, subscribeStore } from "./store";
import { hasOpenQuestion, isBusy, type Session } from "./types";

/**
 * Sidebar state of a lesson: pinned, marked finished (or reopened) by the learner, and «unread» when a reply
 * ended while the lesson was not open. Interface-only and local: kept in localStorage, never sent anywhere.
 */
interface Saved {
  pinned: string[];
  /** explicit choice of the learner; absent = follow the lesson's own `finished` flag */
  done: Record<string, boolean>;
  unread: string[];
}

const KEY = "graphy-lesson-state-v1";

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Whatever is in storage, only well-formed entries survive: a corrupted value can never reach the sidebar. */
export function parseSaved(raw: string | null): Saved {
  try {
    const p: unknown = JSON.parse(raw ?? "null");
    if (!p || typeof p !== "object") return { pinned: [], done: {}, unread: [] };
    const o = p as Record<string, unknown>;
    const done: Record<string, boolean> = {};
    if (o.done && typeof o.done === "object" && !Array.isArray(o.done))
      for (const [k, v] of Object.entries(o.done)) if (typeof v === "boolean") done[k] = v;
    return { pinned: strings(o.pinned), done, unread: strings(o.unread) };
  } catch {
    return { pinned: [], done: {}, unread: [] };
  }
}

function load(): Saved {
  try {
    return parseSaved(localStorage.getItem(KEY));
  } catch {
    return parseSaved(null);
  }
}

let saved = load();
const listeners = new Set<() => void>();

function commit(next: Saved) {
  saved = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    /* storage unavailable: state lives for this run */
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
export const useLessonMarks = () => useSyncExternalStore(subscribe, () => saved);

export const togglePinned = (id: string) =>
  commit({ ...saved, pinned: saved.pinned.includes(id) ? saved.pinned.filter((x) => x !== id) : [...saved.pinned, id] });
export const setDone = (id: string, done: boolean) => commit({ ...saved, done: { ...saved.done, [id]: done } });
export const markRead = (id: string) => {
  if (saved.unread.includes(id)) commit({ ...saved, unread: saved.unread.filter((x) => x !== id) });
};
const markUnread = (id: string) => {
  if (!saved.unread.includes(id)) commit({ ...saved, unread: [...saved.unread, id] });
};

export type LessonGroup = "pinned" | "active" | "recent" | "finished";

/** «Active»: the agent is working, or a test is waiting for the learner. */
export const isActive = (s: Session) => isBusy(s.agent) || hasOpenQuestion(s) || s.agent.kind === "waiting";
export const isFinished = (s: Session, marks: Saved) => marks.done[s.id] ?? s.finished;

export function groupOf(s: Session, marks: Saved): LessonGroup {
  if (marks.pinned.includes(s.id)) return "pinned";
  if (isFinished(s, marks) && !isActive(s)) return "finished";
  return isActive(s) ? "active" : "recent";
}

/** The lesson the learner is looking at: the lesson view with this lesson open (set by App via useTrackViewing). */
let viewing: string | null = null;
export function setViewing(id: string | null) {
  viewing = id;
  if (id) markRead(id);
}
export function useTrackViewing(view: string, activeId: string | null) {
  useEffect(() => setViewing(view === "lesson" ? activeId : null), [view, activeId]);
}

/** Watches the store: a lesson that finishes or asks something while it is not on screen becomes unread. Dead lessons are forgotten. */
const was = new Map<string, { busy: boolean; ask: boolean }>();
function track() {
  const st = getState();
  for (const s of Object.values(st.sessions)) {
    const now = { busy: isBusy(s.agent), ask: hasOpenQuestion(s) };
    const before = was.get(s.id);
    was.set(s.id, now);
    if (!before || s.id === viewing || !s.loaded) continue;
    const ended = before.busy && !now.busy && s.agent.kind !== "stopped" && s.agent.kind !== "error";
    if (ended || (!before.ask && now.ask)) markUnread(s.id);
  }
  const alive = (id: string) => id in st.sessions;
  if (Object.keys(st.sessions).length && (saved.pinned.some((x) => !alive(x)) || saved.unread.some((x) => !alive(x)) || Object.keys(saved.done).some((x) => !alive(x)))) {
    commit({ pinned: saved.pinned.filter(alive), unread: saved.unread.filter(alive), done: Object.fromEntries(Object.entries(saved.done).filter(([k]) => alive(k))) });
  }
}
subscribeStore(track);
track();
