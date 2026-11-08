/**
 * Folds the backend's event stream and lesson snapshots into the store.
 *
 * Order of work for a lesson that is opened while events are flowing: events for it are held back, the
 * snapshot is fetched, then held events newer than the snapshot are replayed. Text deltas are collected and
 * written once per animation frame, so a fast model costs one render per frame, not one per token.
 */
import { get, sessionPath, setConnection } from "./api";
import { bootstrap, getRemote, listSessions, refreshProviders, setRemote, type AgentSettings } from "./remote";
import { addUsage, parseSessionUsage } from "./usage";
import {
  appendBlock,
  getState,
  mergeListing,
  mergeSession,
  patchBlock,
  removeSession,
  sessionFromSummary,
  uid,
  upsertSession,
  NEW_TITLE,
} from "./store";
import type { AgentKind, Block, NoticeAction, Session } from "./types";
import { hasOpenQuestion } from "./types";
import { runErrorActions, runErrorTitle, setStalled } from "./run-errors";
import { openPresented } from "./presented";
import { normalizeMode } from "./mode-api";
import {
  actionFromCall,
  widgetFromCall,
  fileFromCall,
  HIDDEN_TOOLS,
  LESSON_TOOLS,
  questionBlock,
  recordBlocks,
  resultSummary,
  toolFailure,
  reasoningSeconds,
  transcriptBlocks,
  type SessionSummary,
  type Snapshot,
  type WireCall,
  type WireContext,
  type WireEvent,
  type WireLearning,
  type WireMessage,
  type WireQuestionBlock,
} from "./wire";

/* ------------------------------------------------------------------- per-lesson state */

interface Flags {
  busy: boolean;
  error: boolean;
  stopped: boolean;
  /** when each tool call and reasoning block began, to show how long they took */
  started: Map<string, number>;
  /** tool calls in flight that have no row in the transcript (call id → what to call them): the agent is busy with them */
  live: Map<string, string>;
}
const flags = new Map<string, Flags>();
const flagsOf = (id: string): Flags => {
  let f = flags.get(id);
  if (!f) flags.set(id, (f = { busy: false, error: false, stopped: false, started: new Map(), live: new Map() }));
  return f;
};

/** The newest event already reflected in a lesson's blocks. */
const seen = new Map<string, number>();
/** Events held back while a snapshot of the lesson is on its way. */
const held = new Map<string, WireEvent[]>();
const loading = new Map<string, Promise<void>>();

/* ---------------------------------------------------------------- streamed text batching */

const deltas = new Map<string, Map<string, { kind: "text" | "reasoning"; text: string }>>();
let frame = 0;

function queueDelta(id: string, blockId: string, kind: "text" | "reasoning", text: string) {
  let per = deltas.get(id);
  if (!per) deltas.set(id, (per = new Map()));
  const cur = per.get(blockId);
  if (cur) cur.text += text;
  else per.set(blockId, { kind, text });
  if (!frame) frame = requestAnimationFrame(() => ((frame = 0), [...deltas.keys()].forEach(flush)));
}

/** Writes the collected deltas of one lesson; every other event calls this first to keep the order. */
function flush(id: string) {
  const per = deltas.get(id);
  if (!per?.size) return;
  deltas.delete(id);
  const f = flagsOf(id);
  mergeSession(id, (s) => {
    let blocks = s.blocks;
    for (const [blockId, d] of per) {
      const i = blocks.findIndex((b) => b.id === blockId);
      if (blocks === s.blocks) blocks = blocks.slice();
      if (i >= 0) {
        const b = blocks[i];
        if (b.kind === "text" || b.kind === "reasoning") blocks[i] = { ...b, text: b.text + d.text };
      } else if (d.kind === "text") {
        blocks.push({ id: blockId, kind: "text", text: d.text, streaming: true, at: Date.now() });
      } else {
        f.started.set(blockId, Date.now());
        blocks.push({ id: blockId, kind: "reasoning", text: d.text, seconds: 0, streaming: true });
      }
    }
    return { ...s, blocks };
  });
}

