import { useRef, useSyncExternalStore } from "react";
import type { AgentKind, Block, Session } from "./types";
import type { SessionSummary } from "./wire";
import { normalizeMode } from "./mode-api";

/**
 * Lessons as the interface shows them. The backend owns the history; this store holds what was loaded
 * from it plus the live stream, and keeps per-lesson interface state (composer draft, scroll position)
 * in localStorage so switching lessons or restarting never loses it.
 */
export interface State {
  sessions: Record<string, Session>;
  order: string[];
  activeId: string | null;
  scroll: Record<string, number>;
}

const KEY = "graphy-material-ui-v2";

interface UiState {
  drafts: Record<string, string>;
  scroll: Record<string, number>;
}

function loadUi(): UiState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UiState>;
      return { drafts: parsed.drafts ?? {}, scroll: parsed.scroll ?? {} };
    }
  } catch {
    /* storage unavailable or corrupt: start clean */
  }
  return { drafts: {}, scroll: {} };
}

const ui = loadUi();

export const uid = (p = "b") => `${p}${Math.random().toString(36).slice(2, 9)}`;

let state: State = { sessions: {}, order: [], activeId: null, scroll: ui.scroll };
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const drafts: Record<string, string> = {};
    for (const s of Object.values(state.sessions)) if (s.draft) drafts[s.id] = s.draft;
    try {
      localStorage.setItem(KEY, JSON.stringify({ drafts, scroll: state.scroll } satisfies UiState));
    } catch {
      /* quota or unavailable: the app keeps working in memory */
    }
  }, 400);
}

function set(next: State) {
  state = next;
  listeners.forEach((l) => l());
  persist();
}

export const getState = () => state;
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const subscribeStore = subscribe;

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

/** Like useStore, for selectors that build a new value on each call: the previous result is kept while `equal` says nothing changed, so a stream flush that does not touch it renders nothing. */
export function useStoreStable<T>(select: (s: State) => T, equal: (a: T, b: T) => boolean): T {
  const last = useRef<{ v: T } | null>(null);
  return useSyncExternalStore(subscribe, () => {
    const next = select(state);
    if (last.current && equal(last.current.v, next)) return last.current.v;
    last.current = { v: next };
    return next;
  });
}

export const useSession = (id: string | null) => useStore((s) => (id ? s.sessions[id] : undefined));

/* ---------------------------------------------------------------- sessions */

export const NEW_TITLE = "Новое занятие";

export function sessionFromSummary(s: SessionSummary): Session {
  const created = (s.created ?? s.modified ?? Date.now() / 1000) * 1000;
  return {
    id: s.id,
    title: s.name || NEW_TITLE,
    createdAt: created,
    updatedAt: (s.modified ?? s.created ?? Date.now() / 1000) * 1000,
    finished: false,
    blocks: [],
    agent: { kind: "idle", label: "", since: Date.now() },
    draft: ui.drafts[s.id] ?? "",
    chips: [],
    queue: [],
    objects: [],
    turns: s.said,
    said: s.said,
    loaded: false,
    model: s.model ?? "",
    thinking: s.thinking ?? "off",
    explanationStyle: s.explanation_style ?? "structured_reference",
    mode: normalizeMode(s.mode),
    quizKind: s.quiz_kind ?? "check",
    deadline: s.deadline ?? null,
    needsContinuation: false,
  };
}

const byRecency = (sessions: Record<string, Session>) =>
  Object.values(sessions)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((s) => s.id);

/** Replaces a session wholesale (a fresh snapshot) or adds it. */
export function upsertSession(session: Session) {
  const sessions = { ...state.sessions, [session.id]: session };
  set({ ...state, sessions, order: byRecency(sessions) });
}

/** Merges the lesson list from the backend: known lessons keep their blocks, unknown ones appear. */
export function mergeListing(summaries: SessionSummary[]) {
  const sessions = { ...state.sessions };
  for (const s of summaries) {
    const known = sessions[s.id];
    if (!known) sessions[s.id] = sessionFromSummary(s);
    else if (!known.loaded)
      sessions[s.id] = { ...known, title: s.name || known.title, said: s.said, turns: s.said, updatedAt: (s.modified ?? 0) * 1000 || known.updatedAt };
  }
  set({ ...state, sessions, order: byRecency(sessions) });
}

/** Local interface change: counts as activity, so the lesson moves to the top of the list. */
export function patchSession(id: string, fn: (s: Session) => Session) {
  const cur = state.sessions[id];
  if (!cur) return;
  const next = fn(cur);
  if (next === cur) return;
  set({ ...state, sessions: { ...state.sessions, [id]: { ...next, updatedAt: Date.now() } } });
}

/** Data arriving from the backend: reflects activity that already has a time, never bumps it by itself. */
export function mergeSession(id: string, fn: (s: Session) => Session) {
  const cur = state.sessions[id];
  if (!cur) return;
  const next = fn(cur);
  if (next === cur) return;
  set({ ...state, sessions: { ...state.sessions, [id]: next } });
}

export function setActive(id: string | null) {
  if (state.activeId === id) return;
  set({ ...state, activeId: id });
}

export function removeSession(id: string) {
  const { [id]: _gone, ...sessions } = state.sessions;
  set({ ...state, sessions, order: state.order.filter((x) => x !== id), activeId: state.activeId === id ? null : state.activeId });
}

export function renameSession(id: string, title: string) {
  mergeSession(id, (s) => ({ ...s, title }));
}

export function appendBlock(id: string, block: Block) {
  mergeSession(id, (s) => ({ ...s, blocks: [...s.blocks, block] }));
}

export function patchBlock(id: string, blockId: string, fn: (b: Block) => Block) {
  mergeSession(id, (s) => {
    const i = s.blocks.findIndex((b) => b.id === blockId);
    if (i < 0) return s;
    const blocks = s.blocks.slice();
    blocks[i] = fn(blocks[i]);
    return { ...s, blocks };
  });
}

export function setAgent(id: string, kind: AgentKind, label = "") {
  mergeSession(id, (s) => (s.agent.kind === kind && s.agent.label === label ? s : { ...s, agent: { kind, label, since: s.agent.kind === kind ? s.agent.since : Date.now() } }));
}

export function saveScroll(id: string, top: number) {
  // scroll position is not worth a re-render: write through without notifying
  state = { ...state, scroll: { ...state.scroll, [id]: top } };
  persist();
}

/** Forget interface-only state (drafts, scroll). The lessons themselves live in the backend. */
export function resetInterfaceState() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  const sessions = Object.fromEntries(Object.entries(state.sessions).map(([id, s]) => [id, { ...s, draft: "" }]));
  set({ ...state, sessions, scroll: {} });
}
