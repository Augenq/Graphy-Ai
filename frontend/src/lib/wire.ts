/**
 * The shapes the agent backend sends (backend/docs/protocol.md) and their translation into the
 * blocks the interface draws. Everything here is pure: the same functions rebuild a saved lesson and fold
 * live events, so both end up identical.
 */
import { presentedFromResult } from "./presented";
import { plural } from "./i18n";
import {
  blankAnswer,
  type AnswerDraft,
  type Block,
  type Outcome,
  type Phase,
  type Question,
  type QuestionType,
  type ToolName,
} from "./types";

/* ----------------------------------------------------------------- wire types */

export interface WireCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  argument_error?: string;
}

export interface WireAttachment {
  name: string;
  path: string;
  kind: "file" | "image";
  size?: number;
}

export interface WireAssessment {
  id: string;
  question: string;
  outcome: Outcome;
  feedback: string;
  used_hints: boolean;
}

export type UiRecord =
  | { kind: "plan"; goal: string; steps: string[] }
  | { kind: "phase"; phase: Phase; step: number | null }
  | { kind: "assessment"; items: WireAssessment[] }
  | { kind: "finished"; summary: string; next_step: string };

interface WireBase {
  id: string;
  at?: number;
}
export type WireMessage =
  | (WireBase & { role: "user"; content: string; attachments?: WireAttachment[]; images?: number })
  | (WireBase & {
      role: "assistant";
      content: string;
      thinking: string;
  quality?: "fast"|"balanced"|"deep";
      calls: WireCall[];
      stop: string;
      provider?: string;
      model?: string;
      /** how long the reasoning ran, in ms */
      thinking_ms?: number;
    })
  | (WireBase & { role: "tool"; call_id: string; name: string; content: string; error?: boolean; ui?: UiRecord[]; ms?: number });

export interface WireOption {
  id: string;
  label: string;
}
export interface WireQuestion {
  id: string;
  type: QuestionType;
  prompt: string;
  options?: WireOption[];
  allow_custom_answer?: boolean;
}
export interface WireAnswer {
  question_id: string;
  status: "answered" | "skipped" | "dont_know" | "draft";
  selected_option_ids: string[];
  text: string;
  reasoning: string;
}
export interface WireQuestionBlock {
  batch_id: string;
  title: string;
  questions: WireQuestion[];
  answers: WireAnswer[];
  step: number;
}

export interface WireLearning {
  goal: string;
  phase: Phase;
  steps: { id: string; title: string }[];
  current_index: number | null;
  finished: boolean;
  summary: string;
  next_step: string;
}

export interface WireContext {
  used: number;
  limit: number;
  percent: number;
}

export interface SessionSummary {
  id: string;
  name: string;
  created?: number;
  modified?: number;
  said: number;
  busy?: boolean;
  model?: string;
  thinking?: string;
  quality?: "fast"|"balanced"|"deep";
  explanation_style?: import("./styles").ExplanationStyle;
  mode?: import("./mode-api").SessionMode;
  quiz_kind?: import("./mode-api").QuizKind;
  deadline?: number | null;
}

export interface Snapshot extends SessionSummary {
  seq: number;
  messages: WireMessage[];
  learning: WireLearning | null;
  question: WireQuestionBlock | null;
  resolved_questions: Record<string, { block: WireQuestionBlock; status: "submitted" | "cancelled"; answers: WireAnswer[] }>;
  context: WireContext;
  usage?: unknown;
  needs_continuation: boolean;
  warning: string;
  queued: number;
}

/** One event of the stream. `session_id` is absent on global events. */
export interface WireEvent {
  seq: number;
  type: string;
  session_id?: string;
  [field: string]: unknown;
}

/* ----------------------------------------------------------------------- tools */

export const LESSON_TOOLS = new Set(["set_learning_plan", "record_assessment", "finish_lesson"]);

/** Tools whose result is a picture or a silent setup step rather than a row in the transcript. */
export const WIDGET_TOOL = "show_widget";
export const PRESENT_TOOL = "present_file";
export const HIDDEN_TOOLS = new Set([WIDGET_TOOL, "visualize_read_me", PRESENT_TOOL]);

const TOOL_OF: Record<string, ToolName> = {
  read: "read",
  bash: "bash",
  web_search: "web_search",
  web_read: "web_read",
  load_skill: "skill",
  spawn_researcher: "researcher",
};

const str = (value: unknown) => (typeof value === "string" ? value : "");
const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** The row for a tool call; lessons tools and the question form have their own blocks instead. */
export function actionFromCall(call: WireCall, state: "running" | "done" | "error" = "running"): Block | null {
  const tool = TOOL_OF[call.name];
  if (!tool) return null;
  const args = call.arguments ?? {};
  const detail =
    tool === "read" ? str(args.path) : tool === "bash" ? str(args.command) : tool === "web_search" ? str(args.query) : tool === "web_read" ? str(args.url) : tool === "researcher" ? str(args.question) : str(args.name);
  const subject = tool === "read" ? baseName(detail) : detail;
  return { id: call.id, kind: "action", tool, title: subject || call.name, detail: detail || undefined, state, ms: 0 };
}