/** Closes streaming text and reasoning rows (a reasoning row learns how long it ran). */
function settle(id: string) {
  const f = flagsOf(id);
  mergeSession(id, (s) => {
    if (!s.blocks.some((b) => (b.kind === "text" || b.kind === "reasoning") && b.streaming)) return s;
    return {
      ...s,
      blocks: s.blocks.map((b) => {
        if (b.kind === "text" && b.streaming) return { ...b, streaming: false };
        if (b.kind === "reasoning" && b.streaming) {
          const seconds = Math.max(1, Math.round((Date.now() - (f.started.get(b.id) ?? Date.now())) / 1000));
          return { ...b, streaming: false, seconds };
        }
        return b;
      }),
    };
  });
}

/* ------------------------------------------------------------------------ agent state */

const DEFAULT_LABEL: Partial<Record<AgentKind, string>> = {
  thinking: "Думает",
  writing: "Пишет ответ",
  evaluating: "Оценивает ответы",
  waiting: "Ждёт ваших ответов",
};

function agent(id: string, kind: AgentKind, label = DEFAULT_LABEL[kind] ?? "") {
  mergeSession(id, (s) =>
    s.agent.kind === kind && s.agent.label === label ? s : { ...s, agent: { kind, label, since: s.agent.kind === kind ? s.agent.since : Date.now() } },
  );
}

/**
 * Where the agent stands after an event closed something (a tool ended, an answer ended), taken from what is
 * still running rather than from the event itself: two tools may be in flight, and the end of one must not
 * claim the agent is only thinking. Nothing in flight means the model is reading results and thinking.
 */
function settleAgent(id: string) {
  const f = flagsOf(id);
  const s = getState().sessions[id];
  if (!f.busy || !s) return;
  const running = [...s.blocks].reverse().find((b) => b.kind === "action" && b.state === "running");
  if (running?.kind === "action") return agent(id, "tool", running.title);
  const silent = [...f.live.values()].pop();
  if (silent) return agent(id, "evaluating", silent);
  agent(id, "thinking");
}

const LESSON_LABEL: Record<string, string> = {
  set_learning_plan: "Составляет план",
  record_assessment: "Оценивает ответы",
  finish_lesson: "Подводит итог",
  visualize_read_me: "Готовит рисунок",
  show_widget: "Рисует",
  present_file: "Готовит файл",
};

/* ---------------------------------------------------------------------------- notices */

function notice(id: string, severity: "info" | "warn" | "error", title: string, detail: string | undefined, actions: NoticeAction[], saved?: string) {
  appendBlock(id, { id: uid("n"), kind: "notice", severity, title, detail, saved, actions });
}

const CONTINUE: NoticeAction = { id: "continue", label: "Продолжить" };

/* ------------------------------------------------------------------------ the reducer */

function applyLearning(id: string, learning: WireLearning | null) {
  if (!learning) return;
  mergeSession(id, (s) => ({
    ...s,
    finished: learning.finished,
    plan: learning.steps.length
      ? { goal: learning.goal, steps: learning.steps.map((x) => x.title), current: learning.finished ? learning.steps.length : Math.max(0, (learning.current_index ?? 1) - 1) }
      : undefined,
  }));
}

