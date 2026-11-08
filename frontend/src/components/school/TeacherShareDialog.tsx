import { useEffect, useMemo, useRef, useState } from "react";
import { describe } from "../../lib/api";
import { t } from "../../lib/i18n";
import { hub, type HubClass } from "../../lib/max";
import { DEFAULT_SETTINGS, MATERIAL_MAX_BYTES, cleanQuestions, fileToMaterial, fromLocalInput, school, toLocalInput, validateQuestions, type AssignmentKind, type AssignmentSummary, type MaterialBody, type QuizSettings, type SchoolQuestion, type ShowAnswers } from "../../lib/school";
import { notify } from "../../lib/toast";
import { Button, Field, Modal, Select, Textarea } from "../ui/index";
import { TeacherQuestionEditor, blankQuestion } from "./TeacherQuestionEditor";

export interface SharePrefill {
  title?: string;
  description?: string;
  /** a ready material (a presented file): the teacher cannot change it here */
  material?: () => Promise<MaterialBody>;
  materialLabel?: string;
  /** an AI-made quiz: the questions come in, the teacher marks the right answers */
  questions?: SchoolQuestion[];
  /** preselect a class */
  classCode?: string;
}

const SHOW: { id: ShowAnswers; label: string }[] = [
  { id: "after_submit", label: "После сдачи" },
  { id: "after_deadline", label: "После дедлайна" },
  { id: "never", label: "Не показывать" },
];

/** Whole class / chosen students, for one or several classes. */
function Recipients({ classes, codes, onCodes, students, onStudents }: { classes: HubClass[]; codes: string[]; onCodes: (c: string[]) => void; students: string[] | null; onStudents: (s: string[] | null) => void }) {
  const one = codes.length === 1 ? classes.find((c) => c.code === codes[0]) : undefined;
  const toggle = (code: string) => {
    const next = codes.includes(code) ? codes.filter((c) => c !== code) : [...codes, code];
    onCodes(next);
    onStudents(null);
  };
  if (!classes.length) return <p className="tsc-hint" data-tsc-no-classes>{t("Сначала создайте класс: раздел «Классы» на вкладке «Школа».")}</p>;
  return (
    <fieldset className="tsc-group">
      <legend className="ui-field-label">{t("Кому")}</legend>
      <div className="tsc-chips">
        {classes.map((c) => (
          <label key={c.code} className={`tsc-chip${codes.includes(c.code) ? " is-on" : ""}`}>
            <input type="checkbox" checked={codes.includes(c.code)} onChange={() => toggle(c.code)} />{c.title}
          </label>
        ))}
      </div>
      {one && (
        <div className="tsc-sub">
          <label className="tsc-check"><input type="radio" name="tsc-who" checked={students === null} onChange={() => onStudents(null)} />{t("Весь класс ({0})", [one.students?.length ?? 0])}</label>
          <label className="tsc-check"><input type="radio" name="tsc-who" checked={students !== null} disabled={!one.students?.length} onChange={() => onStudents([])} />{t("Выбранные ученики")}</label>
          {students !== null && (
            <div className="tsc-students">
              {one.students?.map((s) => (
                <label key={s.id} className="tsc-check"><input type="checkbox" checked={students.includes(s.id)} onChange={() => onStudents(students.includes(s.id) ? students.filter((x) => x !== s.id) : [...students, s.id])} />{s.name}</label>
              ))}
            </div>
          )}
        </div>
      )}
      {codes.length > 1 && <p className="tsc-hint">{t("В несколько классов задание уходит всему классу целиком.")}</p>}
    </fieldset>
  );
}

