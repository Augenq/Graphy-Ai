/** Session modes: explain (teaching), quiz (self-check) and materials (files). Stored "learn" means explain. Talks only to the local backend. */
import { get, put, sessionPath } from "./api";
import type { Outcome } from "./types";
import type { Snapshot } from "./wire";

export type SessionMode = "explain" | "quiz" | "materials";
/** Any stored or wire value to a current mode id ("learn" is the old name of explain). */
export const normalizeMode = (m?: string | null): SessionMode => (m === "quiz" || m === "materials" ? m : "explain");
export type QuizKind = "check";
export interface ModeChoice { mode: SessionMode; kind: QuizKind; minutes: number }
export const DEFAULT_CHOICE: ModeChoice = { mode: "explain", kind: "check", minutes: 0 };
export const QUIZ_MINUTES = [0, 15, 30, 45, 60, 90];

/** The deadline sent to the backend: epoch seconds, or null for no timer. */
export const deadlineFor = (choice: ModeChoice, now = Date.now()): number | null =>
  choice.mode === "quiz" && choice.minutes > 0 ? Math.round(now / 1000 + choice.minutes * 60) : null;

export async function setSessionMode(id: string, choice: ModeChoice, now = Date.now()) {
  return put<import("./wire").SessionSummary>(sessionPath(id, "/mode"), {
    mode: choice.mode, quiz_kind: choice.kind, deadline: deadlineFor(choice, now),
  });
}

/** Seconds left (negative when late). `null` without a deadline. */
export const secondsLeft = (deadline: number | null | undefined, now = Date.now()) =>
  deadline ? Math.round(deadline - now / 1000) : null;

export function clock(seconds: number) {
  const s = Math.abs(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0"), rr = String(r).padStart(2, "0");
  return `${seconds < 0 ? "−" : ""}${h ? `${h}:` : ""}${mm}:${rr}`;
}

export interface TopicResult { topic: string; total: number; independent: number; gap: number; other: number }
export interface QuizReportData { total: number; independent: number; gap: number; other: number; topics: TopicResult[]; fixFirst: string[] }
interface Row { outcome: Outcome; topic_id?: string; mode?: string }

/** One row of the study core's `GET /study/weak-topics` (only what the quiz needs). */
export interface StudyWeak { topic: string }

/**
 * Where "what to fix first" comes from: the learner's weak topics (study core), the most open gaps first;
 * without any, this quiz's own result on the plan topics.
 */
export function weakTopicsSource(topics: TopicResult[], studyWeak: StudyWeak[] = []): string[] {
  const own = studyWeak.map((w) => w.topic);
  if (own.length) return [...new Set(own)].slice(0, 3);
  return topics.filter((x) => x.gap > 0 || x.other > 0).sort((a, b) => b.gap - a.gap || b.other - a.other).slice(0, 3).map((x) => x.topic);
}

/** Per-topic result of the quiz-mode assessments. Hints cannot occur in a quiz, so independent is honest evidence. */
export function buildReport(rows: Row[], steps: { id: string; title: string }[], noTopic: string, studyWeak: StudyWeak[] = []): QuizReportData {
  const quiz = rows.filter((r) => r.mode === "quiz");
  const title = (id?: string) => steps.find((s) => s.id === id)?.title || noTopic;
  const by = new Map<string, TopicResult>();
  for (const r of quiz) {
    const name = title(r.topic_id);
    const t = by.get(name) ?? { topic: name, total: 0, independent: 0, gap: 0, other: 0 };
    t.total++;
    if (r.outcome === "independent") t.independent++;
    else if (r.outcome === "gap" || r.outcome === "with_hints") t.gap++;
    else t.other++;
    by.set(name, t);
  }
  const topics = [...by.values()];
  const sum = (k: "independent" | "gap" | "other") => topics.reduce((n, x) => n + x[k], 0);
  return { total: quiz.length, independent: sum("independent"), gap: sum("gap"), other: sum("other"), topics, fixFirst: weakTopicsSource(topics, studyWeak) };
}

export async function fetchReport(id: string, noTopic: string) {
  const snap = await get<Snapshot>(sessionPath(id));
  const learning = snap.learning as (Snapshot["learning"] & { assessments?: Row[] }) | null;
  // local backend only; a failure just means the plan topics are used
  const weak = await get<{ topics: StudyWeak[] }>("/study/weak-topics").then((r) => r.topics, () => [] as StudyWeak[]);
  return buildReport(learning?.assessments ?? [], learning?.steps ?? [], noTopic, weak);
}