function onMessage(id: string, m: WireMessage) {
  const f = flagsOf(id);
  if (m.role === "user") {
    mergeSession(id, (s) => {
      if (s.blocks.some((b) => b.id === m.id)) return s;
      const block: Block = {
        id: m.id,
        kind: "user",
        text: m.content,
        attachments: (m.attachments ?? []).map((a, i) => ({ id: `${m.id}:a${i}`, name: a.name, kind: a.kind, size: a.size, path: a.path })),
        at: Date.now(),
      };
      const queued = s.queue.findIndex((q) => q.text === m.content);
      return {
        ...s,
        blocks: [...s.blocks, block],
        queue: queued >= 0 ? s.queue.filter((_, i) => i !== queued) : s.queue,
        turns: s.turns + 1,
        said: s.said + 1,
        title: s.title === NEW_TITLE ? m.content.replace(/\s+/g, " ").trim().slice(0, 65) || s.title : s.title,
        updatedAt: Date.now(),
      };
    });
    if (f.busy) agent(id, "thinking");
  } else if (m.role === "assistant") {
    if (f.busy) agent(id, "thinking");
  } else if (m.role === "tool") {
    // the backend times every tool; its figure replaces the one measured here
    if (m.ms != null) patchBlock(id, m.call_id, (b) => (b.kind === "action" ? { ...b, ms: m.ms ?? b.ms } : b));
    if (m.ui?.length)
      mergeSession(id, (s) => {
        const last = [...s.blocks].reverse().find((b) => b.kind === "plan");
        const track = last?.kind === "plan" ? { goal: last.goal, steps: last.steps, current: last.current ?? 0 } : null;
        const { blocks } = recordBlocks(m.id, m.ui ?? [], track);
        return { ...s, blocks: [...s.blocks, ...blocks.filter((b) => !s.blocks.some((x) => x.id === b.id))] };
      });
  }
}

/** The final assistant message: whatever streamed is replaced by the exact text, and a reply that was not streamed appears now. */
function onMessageEnd(id: string, m: WireMessage) {
  if (m.role !== "assistant") return;
  settle(id);
  const f = flagsOf(id);
  mergeSession(id, (s) => {
    let blocks = s.blocks;
    const write = (blockId: string, kind: "text" | "reasoning", text: string) => {
      if (!text.trim()) return;
      const i = blocks.findIndex((b) => b.id === blockId);
      if (blocks === s.blocks) blocks = blocks.slice();
      const seconds = reasoningSeconds(m.thinking_ms);
      if (i >= 0) {
        const b = blocks[i];
        if (b.kind === "reasoning") blocks[i] = { ...b, text, seconds: seconds || b.seconds };
        else if (b.kind === "text" && b.text !== text) blocks[i] = { ...b, text };
      } else if (kind === "text") blocks.push({ id: blockId, kind: "text", text, streaming: false, at: m.at ? m.at * 1000 : Date.now() });
      else blocks.push({ id: blockId, kind: "reasoning", text, seconds, streaming: false });
    };
    // reasoning precedes the answer, so write it first when both appear only now
    write(`${m.id}:r`, "reasoning", m.thinking);
    write(`${m.id}:t`, "text", m.content);
    return blocks === s.blocks ? s : { ...s, blocks };
  });
  f.started.delete(`${m.id}:r`);
  settleAgent(id);
}

function onToolStart(id: string, call: { id: string; name: string; arguments?: Record<string, unknown> }) {
  settle(id);
  const f = flagsOf(id);
  f.started.set(call.id, Date.now());
  const action = actionFromCall(call);
  if (!action || action.kind !== "action") {
    // a tool without a row (lesson tools, a tool this client does not know yet): name it from the call itself
    const label = LESSON_LABEL[call.name] ?? `Выполняет ${call.name.replace(/[_-]+/g, " ")}`;
    f.live.set(call.id, label);
    agent(id, "evaluating", label);
    return;
  }
  mergeSession(id, (s) => (s.blocks.some((b) => b.id === action.id) ? s : { ...s, blocks: [...s.blocks, action] }));
  agent(id, "tool", action.title);
}

function onToolEnd(id: string, call: WireCall, result: { content: string; error?: boolean }) {
  flagsOf(id).live.delete(call.id);
  if (LESSON_TOOLS.has(call.name)) return settleAgent(id);
  if (HIDDEN_TOOLS.has(call.name)) {
    const widget = result.error ? null : widgetFromCall(call) ?? fileFromCall(call, result.content);
    if (widget) mergeSession(id, (s) => (s.blocks.some((b) => b.id === widget.id) ? s : { ...s, blocks: [...s.blocks, widget] }));
    // a document handed over live opens beside the chat at once (a transcript loaded later only shows the card)
    if (widget?.kind === "file") openPresented(id, widget.id);
    return settleAgent(id);
  }
  const started = flagsOf(id).started.get(call.id);
  patchBlock(id, call.id, (b) => {
    if (b.kind !== "action") return b;
    const failed = !!result.error;
    return {
      ...b,
      state: failed ? "error" : "done",
      ms: started ? Date.now() - started : b.ms,
      output: failed ? toolFailure(result.content) : result.content,
      result: failed ? undefined : resultSummary(b.tool, result.content, false),
    };
  });
  settleAgent(id);
}

