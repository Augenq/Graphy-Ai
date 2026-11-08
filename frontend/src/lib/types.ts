import type { PresentedFile } from "./presented";
/**
 * Client-side model of a lesson. The agent backend streams wire events (see lib/wire.ts and
 * backend/docs/protocol.md); lib/sync.ts folds them into these blocks, and the same code rebuilds
 * the blocks of a saved lesson, so a reopened lesson looks like the live one.
 */

export type Phase = "diagnosis" | "planning" | "teaching" | "practice" | "review";

export type Outcome = "independent" | "with_hints" | "gap" | "uncertain" | "skipped";
export const OUTCOME_LABELS: Record<Outcome, string> = {
  independent: "Самостоятельно",
  with_hints: "С подсказкой",
  gap: "Пробел",
  uncertain: "Не уверен",
  skipped: "Пропущено",
};

export type QuestionType = "free_text" | "single_choice" | "multiple_choice";

/** Questions never carry the answer key: it stays with the agent until the learner submits. */
export interface Question {
  id: string;
  prompt: string;
  type: QuestionType;
  options?: string[];
  /** backend ids of `options`, same order: answers travel by id, the form works with positions */
  optionIds?: string[];
}

export interface AnswerDraft {
  choices: number[];
  /** "Свой ответ" instead of the offered options */
  useCustom: boolean;
  custom: string;
  text: string;
  reasoning: string;
  mark: null | "dont_know" | "skipped";
}

export const blankAnswer = (): AnswerDraft => ({
  choices: [],
  useCustom: false,
  custom: "",
  text: "",
  reasoning: "",
  mark: null,
});

export type AnswerState = "answered" | "dont_know" | "skipped" | "empty";

export function answerState(q: Question, a: AnswerDraft | undefined): AnswerState {
  if (!a) return "empty";
  if (a.mark === "dont_know") return "dont_know";
  if (a.mark === "skipped") return "skipped";
  if (q.type === "free_text") return a.text.trim() ? "answered" : "empty";
  if (a.useCustom) return a.custom.trim() ? "answered" : "empty";
  return a.choices.length ? "answered" : "empty";
}

export interface Attachment {
  id: string;
  name: string;
  kind: "file" | "image" | "course" | "folder";
  size?: number;
  /** text appended to the message (a folder listing); data, not instructions */
  context?: string;
  /** absolute path on this computer: the agent reads attachments from disk */
  path?: string;
}

export type ToolName = "read" | "bash" | "web_search" | "web_read" | "skill" | "researcher";

export type Block =
  | { id: string; kind: "user"; text: string; attachments: Attachment[]; at: number }
  | { id: string; kind: "text"; text: string; streaming: boolean; /** ms since epoch: when the answer arrived (the wire message time, or now for a live one) */ at?: number }
  | { id: string; kind: "reasoning"; text: string; seconds: number; streaming: boolean }
  | {
      id: string;
      kind: "action";
      tool: ToolName;
      title: string;
      detail?: string;
      /** full tool output, shown when the row is expanded */
      output?: string;
      /** one short phrase for the row itself, «214 строк» */
      result?: string;
      state: "running" | "done" | "error";
      ms: number;
    }
  | { id: string; kind: "widget"; title: string; code: string }
  /** a document the agent presented with present_file: a card in the chat, the file itself in the side panel */
  | { id: string; kind: "file"; file: PresentedFile }
  /** the agent offers a new lesson; it exists only after the learner clicks */
  | { id: string; kind: "plan"; goal: string; steps: string[]; /** steps finished when the plan was drawn */ current: number }
  | { id: string; kind: "object"; objectId: string; title: string; objectKind: ResultKind }
  | {
      id: string;
      kind: "question";
      title: string;
      questions: Question[];
      answers: Record<string, AnswerDraft>;
      step: number;
      view: "step" | "review";
      state: "open" | "collapsed" | "submitted" | "cancelled";
      savedAt?: number;
      submittedAt?: number;
      warn?: string;
    }
  | {
      id: string;
      kind: "notice";
      severity: "info" | "warn" | "error";
      title: string;
      detail?: string;
      saved?: string;
      actions: NoticeAction[];
    };

export interface NoticeAction {
  id: "continue" | "retry" | "edit" | "continue_without" | "choose_model" | "dismiss" | "open_settings";
  label: string;
}

export type ResultKind = "notes" | "solution" | "cards";
export const RESULT_LABELS: Record<ResultKind, string> = {
  notes: "Конспект",
  solution: "Решение",
  cards: "Карточки",
};

export interface ResultObject {
  id: string;
  kind: ResultKind;
  title: string;
  markdown: string;
  /** block that created it, for «К ходу» */
  blockId: string;
  turn: number;
}

export type AgentKind =
  | "idle"
  | "thinking"
  | "tool"
  | "writing"
  | "evaluating"
  | "waiting"
  | "stopped"
  | "error";

export interface AgentState {
  kind: AgentKind;
  label: string;
  since: number;
}

export interface Plan {
  goal: string;
  steps: string[];
  current: number;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  finished: boolean;
  plan?: Plan;
  blocks: Block[];
  agent: AgentState;
  draft: string;
  chips: Attachment[];
  queue: { text: string; followup: boolean }[];
  objects: ResultObject[];
  /** share of the context window in use, reported by the backend */
  context?: { used: number; limit: number };
  /** tokens and cost of this lesson so far (tokens in/out/cache, cost when known) */
  usage?: import("./usage").SessionUsage;
  turns: number;
  /** user messages the backend knows of: a lesson in the list has no blocks until it is opened */
  said: number;
  /** blocks were built from the backend (false for a lesson that is only listed) */
  loaded: boolean;
  /** "provider/model-id" and reasoning level of this lesson */
  model: string;
  thinking: string;
  quality?: "fast"|"balanced"|"deep";
  explanationStyle: import("./styles").ExplanationStyle;
  /** explain (default), quiz or materials; a quiz has a kind and an optional deadline in epoch seconds */
  mode?: import("./mode-api").SessionMode;
  quizKind?: import("./mode-api").QuizKind;
  deadline?: number | null;
  /** the last turn was cut short; the learner can ask to continue */
  needsContinuation: boolean;
}

export const isBusy = (a: AgentState) =>
  a.kind === "thinking" || a.kind === "tool" || a.kind === "writing" || a.kind === "evaluating";

export function hasOpenQuestion(s: Session) {
  return s.blocks.some((b) => b.kind === "question" && (b.state === "open" || b.state === "collapsed"));
}
