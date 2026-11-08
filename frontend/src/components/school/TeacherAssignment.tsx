import { useCallback, useEffect, useState } from "react";
import { describe } from "../../lib/api";
import { t } from "../../lib/i18n";
import { fmtDateTime, fmtDuration, materialBlob, school, toLocalInput, fromLocalInput, type AssignmentDetail, type AttemptResult, type MaterialBody, type ResultRow, type SchoolQuestion } from "../../lib/school";
import { notify } from "../../lib/toast";
import { Button, Field } from "../ui/index";
import { Markdown } from "../Markdown";

function useAsync<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    load().then((d) => { if (live) { setData(d); setError(""); } }, (e) => { if (live) setError(describe(e)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: useCallback(() => setTick((n) => n + 1), []) };
}

/* ----------------------------------------------------------------- material */

function MaterialView({ id }: { id: string }) {
  const m = useAsync<MaterialBody>(() => school.material(id), [id]);
  const body = m.data;
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!body || ("text" in body && (body.mime.startsWith("text/") || body.mime === "application/json"))) return;
    const u = URL.createObjectURL(materialBlob(body));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [body]);
  if (m.error) return <p role="alert" className="tsc-error">{m.error}</p>;
  if (!body) return <p className="tsc-hint">{t("Загрузка…")}</p>;
  if ("text" in body) {
    if (body.mime === "text/markdown" || /\.md$/i.test(body.name)) return <Markdown text={body.text} className="pf-md tsc-material" />;
    if (body.mime === "text/html") return <iframe className="tsc-frame" title={body.name} sandbox="" srcDoc={body.text} />;
    return <pre className="tsc-pre selectable">{body.text}</pre>;
  }
  if (body.mime.startsWith("image/")) return url ? <img className="tsc-img" src={url} alt={body.name} /> : null;
  if (body.mime === "application/pdf") return url ? <iframe className="tsc-frame" title={body.name} src={url} /> : null;
  return <a className="tsc-link" href={url} download={body.name}>{t("Скачать «{0}»", [body.name.replace(/\.[^.]+$/, "")])}</a>;
}

/* -------------------------------------------------------------- student drill */

