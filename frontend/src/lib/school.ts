/** Typed client of the hub's School API (see .orch/DESIGN-school.md): teacher and student endpoints. */
import { hub } from "./max";

export type AssignmentKind = "material" | "quiz";
export type ShowAnswers = "after_submit" | "after_deadline" | "never";
export type QuestionType = "single_choice" | "multiple_choice" | "free_text";
export type StudentStatus = "in_progress" | "submitted" | "missed" | "not_started" | "material";

export interface SchoolOption { id: string; label: string }
export interface SchoolQuestion {
  id: string;
  type: QuestionType;
  prompt: string;
  options?: SchoolOption[];
  allow_custom_answer?: boolean;
  grading?: { correct_option_ids?: string[]; explanation?: string; rubric?: string };
}
export interface QuizSettings { time_limit_sec: number | null; attempts: number; show_answers: ShowAnswers; shuffle_questions: boolean }
export const DEFAULT_SETTINGS: QuizSettings = { time_limit_sec: null, attempts: 1, show_answers: "after_submit", shuffle_questions: false };

export interface MaterialMeta { name: string; mime: string; size: number }
export type MaterialBody = { name: string; mime: string; text: string } | { name: string; mime: string; base64: string };
export interface QuizStats { submitted: number; in_progress: number; missed: number; not_started: number; pending_review: number }

export interface AssignmentSummary {
  id: string;
  class_code: string;
  class_title: string;
  kind: AssignmentKind;
  title: string;
  description: string;
  deadline: number | null;
  created: number;
  updated: number;
  recipients_count: number;
  quiz?: { question_count: number; settings: QuizSettings };
  material?: MaterialMeta;
  stats?: QuizStats;
}
export interface AssignmentDetail extends AssignmentSummary {
  recipients: { id: string; name: string }[];
  student_ids?: string[] | null;
  quiz?: { question_count: number; settings: QuizSettings; questions: SchoolQuestion[] };
}
export interface ClassGroup { code: string; title: string; total: number; items: AssignmentSummary[] }

export interface StudentItem extends Omit<AssignmentSummary, "stats" | "recipients_count"> {
  teacher_name: string;
  status: StudentStatus;
  status_label: string;
  attempts_used?: number;
  attempts_left?: number;
  in_progress?: { attempt: number; ends_at: number | null; time_left_sec: number | null };
  best?: { attempt: number; score: number; max: number; pending: number; submitted_at: number };
}

export interface ResultRow {
  student: { id: string; name: string };
  status: StudentStatus;
  status_label: string;
  attempts_used: number;
  attempts_left: number;
  started_at: number | null;
  submitted_at: number | null;
  duration_sec: number | null;
  score: number | null;
  max: number | null;
  pending: number | null;
  auto: boolean | null;
}

export interface SchoolAnswer { question_id: string; status: "answered" | "skipped" | "dont_know"; selected_option_ids: string[]; text: string }
export interface QuestionResult { question_id: string; correct: boolean | null; manual?: boolean; correct_option_ids?: string[]; explanation?: string }
export interface AttemptResult {
  attempt: number;
  started_at: number;
  ends_at: number | null;
  submitted_at: number | null;
  duration_sec: number | null;
  auto: boolean;
  score: number;
  max: number;
  pending: number;
  answers?: SchoolAnswer[];
  /** frozen questions in the attempt's order (no answer key); present on submitted attempts for the student */
  questions?: SchoolQuestion[];
  results: QuestionResult[];
}

export interface StartedAttempt { attempt: number; started_at: number; ends_at: number | null; server_time: number; time_left_sec: number | null; questions: SchoolQuestion[]; answers?: SchoolAnswer[]; position?: number; saved_at?: number | null }

export interface CreateAssignment {
  class_codes: string[];
  student_ids?: string[] | null;
  kind: AssignmentKind;
  title: string;
  description?: string;
  deadline?: number | null;
  material?: MaterialBody;
  quiz?: { questions: SchoolQuestion[]; settings?: Partial<QuizSettings> };
}
export type UpdateAssignment = Partial<Pick<CreateAssignment, "title" | "description" | "deadline" | "student_ids" | "material">> & { quiz?: { questions?: SchoolQuestion[]; settings?: Partial<QuizSettings> } };

const base = "/hub/school/assignments";
const q = (params: Record<string, string | number | undefined>) => {
  const s = Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
  return s ? `?${s}` : "";
};

export const MATERIAL_MAX_BYTES = 3 * 1024 * 1024;

