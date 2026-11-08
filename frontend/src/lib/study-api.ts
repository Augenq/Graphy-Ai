/** Client of the study API (backend/docs/protocol.md, «Учёба»): task bank, spaced review, calendar. */
import { del, get, patch, post } from "./api";
import { newSession, send } from "./engine";
import { plural, t } from "./i18n";

export type Outcome = "independent" | "with_hints" | "gap" | "uncertain" | "skipped";

export interface BankItem {
  id: string;
  course_id: string;
  course: string;
  topic: string;
  session_id: string;
  question: string;
  answer: string;
  feedback: string;
  outcome: Outcome;
  used_hints: boolean;
  error_type: string;
  time: number;
  attempts: number;
  history: { time: number; outcome: Outcome }[];
  due_at: number | null;
  stage: number | null;
  interval_days: number;
  tags: string[];
  note: string;
  suspended: boolean;
}
export interface Facet { count: number }
export interface BankFacets {
  courses: (Facet & { id: string; name: string })[];
  topics: (Facet & { topic: string })[];
  outcomes: (Facet & { outcome: Outcome })[];
  tags: (Facet & { tag: string })[];
  error_types: (Facet & { error_type: string })[];
}
export interface BankResult { items: BankItem[]; total: number; truncated: boolean; facets: BankFacets }
export interface BankFilter { course_id?: string; topic?: string; outcome?: string; tag?: string; error_type?: string; q?: string; state?: "active" | "suspended" | "all" }

export interface TopicDue { topic: string; course_id: string; course: string; due_at: number | null; due_count: number; weak: number; total: number }
export interface DueResult { now: number; total_due: number; items: BankItem[]; topics: TopicDue[]; upcoming_week: number }

export type EventKind = "exam" | "session" | "note";
export interface StudyEvent { id: string; kind: EventKind; date: string; time?: string; title: string; course_id?: string; topic?: string; note?: string }
export interface CalendarDay {
  date: string;
  reviews: { count: number; topics: { course_id: string; topic: string; count: number }[] };
  events: StudyEvent[];
}
export interface ExamCountdown { id: string; title: string; date: string; course_id?: string; days_left: number; reviews_before: number }
export interface CalendarResult { today: string; from: string; to: string; days: CalendarDay[]; exam_countdown: ExamCountdown[] }
export interface ReviewPlan { course_id: string; count: number; prompt: string; items: BankItem[] }
export type EventInput = Partial<Omit<StudyEvent, "id">>;

const query = (params: Record<string, string | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
};

export const loadBank = (filter: BankFilter = {}) => get<BankResult>(`/study/bank${query({ ...filter })}`);
export const loadDue = () => get<DueResult>("/study/due");
export const loadCalendar = (from: string, to: string) => get<CalendarResult>(`/study/calendar${query({ from, to })}`);
export const createEvent = (event: EventInput) => post<StudyEvent>("/study/events", event);
export const updateEvent = (id: string, event: EventInput) => patch<StudyEvent>(`/study/events/${encodeURIComponent(id)}`, event);
export const deleteEvent = (id: string) => del<unknown>(`/study/events/${encodeURIComponent(id)}`);
export const updateItem = (id: string, change: { tags?: string[]; note?: string; suspended?: boolean; deleted?: boolean }) =>
  patch<{ id: string }>(`/study/items/${encodeURIComponent(id)}`, change);
export const nextReview = (n = 8, courseId?: string) => post<ReviewPlan>("/study/review/next", { n, ...(courseId ? { course_id: courseId } : {}) });

/** Starts a normal lesson seeded with the review instruction; returns the new lesson id or "" when nothing is due. */
export async function startReview(courseId?: string): Promise<string> {
  const plan = await nextReview(8, courseId);
  if (!plan.count || !plan.prompt) return "";
  const id = await newSession();
  void send(id, plan.prompt);
  return id;
}

/** The calendar as a file for the learner's own calendar app; the download is local, nothing is uploaded. */
export async function downloadIcs() {
  const file = await get<{ filename: string; content: string; content_type: string }>("/study/calendar/ics");
  const url = URL.createObjectURL(new Blob([file.content], { type: `${file.content_type};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- dates (local calendar days, "YYYY-MM-DD") ----

export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const parseYmd = (s: string) => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));

/** The 6x7 grid of a month, Monday first; days outside the month are flagged. */
export function monthGrid(year: number, month: number): { date: string; inMonth: boolean }[] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(year, month, 1 - lead + i);
    return { date: ymd(d), inMonth: d.getMonth() === month };
  });
}

export const days = (n: number) => `${n} ${plural(n, "день", "дня", "дней")}`;

/** «Пора освежить» / «Через 3 дня»: calm wording, never an overdue count. */
export function dueText(dueAt: number | null, now: number): string {
  if (dueAt === null) return t("Без напоминания");
  if (dueAt <= now) return t("Пора освежить");
  const n = Math.max(1, Math.round((dueAt - now) / 86400));
  return t("Через {0}", [days(n)]);
}

export const OUTCOME_LABEL: Record<Outcome, string> = {
  independent: "Сам",
  with_hints: "С подсказками",
  gap: "Пробел",
  uncertain: "Не уверен",
  skipped: "Пропущено",
};