/** The picture for a successful show_widget call; a failed call draws nothing (the agent repairs it and calls again). */
export function widgetFromCall(call: WireCall): Block | null {
  const code = str(call.arguments?.widget_code);
  if (call.name !== WIDGET_TOOL || !code.trim()) return null;
  return { id: call.id, kind: "widget", title: str(call.arguments?.title).replace(/_/g, " ") || "widget", code };
}

/** The card for a successful present_file call; a failed call draws nothing (the agent fixes the path and calls again). */
export function fileFromCall(call: WireCall, content: string): Block | null {
  if (call.name !== PRESENT_TOOL) return null;
  const file = presentedFromResult(call.id, content);
  return file ? { id: call.id, kind: "file", file } : null;
}

/** What the row says next to the verb, drawn from the raw result. */
export function resultSummary(tool: ToolName, content: string, failed: boolean): string | undefined {
  if (failed) return undefined;
  try {
    const data = JSON.parse(content);
    if (tool === "web_search" && Array.isArray(data?.results)) return `${data.results.length} ${plural(data.results.length, "результат", "результата", "результатов")}`;
    if (tool === "researcher" && Array.isArray(data?.sources)) return `${data.sources.length} ${plural(data.sources.length, "источник", "источника", "источников")}`;
    if (tool === "web_read" && data) return typeof data.title === "string" && data.title ? data.title : undefined;
  } catch {
    /* plain text */
  }
  if (tool === "read") {
    const lines = content.split("\n").length;
    return `${lines} ${plural(lines, "строка", "строки", "строк")}`;
  }
  return undefined;
}

export function toolFailure(content: string) {
  try {
    const data = JSON.parse(content);
    if (data && typeof data.message === "string") return data.message;
  } catch {
    /* plain text */
  }
  return content;
}

/* ------------------------------------------------------------------ lesson records */

/** The plan as the transcript last drew it: the base for noticing that more steps are finished. */
export type PlanTrack = { goal: string; steps: string[]; current: number } | null;

/**
 * The plan a tool message carries, as a block. Every time steps get finished (a phase change that moves on in
 * the plan, or the end of the lesson) the plan is drawn again with those steps ticked, so the transcript keeps
 * each stage of progress. Assessments update the progress ruler (lib/sync.ts) but are not drawn: the agent says
 * what was right or wrong in its own answer.
 */
export function recordBlocks(messageId: string, records: UiRecord[], track: PlanTrack): { blocks: Block[]; track: PlanTrack } {
  const blocks: Block[] = [];
  let plan = track;
  const draw = (next: NonNullable<PlanTrack>, i: number) => {
    plan = next;
    blocks.push({ id: `${messageId}:ui${i}`, kind: "plan", goal: next.goal, steps: next.steps, current: next.current });
  };
  records.forEach((record, i) => {
    if (record.kind === "plan") draw({ goal: record.goal, steps: record.steps, current: 0 }, i);
    else if (plan && record.kind === "phase" && record.step != null) {
      const current = Math.min(record.step - 1, plan.steps.length);
      if (current > plan.current) draw({ ...plan, current }, i);
    } else if (plan && record.kind === "finished" && plan.current < plan.steps.length) draw({ ...plan, current: plan.steps.length }, i);
  });
  return { blocks, track: plan };
}

/* ---------------------------------------------------------------------- questions */

export function toQuestion(q: WireQuestion): Question {
  return {
    id: q.id,
    prompt: q.prompt,
    type: q.type,
    ...(q.options ? { options: q.options.map((o) => o.label), optionIds: q.options.map((o) => o.id) } : {}),
  };
}

/** Wire answer -> what the form edits. A typed answer on a choice question is the «own answer». */
export function answerFromWire(q: Question, a: WireAnswer | undefined): AnswerDraft {
  const draft = blankAnswer();
  if (!a) return draft;
  draft.reasoning = a.reasoning;
  if (a.status === "dont_know" || a.status === "skipped") return { ...draft, mark: a.status };
  if (q.type === "free_text") return { ...draft, text: a.text };
  if (a.text) return { ...draft, useCustom: true, custom: a.text };
  const ids = q.optionIds ?? [];
  return { ...draft, choices: a.selected_option_ids.map((id) => ids.indexOf(id)).filter((i) => i >= 0) };
}