export const school = {
  // teacher
  create: (body: CreateAssignment) => hub<{ assignments: AssignmentSummary[] }>("POST", base, body).then((r) => r.assignments),
  update: (id: string, body: UpdateAssignment) => hub<{ assignment: AssignmentDetail }>("PUT", `${base}/${id}`, body).then((r) => r.assignment),
  remove: (id: string) => hub<{ deleted: boolean }>("DELETE", `${base}/${id}`),
  list: (opts: { limit?: number; offset?: number; class?: string } = {}) => hub<{ classes: ClassGroup[] }>("GET", base + q(opts)).then((r) => r.classes),
  detail: (id: string) => hub<{ assignment: AssignmentDetail }>("GET", `${base}/${id}`).then((r) => r.assignment),
  material: (id: string) => hub<MaterialBody>("GET", `${base}/${id}/material`),
  results: (id: string) => hub<{ assignment: AssignmentSummary; rows: ResultRow[] }>("GET", `${base}/${id}/results`),
  studentResult: (id: string, studentId: string) => hub<{ student: { id: string; name: string }; attempts: AttemptResult[] }>("GET", `${base}/${id}/results/${encodeURIComponent(studentId)}`),
  score: (id: string, studentId: string, attempt: number, question_id: string, correct: boolean) =>
    hub<{ attempt: AttemptResult }>("PUT", `${base}/${id}/results/${encodeURIComponent(studentId)}/${attempt}/score`, { question_id, correct }).then((r) => r.attempt),
  // student
  my: (cls?: string) => hub<{ items: StudentItem[] }>("GET", `/hub/school/my${q({ class: cls })}`).then((r) => r.items),
  studentDetail: (id: string) => hub<{ assignment: StudentItem }>("GET", `${base}/${id}`).then((r) => r.assignment),
  start: (id: string) => hub<StartedAttempt>("POST", `${base}/${id}/start`, {}),
  draft: (id: string, answers: SchoolAnswer[], position?: number) => hub<{ saved: boolean; saved_at: number; server_time: number; time_left_sec: number | null }>("PUT", `${base}/${id}/draft`, { answers, position }),
  submit: (id: string, answers: SchoolAnswer[], auto?: boolean) => hub<{ attempt: AttemptResult }>("POST", `${base}/${id}/submit`, { answers, ...(auto ? { auto: true } : {}) }).then((r) => r.attempt),
  attempts: (id: string) => hub<{ attempts: AttemptResult[] }>("GET", `${base}/${id}/attempts`).then((r) => r.attempts),
  /** own submitted attempts with questions and answers; `open` is the attempt in progress with its saved draft */
  attemptsFull: (id: string) => hub<{ attempts: AttemptResult[]; open: StartedAttempt | null }>("GET", `${base}/${id}/attempts`),
};

/* ------------------------------------------------------------------ helpers */

/** Bytes to a base64 string without blowing the call stack on big files. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToBlob(base64: string, mime: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

const isTextMime = (mime: string) => mime.startsWith("text/") && mime !== "text/html" || mime === "application/json";

/** A file as the hub wants it: plain text stays text, everything else is base64. Throws a Russian message when too big. */
export async function fileToMaterial(blob: Blob, name: string, mime: string): Promise<MaterialBody> {
  if (blob.size > MATERIAL_MAX_BYTES) throw new Error("Файл больше 3 МБ: его нельзя отправить в класс");
  if (isTextMime(mime)) return { name, mime, text: await blob.text() };
  return { name, mime, base64: await blobToBase64(blob) };
}

export const materialBlob = (m: MaterialBody): Blob => ("text" in m ? new Blob([m.text], { type: m.mime }) : base64ToBlob(m.base64, m.mime));

/** Validation of a question set before sending; returns a Russian message or "". */
export function validateQuestions(questions: SchoolQuestion[]): string {
  if (!questions.length) return "Добавьте хотя бы один вопрос";
  const ids = new Set<string>();
  for (const [i, qn] of questions.entries()) {
    const n = i + 1;
    if (!qn.prompt.trim()) return `Вопрос ${n}: введите текст`;
    if (!/^[\w-]+$/.test(qn.id) || ids.has(qn.id)) return `Вопрос ${n}: повторяющийся идентификатор`;
    ids.add(qn.id);
    if (qn.type !== "free_text") {
      const opts = qn.options ?? [];
      if (opts.length < 2 || opts.length > 8) return `Вопрос ${n}: нужно от 2 до 8 вариантов`;
      if (opts.some((o) => !o.label.trim())) return `Вопрос ${n}: есть пустой вариант`;
    }
  }
  return "";
}

/** Drop empty strings and unused grading so the hub's strict validation passes. */
export function cleanQuestions(questions: SchoolQuestion[]): SchoolQuestion[] {
  return questions.map((qn) => {
    const out: SchoolQuestion = { id: qn.id, type: qn.type, prompt: qn.prompt.trim() };
    if (qn.type !== "free_text") {
      out.options = (qn.options ?? []).map((o) => ({ id: o.id, label: o.label.trim() }));
      if (qn.allow_custom_answer) out.allow_custom_answer = true;
    }
    const g = qn.grading;
    if (g) {
      const grading: NonNullable<SchoolQuestion["grading"]> = {};
      const valid = (g.correct_option_ids ?? []).filter((id) => out.options?.some((o) => o.id === id));
      if (qn.type !== "free_text" && valid.length) grading.correct_option_ids = qn.type === "single_choice" ? valid.slice(0, 1) : valid;
      if (g.explanation?.trim()) grading.explanation = g.explanation.trim();
      if (g.rubric?.trim()) grading.rubric = g.rubric.trim();
      if (Object.keys(grading).length) out.grading = grading;
    }
    return out;
  });
}

export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null) return "";
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h} ч ${m} мин` : m ? `${m} мин ${r} с` : `${r} с`;
}

export const fmtDateTime = (ms: number | null | undefined): string =>
  ms == null ? "" : new Date(ms).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** `<input type="datetime-local">` value <-> epoch ms. */
export const toLocalInput = (ms: number | null | undefined): string => {
  if (ms == null) return "";
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};
export const fromLocalInput = (v: string): number | null => (v ? new Date(v).getTime() : null);