function onQuestionOpened(id: string, block: WireQuestionBlock) {
  settle(id);
  mergeSession(id, (s) => (s.blocks.some((b) => b.id === block.batch_id) ? s : { ...s, blocks: [...s.blocks, questionBlock(block, "open")] }));
  agent(id, "waiting");
}

function onNotice(id: string, text: string, error: boolean, code?: string, canRetry = false) {
  const f = flagsOf(id);
  if (!error && text.startsWith("Остановлено")) {
    f.stopped = true;
    notice(id, "info", "Остановлено", "Всё, что агент успел написать, сохранено.", [CONTINUE]);
    return;
  }
  if (error) {
    f.error = true;
    const empty = code === "empty" || /пустой ответ|только рассуждения/i.test(text);
    notice(
      id,
      "error",
      runErrorTitle(empty ? "empty" : code),
      text,
      runErrorActions(code, canRetry),
      "Ваши сообщения и ход занятия сохранены.",
    );
    setStalled(id, null);
  } else notice(id, "info", text, undefined, []);
}

function onBusy(id: string, busy: boolean, needsContinuation: boolean) {
  const f = flagsOf(id);
  if (!busy) setStalled(id, null);
  f.busy = busy;
  flush(id);
  f.live.clear();
  if (busy) {
    f.error = false;
    f.stopped = false;
    agent(id, "thinking");
    return;
  }
  settle(id);
  mergeSession(id, (s) => ({
    ...s,
    needsContinuation,
    blocks: s.blocks.map((b) => (b.kind === "action" && b.state === "running" ? { ...b, state: "error" as const, output: "Прервано" } : b)),
  }));
  const s = getState().sessions[id];
  if (s && hasOpenQuestion(s)) agent(id, "waiting");
  else if (f.stopped) agent(id, "stopped", "Остановлено");
  else if (f.error) agent(id, "error", "Ошибка");
  else agent(id, "idle", "");
}