/** Form answer -> wire answer. Anything not yet filled is a draft; the backend refuses to submit drafts. */
export function answerToWire(q: Question, a: AnswerDraft | undefined): WireAnswer {
  const base = { question_id: q.id, reasoning: a?.reasoning ?? "" };
  if (!a) return { ...base, status: "draft", selected_option_ids: [], text: "" };
  if (a.mark) return { ...base, status: a.mark, selected_option_ids: [], text: "", reasoning: a.reasoning };
  if (q.type === "free_text") {
    const text = a.text.trim() ? a.text : "";
    return { ...base, status: text ? "answered" : "draft", selected_option_ids: [], text };
  }
  if (a.useCustom) {
    const text = a.custom.trim() ? a.custom : "";
    return { ...base, status: text ? "answered" : "draft", selected_option_ids: [], text };
  }
  const ids = q.optionIds ?? [];
  const selected = a.choices.map((i) => ids[i]).filter(Boolean);
  return { ...base, status: selected.length ? "answered" : "draft", selected_option_ids: selected, text: "" };
}

export function questionBlock(
  wire: WireQuestionBlock,
  state: "open" | "submitted" | "cancelled",
  answers: WireAnswer[] = wire.answers,
): Extract<Block, { kind: "question" }> {
  const questions = wire.questions.map(toQuestion);
  return {
    id: wire.batch_id,
    kind: "question",
    title: wire.title,
    questions,
    answers: Object.fromEntries(questions.map((q) => [q.id, answerFromWire(q, answers.find((a) => a.question_id === q.id))])),
    step: Math.min(Math.max(0, wire.step), Math.max(0, questions.length - 1)),
    view: wire.step >= questions.length && state === "open" ? "review" : "step",
    state,
  };
}

/* --------------------------------------------------------------------- transcript */

const emptyReply = (m: WireMessage) =>
  m.role === "assistant" && m.stop === "empty" && !m.content.trim() && !m.thinking.trim() && m.calls.length === 0;

/** Whole seconds of reasoning; nothing is shown for a thought that took no measurable time. */
export const reasoningSeconds = (ms?: number) => (ms ? Math.round(ms / 1000) : 0);

/**
 * Blocks of a saved lesson, in the order they were produced: a message, then what its tool calls did.
 * Rows of failed or finished tools take their state from the matching result message.
 */
export function transcriptBlocks(snapshot: Snapshot): Block[] {
  const blocks: Block[] = [];
  const results = new Map<string, Extract<WireMessage, { role: "tool" }>>();
  for (const m of snapshot.messages) if (m.role === "tool") results.set(m.call_id, m);
  const pending = snapshot.question;

  let track: PlanTrack = null;
  for (const m of snapshot.messages) {
    if (emptyReply(m)) continue;
    if (m.role === "user") {
      blocks.push({
        id: m.id,
        kind: "user",
        text: m.content,
        attachments: (m.attachments ?? []).map((a, i) => ({ id: `${m.id}:a${i}`, name: a.name, kind: a.kind, size: a.size })),
        at: (m.at ?? 0) * 1000,
      });
    } else if (m.role === "assistant") {
      if (m.thinking.trim()) blocks.push({ id: `${m.id}:r`, kind: "reasoning", text: m.thinking, seconds: reasoningSeconds(m.thinking_ms), streaming: false });
      if (m.content.trim()) blocks.push({ id: `${m.id}:t`, kind: "text", text: m.content, streaming: false, at: m.at ? m.at * 1000 : undefined });
      for (const call of m.calls) {
        if (call.name === "ask_questions") {
          const resolved = snapshot.resolved_questions[call.id];
          if (resolved) blocks.push(questionBlock(resolved.block, resolved.status, resolved.answers));
          else if (pending && pending.batch_id === call.id) blocks.push(questionBlock(pending, "open"));
          continue;
        }
        const result = results.get(call.id);
        if (call.name === PRESENT_TOOL) {
          const card = result && !result.error ? fileFromCall(call, result.content) : null;
          if (card) blocks.push(card);
          continue;
        }
        if (call.name === WIDGET_TOOL) {
          const widget = result && !result.error ? widgetFromCall(call) : null;
          if (widget) blocks.push(widget);
          continue;
        }
        const action = actionFromCall(call, result ? (result.error ? "error" : "done") : "error");
        if (!action || action.kind !== "action") continue;
        if (result) {
          action.ms = result.ms ?? 0;
          if (result.error) action.output = toolFailure(result.content);
          else {
            action.output = result.content;
            action.result = resultSummary(action.tool, result.content, false);
          }
        } else action.output = "Прервано";
        blocks.push(action);
      }
    } else if (m.role === "tool" && m.ui) {
      const drawn = recordBlocks(m.id, m.ui, track);
      track = drawn.track;
      blocks.push(...drawn.blocks);
    }
  }
  return blocks;
}