function StudentAnswers({ id, studentId, questions, onBack }: { id: string; studentId: string; questions: SchoolQuestion[]; onBack: () => void }) {
  const r = useAsync(() => school.studentResult(id, studentId), [id, studentId]);
  const [attempts, setAttempts] = useState<AttemptResult[] | null>(null);
  useEffect(() => { if (r.data) setAttempts(r.data.attempts); }, [r.data]);
  const score = async (a: AttemptResult, qid: string, correct: boolean) => {
    try {
      const next = await school.score(id, studentId, a.attempt, qid, correct);
      setAttempts((cur) => cur?.map((x) => (x.attempt === next.attempt ? next : x)) ?? null);
    } catch (e) { notify(describe(e), { kind: "error" }); }
  };
  return (
    <div className="tsc-drill" data-tsc-drill>
      <Button variant="ghost" onClick={onBack}>{t("← К результатам")}</Button>
      <h3 className="tsc-h3">{r.data?.student.name ?? ""}</h3>
      {r.error && <p role="alert" className="tsc-error">{r.error}</p>}
      {attempts && !attempts.length && <p className="tsc-hint">{t("Попыток пока нет")}</p>}
      {attempts?.map((a) => (
        <section key={a.attempt} className="tsc-attempt">
          <h4 className="tsc-h4">{t("Попытка {0}", [a.attempt])} · {a.submitted_at ? t("решил {0} из {1}", [a.score, a.max]) : t("в процессе")}{a.pending ? ` · ${t("на проверке: {0}", [a.pending])}` : ""}</h4>
          <p className="tsc-hint">{fmtDateTime(a.started_at)}{a.submitted_at ? ` → ${fmtDateTime(a.submitted_at)} (${fmtDuration(a.duration_sec)})` : ""}{a.auto ? ` · ${t("сдано по таймеру")}` : ""}</p>
          <ol className="tsc-answers">
            {questions.map((q) => {
              const ans = a.answers?.find((x) => x.question_id === q.id);
              const res = a.results.find((x) => x.question_id === q.id);
              const chosen = (ans?.selected_option_ids ?? []).map((oid) => q.options?.find((o) => o.id === oid)?.label ?? oid);
              const right = (q.grading?.correct_option_ids ?? []).map((oid) => q.options?.find((o) => o.id === oid)?.label ?? oid);
              const state = res?.correct === true ? "ok" : res?.correct === false ? "bad" : "pending";
              return (
                <li key={q.id} className={`tsc-ans is-${state}`} data-tsc-answer={q.id}>
                  <div className="tsc-ans-q">{q.prompt}</div>
                  <div className="tsc-ans-a">
                    {ans?.status === "skipped" ? t("Пропущено") : ans?.status === "dont_know" ? t("Не знаю") : ans ? [...chosen, ans.text].filter(Boolean).join("; ") || t("Нет ответа") : t("Нет ответа")}
                  </div>
                  {right.length > 0 && <div className="tsc-hint">{t("Правильно: {0}", [right.join("; ")])}</div>}
                  {q.grading?.rubric && <div className="tsc-hint">{t("Критерии: {0}", [q.grading.rubric])}</div>}
                  <div className="tsc-ans-foot">
                    <span className={`tsc-verdict is-${state}`}>{state === "ok" ? t("Верно") : state === "bad" ? t("Неверно") : t("Нужна проверка")}{res?.manual ? ` · ${t("вручную")}` : ""}</span>
                    {a.submitted_at && (state === "pending" || res?.manual) && (
                      <span className="tsc-ans-btns">
                        <Button variant={res?.correct === true ? "primary" : "secondary"} onClick={() => void score(a, q.id, true)}>{t("Верно")}</Button>
                        <Button variant={res?.correct === false ? "primary" : "secondary"} onClick={() => void score(a, q.id, false)}>{t("Неверно")}</Button>
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------- table */

function statusClass(r: ResultRow) {
  return r.status === "submitted" ? "ok" : r.status === "missed" ? "bad" : r.status === "in_progress" ? "run" : "idle";
}

function ResultsTable({ rows, onOpen }: { rows: ResultRow[]; onOpen: (id: string) => void }) {
  if (!rows.length) return <p className="tsc-hint">{t("Получателей пока нет")}</p>;
  return (
    <div className="tsc-table-wrap">
      <table className="tsc-table" data-tsc-results>
        <thead><tr><th scope="col">{t("Ученик")}</th><th scope="col">{t("Статус")}</th><th scope="col">{t("Начал")}</th><th scope="col">{t("Сдал")}</th><th scope="col">{t("Время")}</th><th scope="col">{t("Попытки")}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.student.id} data-tsc-row={r.student.id}>
              <th scope="row"><button type="button" className="tsc-linkbtn" disabled={r.attempts_used === 0} onClick={() => onOpen(r.student.id)}>{r.student.name}</button></th>
              <td><span className={`tsc-status is-${statusClass(r)}`}>{r.status_label}</span></td>
              <td>{fmtDateTime(r.started_at)}</td>
              <td>{fmtDateTime(r.submitted_at)}{r.auto ? ` (${t("таймер")})` : ""}</td>
              <td>{fmtDuration(r.duration_sec)}</td>
              <td>{r.attempts_used}/{r.attempts_used + r.attempts_left}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------- detail */

function EditSettings({ a, onSaved }: { a: AssignmentDetail; onSaved: () => void }) {
  const [deadline, setDeadline] = useState(toLocalInput(a.deadline));
  const [attempts, setAttempts] = useState(String(a.quiz?.settings.attempts ?? 1));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const n = Math.min(20, Math.max(1, parseInt(attempts, 10) || 1));
      await school.update(a.id, { deadline: fromLocalInput(deadline), ...(a.quiz ? { quiz: { settings: { attempts: n } } } : {}) });
      notify(t("Сохранено"), { kind: "success" });
      onSaved();
    } catch (e) { notify(describe(e), { kind: "error" }); } finally { setBusy(false); }
  };
  return (
    <div className="tsc-edit">
      <div className="tsc-field"><label className="ui-field-label" htmlFor="tsc-ed-deadline">{t("Дедлайн")}</label><input id="tsc-ed-deadline" className="tsc-input" type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.currentTarget.value)} /></div>
      {a.quiz && <Field label={t("Попыток")} inputMode="numeric" value={attempts} onChange={(e) => setAttempts(e.currentTarget.value.replace(/\D/g, ""))} />}
      <Button variant="primary" disabled={busy} onClick={() => void save()}>{t("Сохранить")}</Button>
    </div>
  );
}

const SHOW_LABEL = { after_submit: "после сдачи", after_deadline: "после дедлайна", never: "не показывать" } as const;

export function TeacherAssignment({ id, onBack, onDeleted }: { id: string; onBack: () => void; onDeleted: () => void }) {
  const d = useAsync(() => school.detail(id), [id]);
  const res = useAsync(async () => ((await school.detail(id)).kind === "quiz" ? (await school.results(id)).rows : []), [id]);
  const [student, setStudent] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const a = d.data;
  const [confirmDel, setConfirmDel] = useState(false);
  const remove = async () => {
    try { await school.remove(id); onDeleted(); } catch (e) { notify(describe(e), { kind: "error" }); }
  };
  if (d.error) return <div><Button variant="ghost" onClick={onBack}>{t("← Назад")}</Button><p role="alert" className="tsc-error">{d.error}</p></div>;
  if (!a) return <p className="tsc-hint">{t("Загрузка…")}</p>;
  if (student && a.quiz?.questions) return <StudentAnswers id={id} studentId={student} questions={a.quiz.questions} onBack={() => { setStudent(null); res.reload(); }} />;
  const s = a.quiz?.settings;
  return (
    <article className="tsc-detail" data-tsc-detail={a.kind}>
      <Button variant="ghost" onClick={onBack}>{t("← Назад")}</Button>
      <header className="tsc-detail-head">
        <h2 className="tsc-h2">{a.title}</h2>
        <p className="tsc-hint">{a.class_title} · {a.kind === "quiz" ? t("Тест") : t("Материал")} · {t("получателей: {0}", [a.recipients_count])}</p>
      </header>
      {a.description && <p className="tsc-desc">{a.description}</p>}
      <dl className="tsc-facts">
        <dt>{t("Дедлайн")}</dt><dd>{a.deadline ? fmtDateTime(a.deadline) : t("нет")}</dd>
        {s && <><dt>{t("Время на тест")}</dt><dd>{s.time_limit_sec ? t("{0} мин с момента открытия", [Math.round(s.time_limit_sec / 60)]) : t("без ограничения")}</dd>
          <dt>{t("Попыток")}</dt><dd>{s.attempts}</dd>
          <dt>{t("Ответы")}</dt><dd>{t(SHOW_LABEL[s.show_answers])}</dd>
          <dt>{t("Вопросов")}</dt><dd>{a.quiz?.questions?.length ?? a.quiz?.question_count}{s.shuffle_questions ? ` · ${t("перемешиваются")}` : ""}</dd></>}
      </dl>
      <div className="tsc-row">
        <Button variant="secondary" onClick={() => setEdit((v) => !v)} aria-expanded={edit}>{t("Изменить дедлайн")}</Button>
        {confirmDel
          ? <span className="tsc-confirm" role="alert"><span className="tsc-hint">{t("Удалить у всех учеников вместе с результатами?")}</span><Button variant="primary" onClick={() => void remove()}>{t("Да, удалить")}</Button><Button variant="ghost" onClick={() => setConfirmDel(false)}>{t("Отмена")}</Button></span>
          : <Button variant="ghost" onClick={() => setConfirmDel(true)}>{t("Удалить")}</Button>}
      </div>
      {edit && <EditSettings a={a} onSaved={() => { setEdit(false); d.reload(); }} />}
      {a.kind === "material" ? <MaterialView id={id} /> : (
        <>
          {res.data && (
            <div className="tsc-stats" data-tsc-stats>
              <div className="tsc-stat"><b>{res.data.filter((r) => r.status === "submitted").length}/{res.data.length}</b><span>{t("сдали")}</span></div>
              <div className="tsc-stat"><b>{res.data.filter((r) => r.status === "in_progress").length}</b><span>{t("решают сейчас")}</span></div>
              <div className="tsc-stat"><b>{res.data.filter((r) => r.status === "not_started").length}</b><span>{t("не начинали")}</span></div>
              {res.data.some((r) => r.pending) && <div className="tsc-stat is-warn"><b>{res.data.reduce((n, r) => n + (r.pending ?? 0), 0)}</b><span>{t("ответов ждут проверки")}</span></div>}
            </div>
          )}
          <h3 className="tsc-h3">{t("Результаты")}</h3>
          {res.error && <p role="alert" className="tsc-error">{res.error}</p>}
          {res.data && <ResultsTable rows={res.data} onOpen={setStudent} />}
        </>
      )}
    </article>
  );
}