function apply(id: string, e: WireEvent) {
  switch (e.type) {
    case "message":
      flush(id);
      return onMessage(id, e.message as WireMessage);
    case "message_end":
      flush(id);
      onMessageEnd(id, e.message as WireMessage);
      // the running total moves with every answer; the `usage` event after the turn settles it
      return (e.message as WireMessage).role === "assistant" && (e.message as { usage?: unknown }).usage
        ? mergeSession(id, (s) => ({ ...s, usage: addUsage(s.usage, (e.message as { usage?: unknown }).usage) }))
        : undefined;
    case "message_discarded":
      flush(id);
      return mergeSession(id, (s) => ({ ...s, blocks: s.blocks.filter((b) => b.id !== `${e.message_id}:r` && b.id !== `${e.message_id}:t`) }));
    case "text_delta":
    case "thinking_delta": {
      const kind = e.type === "text_delta" ? "text" : "reasoning";
      queueDelta(id, `${e.message_id}:${kind === "text" ? "t" : "r"}`, kind, String(e.delta ?? ""));
      if (kind === "text") agent(id, "writing");
      else agent(id, "thinking");
      return;
    }
    case "tool_start":
      flush(id);
      return onToolStart(id, e.call as never);
    case "tool_update":
      return patchBlock(id, String(e.call_id), (b) => (b.kind === "action" ? { ...b, output: ((b.output ?? "") + String(e.text ?? "")).slice(-8000) } : b));
    case "tool_end":
      flush(id);
      return onToolEnd(id, e.call as never, e.result as never);
    case "question_opened":
      flush(id);
      return onQuestionOpened(id, e.block as WireQuestionBlock);
    case "question_resolved":
      return patchBlock(id, String(e.batch_id), (b) =>
        b.kind === "question" ? { ...b, state: e.status === "cancelled" ? "cancelled" : "submitted", submittedAt: Date.now(), view: "review" } : b,
      );
    case "learning":
      return applyLearning(id, e.learning as WireLearning | null);
    case "context": {
      const c = e.context as WireContext;
      return mergeSession(id, (s) => ({ ...s, context: { used: c.used, limit: c.limit } }));
    }
    case "usage":
      return mergeSession(id, (s) => ({ ...s, usage: parseSessionUsage(e.usage) ?? s.usage }));
    case "status": {
      const text = String(e.text ?? "");
      const s = getState().sessions[id];
      if (s && flagsOf(id).busy && text) agent(id, s.agent.kind === "idle" ? "thinking" : s.agent.kind, text);
      return;
    }
    case "notice":
      flush(id);
      return onNotice(id, String(e.text ?? ""), !!e.error, typeof e.code === "string" ? e.code : undefined, !!e.can_retry);
    case "stalled":
      return e.aborted ? setStalled(id, null) : setStalled(id, { phase: e.phase === "tool" ? "tool" : "model", seconds: Number(e.seconds) || 0 });
    case "stall_cleared":
      return setStalled(id, null);
    case "busy":
      return onBusy(id, !!e.busy, !!e.needs_continuation);
    case "queued":
      return mergeSession(id, (s) => ({ ...s, queue: [...s.queue, { text: String(e.text ?? ""), followup: !!e.followup }] }));
    case "queue_restored":
      return mergeSession(id, (s) => ({ ...s, queue: [], draft: [String(e.text ?? ""), s.draft].filter(Boolean).join("\n\n") }));
    case "session_updated": {
      const summary = e.session as SessionSummary;
      return mergeSession(id, (s) => ({ ...s, title: summary.name || s.title, model: summary.model ?? s.model, thinking: summary.thinking ?? s.thinking, quality: (summary as any).quality ?? (s as any).quality, explanationStyle: summary.explanation_style ?? s.explanationStyle, mode: summary.mode ? normalizeMode(summary.mode) : s.mode, quizKind: summary.quiz_kind ?? s.quizKind, deadline: summary.deadline === undefined ? s.deadline : summary.deadline }));
    }
  }
}

function onEvent(e: WireEvent) {
  switch (e.type) {
    case "lagged":
      return void resync();
    case "providers_changed":
      return void refreshProviders().catch(() => undefined);
    case "settings_changed":
      return void get<AgentSettings>("/settings").then((settings) => setRemote({ settings }), () => undefined);
    case "session_deleted":
      return removeSession(String(e.session_id));
    case "login":
      return onLogin(e);
    case "session_created": {
      const summary = e.session as SessionSummary;
      if (!getState().sessions[summary.id]) mergeListing([summary]);
      return;
    }
  }
  const id = e.session_id;
  if (!id || !getState().sessions[id]) return;
  const queue = held.get(id);
  if (queue) return void queue.push(e);
  if (!getState().sessions[id].loaded) return;
  if (e.seq <= (seen.get(id) ?? 0)) return;
  seen.set(id, e.seq);
  apply(id, e);
}

function onLogin(e: WireEvent) {
  const state = e.state as NonNullable<ReturnType<typeof getRemote>["login"]>["state"];
  const prev = getRemote().login;
  if (state === "done") {
    setRemote({ login: null });
    void refreshProviders().catch(() => undefined);
    return;
  }
  if (state === "cancelled") return setRemote({ login: null });
  setRemote({
    login: {
      flowId: String(e.flow_id),
      state,
      url: (e.url as string | undefined) ?? prev?.url,
      userCode: (e.user_code as string | undefined) ?? prev?.userCode,
      prompt: state === "waiting_input" ? (e.prompt as string | undefined) : undefined,
      message: state === "error" || e.message ? (e.message as string | undefined) : prev?.message,
    },
  });
}

/* ------------------------------------------------------------------------- snapshots */

