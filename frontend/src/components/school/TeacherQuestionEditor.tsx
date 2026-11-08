import { Plus, Trash } from "@phosphor-icons/react";
import { t } from "../../lib/i18n";
import type { QuestionType, SchoolQuestion } from "../../lib/school";
import { Button, IconButton, Textarea } from "../ui/index";

const nextId = (used: string[], prefix: string) => {
  let n = used.length + 1;
  while (used.includes(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
};

export const blankQuestion = (all: SchoolQuestion[], type: QuestionType = "single_choice"): SchoolQuestion => ({
  id: nextId(all.map((x) => x.id), "q"),
  type,
  prompt: "",
  ...(type === "free_text" ? {} : { options: [{ id: "a", label: "" }, { id: "b", label: "" }] }),
});

const TYPES: { id: QuestionType; label: string }[] = [
  { id: "single_choice", label: "Один ответ" },
  { id: "multiple_choice", label: "Несколько ответов" },
  { id: "free_text", label: "Свободный ответ" },
];

function QuestionCard({ q, index, onChange, onRemove }: { q: SchoolQuestion; index: number; onChange: (q: SchoolQuestion) => void; onRemove: () => void }) {
  const opts = q.options ?? [];
  const correct = q.grading?.correct_option_ids ?? [];
  const setCorrect = (ids: string[]) => onChange({ ...q, grading: { ...q.grading, correct_option_ids: ids } });
  const changeType = (type: QuestionType) => {
    if (type === q.type) return;
    if (type === "free_text") onChange({ ...q, type, options: undefined, allow_custom_answer: undefined, grading: { ...q.grading, correct_option_ids: undefined } });
    else {
      const options = opts.length ? opts : [{ id: "a", label: "" }, { id: "b", label: "" }];
      onChange({ ...q, type, options, grading: { ...q.grading, correct_option_ids: type === "single_choice" ? correct.slice(0, 1) : correct } });
    }
  };
  const toggle = (id: string) => {
    if (q.type === "single_choice") setCorrect(correct.includes(id) ? [] : [id]);
    else setCorrect(correct.includes(id) ? correct.filter((x) => x !== id) : [...correct, id]);
  };
  const setOption = (i: number, label: string) => onChange({ ...q, options: opts.map((o, j) => (j === i ? { ...o, label } : o)) });
  const addOption = () => {
    if (opts.length >= 8) return;
    onChange({ ...q, options: [...opts, { id: nextId(opts.map((o) => o.id), "o"), label: "" }] });
  };
  const removeOption = (i: number) => {
    const gone = opts[i].id;
    onChange({ ...q, options: opts.filter((_, j) => j !== i), grading: { ...q.grading, correct_option_ids: correct.filter((x) => x !== gone) } });
  };
  return (
    <fieldset className="tsc-q" data-tsc-question={q.id}>
      <legend className="tsc-q-legend">{t("Вопрос {0}", [index + 1])}</legend>
      <div className="tsc-q-top">
        <div className="tsc-seg" role="radiogroup" aria-label={t("Тип вопроса")}>
          {TYPES.map((x) => <button key={x.id} type="button" role="radio" aria-checked={q.type === x.id} className="tsc-seg-btn" onClick={() => changeType(x.id)}>{t(x.label)}</button>)}
        </div>
        <IconButton variant="ghost" aria-label={t("Удалить вопрос {0}", [index + 1])} onClick={onRemove}><Trash size={18} aria-hidden="true" /></IconButton>
      </div>
      <Textarea label={t("Текст вопроса")} value={q.prompt} rows={2} onChange={(e) => onChange({ ...q, prompt: e.currentTarget.value })} />
      {q.type !== "free_text" && (
        <div className="tsc-opts">
          <p className="tsc-hint">{q.type === "single_choice" ? t("Отметьте правильный вариант") : t("Отметьте все правильные варианты")}</p>
          {opts.map((o, i) => (
            <div className="tsc-opt" key={o.id}>
              <input type={q.type === "single_choice" ? "radio" : "checkbox"} name={`${q.id}-correct`} checked={correct.includes(o.id)} onChange={() => toggle(o.id)} aria-label={t("Правильный вариант {0}", [i + 1])} onClick={() => { if (q.type === "single_choice" && correct.includes(o.id)) toggle(o.id); }} />
              <input className="tsc-input" type="text" value={o.label} placeholder={t("Вариант {0}", [i + 1])} aria-label={t("Вариант {0}", [i + 1])} onChange={(e) => setOption(i, e.currentTarget.value)} />
              <IconButton variant="ghost" disabled={opts.length <= 2} aria-label={t("Удалить вариант {0}", [i + 1])} onClick={() => removeOption(i)}><Trash size={16} aria-hidden="true" /></IconButton>
            </div>
          ))}
          <div className="tsc-opts-foot">
            <Button variant="ghost" disabled={opts.length >= 8} onClick={addOption} iconBefore={<Plus size={14} aria-hidden="true" />}>{t("Вариант")}</Button>
            <label className="tsc-check"><input type="checkbox" checked={!!q.allow_custom_answer} onChange={(e) => onChange({ ...q, allow_custom_answer: e.currentTarget.checked })} />{t("Можно ввести свой ответ")}</label>
          </div>
          {correct.length === 0 && <p className="tsc-hint tsc-warn">{t("Без правильного ответа вопрос придётся проверять вручную")}</p>}
        </div>
      )}
      {q.type === "free_text" && <Textarea label={t("Критерии проверки (видны только вам)")} value={q.grading?.rubric ?? ""} rows={2} onChange={(e) => onChange({ ...q, grading: { ...q.grading, rubric: e.currentTarget.value } })} />}
      <details className="tsc-expl" open={!!q.grading?.explanation}>
        <summary className="tsc-expl-sum">{t("Пояснение к ответу (необязательно)")}</summary>
        <Textarea label={t("Пояснение к ответу")} value={q.grading?.explanation ?? ""} rows={2} onChange={(e) => onChange({ ...q, grading: { ...q.grading, explanation: e.currentTarget.value } })} />
      </details>
    </fieldset>
  );
}

/** Editor of the app's question schema: choice (with correct options) and free text. */
export function TeacherQuestionEditor({ questions, onChange }: { questions: SchoolQuestion[]; onChange: (q: SchoolQuestion[]) => void }) {
  return (
    <div className="tsc-questions" data-tsc-editor>
      {questions.map((q, i) => (
        <QuestionCard key={q.id} q={q} index={i} onChange={(next) => onChange(questions.map((x, j) => (j === i ? next : x)))} onRemove={() => onChange(questions.filter((_, j) => j !== i))} />
      ))}
      <div className="tsc-add-row">
        <Button variant="secondary" disabled={questions.length >= 100} onClick={() => onChange([...questions, blankQuestion(questions)])} iconBefore={<Plus size={14} aria-hidden="true" />}>{t("Добавить вопрос")}</Button>
      </div>
    </div>
  );
}
