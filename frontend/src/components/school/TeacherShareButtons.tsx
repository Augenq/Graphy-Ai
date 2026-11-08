import { useState } from "react";
import { get, sessionPath } from "../../lib/api";
import { PaperPlaneTilt } from "@phosphor-icons/react";
import { t } from "../../lib/i18n";
import { loadFile, type PresentedFile } from "../../lib/presented";
import { useMax } from "../../lib/max";
import { fileToMaterial, type SchoolQuestion } from "../../lib/school";
import { useTeacherMode } from "../../lib/teaching-api";
import type { Question } from "../../lib/types";
import { TeacherShareDialog } from "./TeacherShareDialog";

/** The School tab is real only when the app runs behind the hub and the user is a teacher. */
export function useCanShareToClass(): boolean {
  const teacher = useTeacherMode();
  const max = useMax();
  return teacher && max.hub && max.status === "ready";
}

const strip = (name: string) => name.replace(/\.[^.]+$/, "");

/** «Отправить в класс» under / in the header of a presented file. */
export function ShareFileButton({ file, compact }: { file: PresentedFile; compact?: boolean }) {
  const can = useCanShareToClass();
  const [open, setOpen] = useState(false);
  if (!can) return null;
  return (
    <>
      <button type="button" className={`tsc-share-btn${compact ? " is-compact" : ""}`} data-tsc-share-file onClick={() => setOpen(true)}>
        <PaperPlaneTilt size={16} aria-hidden="true" />{t("Отправить в класс")}
      </button>
      {open && <TeacherShareDialog kind="material" onClose={() => setOpen(false)}
        prefill={{ title: file.title || strip(file.name), materialLabel: file.name, material: async () => fileToMaterial(await loadFile(file), file.name, file.mime) }} />}
    </>
  );
}

/** The answer key the model committed with a question; served to the teacher only (`GET /sessions/{id}/answer_keys`). */
export type AnswerKey = { correct_option_ids?: string[]; explanation?: string; rubric?: string };
export type AnswerKeys = Record<string, Record<string, AnswerKey>>;

/** App questions to the school schema: option ids are kept; the model's answer key (when the teacher endpoint returned one) prefills
 *  the correct options, the reference answer and the explanation, and the teacher can still edit them in the dialog. */
export function toSchoolQuestions(questions: Question[], keys: Record<string, AnswerKey> = {}): SchoolQuestion[] {
  const safe = (s: string | undefined, fallback: string) => (s && /^[\w-]+$/.test(s) ? s : fallback);
  return questions.slice(0, 100).map((q, i) => {
    const id = safe(q.id, `q${i + 1}`);
    const options = q.type === "free_text" ? undefined : (q.options ?? []).map((label, j) => ({ id: safe(q.optionIds?.[j], `o${j + 1}`), label }));
    const key = keys[q.id] ?? keys[id];
    const known = new Set(options?.map((o) => o.id));
    const correct = (key?.correct_option_ids ?? []).filter((c) => known.has(c));
    const grading: NonNullable<SchoolQuestion["grading"]> = {
      ...(correct.length ? { correct_option_ids: correct } : {}),
      ...(key?.rubric ? { rubric: key.rubric } : {}),
      ...(key?.explanation ? { explanation: key.explanation } : {}),
    };
    return { id, type: q.type, prompt: q.prompt, ...(options ? { options } : {}), ...(Object.keys(grading).length ? { grading } : {}) };
  });
}

/** «Сохранить / Отправить» on an AI-made quiz in a teacher's quiz chat. */
export function ShareQuizButton({ sessionId, batchId, title, questions }: { sessionId: string; batchId: string; title: string; questions: Question[] }) {
  const can = useCanShareToClass();
  const [prefill, setPrefill] = useState<SchoolQuestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  if (!can || !questions.length) return null;
  const openDialog = async () => {
    setBusy(true);
    // a missing or refused key list only means the teacher marks the answers by hand
    const keys = await get<AnswerKeys>(sessionPath(sessionId, "/answer_keys")).catch(() => ({} as AnswerKeys));
    setPrefill(toSchoolQuestions(questions, keys[batchId]));
    setBusy(false);
  };
  return (
    <>
      <button type="button" className="tsc-share-btn" data-tsc-share-quiz disabled={busy} onClick={openDialog}>
        <PaperPlaneTilt size={16} aria-hidden="true" />{t("Сохранить и отправить в класс")}
      </button>
      {prefill && <TeacherShareDialog kind="quiz" onClose={() => setPrefill(null)} prefill={{ title, questions: prefill }} />}
    </>
  );
}