function SettingsForm({ value, onChange }: { value: QuizSettings; onChange: (v: QuizSettings) => void }) {
  const minutes = value.time_limit_sec ? String(Math.round(value.time_limit_sec / 60)) : "";
  return (
    <div className="tsc-settings">
      <Field label={t("Время на тест, мин (с момента открытия)")} inputMode="numeric" value={minutes} placeholder={t("Без ограничения")}
        onChange={(e) => { const n = parseInt(e.currentTarget.value.replace(/\D/g, ""), 10); onChange({ ...value, time_limit_sec: Number.isFinite(n) && n > 0 ? Math.min(480, n) * 60 : null }); }} />
      <Field label={t("Попыток")} inputMode="numeric" value={String(value.attempts)}
        onChange={(e) => { const n = parseInt(e.currentTarget.value.replace(/\D/g, ""), 10); onChange({ ...value, attempts: Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : 1 }); }} />
      <div className="tsc-field">
        <span className="ui-field-label">{t("Показывать ответы")}</span>
        <Select block label={t("Показывать ответы")} value={value.show_answers} options={SHOW.map((o) => ({ id: o.id, label: t(o.label) }))} onChange={(show_answers) => onChange({ ...value, show_answers })} />
      </div>
      <label className="tsc-check"><input type="checkbox" checked={value.shuffle_questions} onChange={(e) => onChange({ ...value, shuffle_questions: e.currentTarget.checked })} />{t("Перемешивать вопросы")}</label>
    </div>
  );
}