/** Builds the lesson from a snapshot, keeping interface-only state (draft, chips) of the existing copy. */
export function applySnapshot(snapshot: Snapshot) {
  const existing = getState().sessions[snapshot.id];
  const base: Session = existing ?? sessionFromSummary(snapshot);
  const blocks = transcriptBlocks(snapshot);
  const f = flagsOf(snapshot.id);
  f.busy = !!snapshot.busy;
  f.live.clear();
  f.error = false;
  f.stopped = false;
  const waiting = snapshot.question !== null;
  if (snapshot.needs_continuation && !snapshot.busy && !waiting) {
    blocks.push({
      id: "resume",
      kind: "notice",
      severity: "info",
      title: "Ход занятия прерван",
      detail: "Ответы и история сохранены. Можно продолжить с того же места.",
      actions: [CONTINUE],
    });
  }
  const learning = snapshot.learning;
  const next: Session = {
    ...base,
    title: snapshot.name || base.title,
    blocks,
    loaded: true,
    said: snapshot.said,
    turns: snapshot.said,
    model: snapshot.model ?? base.model,
    thinking: snapshot.thinking ?? base.thinking,
    explanationStyle: snapshot.explanation_style ?? base.explanationStyle,
    mode: snapshot.mode ? normalizeMode(snapshot.mode) : base.mode,
    quizKind: snapshot.quiz_kind ?? base.quizKind,
    deadline: snapshot.deadline === undefined ? base.deadline : snapshot.deadline,
    finished: learning?.finished ?? false,
    plan: learning?.steps.length
      ? { goal: learning.goal, steps: learning.steps.map((x) => x.title), current: learning.finished ? learning.steps.length : Math.max(0, (learning.current_index ?? 1) - 1) }
      : undefined,
    context: { used: snapshot.context.used, limit: snapshot.context.limit },
    usage: parseSessionUsage(snapshot.usage),
    needsContinuation: snapshot.needs_continuation,
    agent: {
      kind: snapshot.busy ? "thinking" : waiting ? "waiting" : "idle",
      label: snapshot.busy ? DEFAULT_LABEL.thinking! : waiting ? DEFAULT_LABEL.waiting! : "",
      since: Date.now(),
    },
    queue: existing?.queue ?? [],
  };
  seen.set(snapshot.id, snapshot.seq);
  upsertSession(existing ? { ...next, updatedAt: existing.updatedAt } : next);
}

/** Fetches the lesson once at a time; events that arrive meanwhile are replayed after it. */
export function loadSession(id: string): Promise<void> {
  const running = loading.get(id);
  if (running) return running;
  held.set(id, []);
  const job = (async () => {
    try {
      const snapshot = await get<Snapshot>(sessionPath(id));
      applySnapshot(snapshot);
    } finally {
      const queue = held.get(id) ?? [];
      held.delete(id);
      loading.delete(id);
      for (const e of queue) if (e.seq > (seen.get(id) ?? 0)) onEvent(e);
    }
  })();
  loading.set(id, job);
  return job;
}

/* ------------------------------------------------------------------------ the stream */

let source: EventSource | null = null;
let connected = "";
let lost = false;

async function loadAll() {
  await bootstrap();
  mergeListing(await listSessions());
  await Promise.all(Object.values(getState().sessions).filter((s) => s.loaded).map((s) => loadSession(s.id).catch(() => undefined)));
}

/** After a break in the stream everything may have changed: load it all again. */
export async function resync() {
  try {
    await loadAll();
  } catch {
    /* the stream's own reconnection will try again */
  }
}

export function startSync(url: string, token: string) {
  if (connected === url + token) return;
  stopSync();
  connected = url + token;
  setConnection(url, token);
  const stream = new EventSource(`${url}/api/v1/events?token=${encodeURIComponent(token)}`);
  source = stream;
  stream.onopen = () => {
    setRemote({ online: true });
    if (lost || !getRemote().loaded) void resync();
    lost = false;
  };
  stream.onerror = () => {
    lost = true;
    setRemote({ online: false });
  };
  stream.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as WireEvent);
    } catch (error) {
      console.error("Unreadable event", error);
    }
  };
}

export function stopSync() {
  source?.close();
  source = null;
  connected = "";
  setRemote({ online: false });
}