/** Share / create a material or a test for classes. Used by the present_file card, the quiz UI and the School tab. */
export function TeacherShareDialog({ kind, prefill = {}, onClose, onDone }: { kind: AssignmentKind; prefill?: SharePrefill; onClose: () => void; onDone?: (created: AssignmentSummary[]) => void }) {
  const [classes, setClasses] = useState<HubClass[] | null>(null);
  const [codes, setCodes] = useState<string[]>(prefill.classCode ? [prefill.classCode] : []);
  const [students, setStudents] = useState<string[] | null>(null);
  const [title, setTitle] = useState(prefill.title ?? "");
  const [description, setDescription] = useState(prefill.description ?? "");
  const [deadline, setDeadline] = useState("");
  const [settings, setSettings] = useState<QuizSettings>(DEFAULT_SETTINGS);
  const [questions, setQuestions] = useState<SchoolQuestion[]>(() => prefill.questions ?? (kind === "quiz" ? [blankQuestion([])] : []));
  const [textMode, setTextMode] = useState(true);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const manualMaterial = kind === "material" && !prefill.material;

  useEffect(() => {
    let live = true;
    hub<{ classes: HubClass[] }>("GET", "/hub/classes").then((r) => {
      if (!live) return;
      setClasses(r.classes);
      setCodes((cur) => (cur.length || r.classes.length !== 1 ? cur : [r.classes[0].code]));
    }, (e) => { if (live) { setClasses([]); setError(describe(e)); } });
    return () => { live = false; };
  }, []);

  const problem = useMemo(() => {
    if (!codes.length) return t("Выберите класс");
    if (students !== null && !students.length) return t("Выберите хотя бы одного ученика");
    if (!title.trim()) return t("Введите название");
    if (kind === "quiz") { const v = validateQuestions(questions); return v ? t(v) : ""; }
    if (manualMaterial && (textMode ? !text.trim() : !file)) return textMode ? t("Введите текст материала") : t("Выберите файл");
    return "";
  }, [codes, students, title, kind, questions, manualMaterial, textMode, text, file]);

  const submit = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError("");
    try {
      let material: MaterialBody | undefined;
      if (kind === "material") {
        if (prefill.material) material = await prefill.material();
        else if (textMode) material = { name: `${title.trim().slice(0, 60)}.md`, mime: "text/markdown", text };
        else if (file) material = await fileToMaterial(file, file.name, file.type || "application/octet-stream");
      }
      const created = await school.create({
        class_codes: codes, ...(students ? { student_ids: students } : {}), kind, title: title.trim(), description: description.trim(),
        deadline: fromLocalInput(deadline),
        ...(material ? { material } : {}),
        ...(kind === "quiz" ? { quiz: { questions: cleanQuestions(questions), settings } } : {}),
      });
      notify(kind === "quiz" ? t("Тест отправлен") : t("Отправлено в класс"), { kind: "success" });
      onDone?.(created);
      onClose();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  };

  const summary = [
    deadline ? t("до {0}", [deadline.replace("T", " ")]) : t("без дедлайна"),
    ...(kind === "quiz" ? [settings.time_limit_sec ? t("{0} мин", [Math.round(settings.time_limit_sec / 60)]) : t("без таймера"), t("попыток: {0}", [settings.attempts])] : []),
  ].join(" · ");
  const target = codes.length === 1 ? classes?.find((c) => c.code === codes[0])?.title : codes.length > 1 ? t("классам: {0}", [codes.length]) : "";
  const heading = kind === "quiz" ? t("Новый тест") : t("Новый материал");
  return (
    <Modal label={heading} onClose={onClose} className="tsc-dialog">
      <div className="tsc-body" data-tsc-dialog={kind}>
        <h2 className="md-typescale-headline-small m-0">{heading}</h2>
        {classes === null ? <p className="tsc-hint">{t("Загрузка…")}</p> : (
          <Recipients classes={classes} codes={codes} onCodes={setCodes} students={students} onStudents={setStudents} />
        )}
        <div className="ui-field">
          <label className="ui-field-label" htmlFor="tsc-title">{kind === "quiz" ? t("Название теста") : t("Название для класса")}</label>
          <input id="tsc-title" className="tsc-input" type="text" value={title} maxLength={120} autoComplete="off" onChange={(e) => setTitle(e.target.value)} />
        </div>
        {kind === "material" && prefill.material && <p className="tsc-hint" data-tsc-file>{t("Файл: {0}", [(prefill.materialLabel ?? title).replace(/\.[^.]+$/, "")])}</p>}
        {manualMaterial && (
          <div className="tsc-group">
            <div className="tsc-seg" role="radiogroup" aria-label={t("Содержимое")}>
              <button type="button" role="radio" aria-checked={textMode} className="tsc-seg-btn" onClick={() => setTextMode(true)}>{t("Текст")}</button>
              <button type="button" role="radio" aria-checked={!textMode} className="tsc-seg-btn" onClick={() => setTextMode(false)}>{t("Файл")}</button>
            </div>
            {textMode ? <Textarea label={t("Текст материала (поддерживается Markdown)")} value={text} rows={8} onChange={(e) => setText(e.currentTarget.value)} />
              : (
                <div className="tsc-upload">
                  <input ref={input} type="file" hidden onChange={(e) => { const f = e.currentTarget.files?.[0] ?? null; if (f && f.size > MATERIAL_MAX_BYTES) { setError(t("Файл больше 3 МБ")); setFile(null); } else { setError(""); setFile(f); } }} />
                  <Button variant="secondary" onClick={() => input.current?.click()}>{file ? t("Выбрать другой файл") : t("Выбрать файл")}</Button>
                  <span className="tsc-hint">{file ? file.name : t("До 3 МБ")}</span>
                </div>
              )}
          </div>
        )}
        {kind === "quiz" && (
          <>
            {prefill.questions && <p className="tsc-hint">{t("Проверьте вопросы и отметьте правильные ответы: ИИ не передаёт ключ.")}</p>}
            <TeacherQuestionEditor questions={questions} onChange={setQuestions} />
          </>
        )}
        <details className="tsc-more" data-tsc-more>
          <summary className="tsc-more-sum"><span className="tsc-more-title">{t("Параметры")}</span><span className="tsc-hint tsc-more-line">{summary}</span></summary>
          <div className="tsc-more-body">
            <Textarea label={kind === "quiz" ? t("Описание (что нужно знать, как проходить)") : t("Описание (что нужно сделать ученикам)")} value={description} rows={3} maxLength={2000} onChange={(e) => setDescription(e.currentTarget.value)} />
            <div className="tsc-field">
              <label className="ui-field-label" htmlFor="tsc-deadline">{t("Дедлайн")}</label>
              <div className="tsc-deadline">
                <input id="tsc-deadline" className="tsc-input" type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.currentTarget.value)} />
                {deadline && <Button variant="ghost" onClick={() => setDeadline("")}>{t("Без дедлайна")}</Button>}
              </div>
            </div>
            {kind === "quiz" && <SettingsForm value={settings} onChange={setSettings} />}
          </div>
        </details>
        {error && <p role="alert" className="tsc-error">{error}</p>}
        <div className="tsc-actions">
          <Button variant="ghost" onClick={onClose}>{t("Отмена")}</Button>
          <Button variant="primary" disabled={!!problem || busy} title={problem || undefined} onClick={() => void submit()} data-tsc-send>{busy ? t("Отправляю…") : target ? t("Отправить: {0}", [target]) : t("Отправить")}</Button>
        </div>
      </div>
    </Modal>
  );
}
