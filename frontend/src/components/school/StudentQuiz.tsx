import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Timer, CheckCircle, XCircle, Hourglass, WarningCircle } from "@phosphor-icons/react";
import { t } from "../../lib/i18n";
import { describe } from "../../lib/api";
import { fmtDateTime, fmtDuration, school, type AttemptResult, type SchoolAnswer, type SchoolQuestion, type StartedAttempt, type StudentItem } from "../../lib/school";
import { Button, Field, Textarea } from "../ui/index";
import { Markdown } from "../Markdown";

/* ----------------------------------------------------------------- answers */

interface Draft { sel: string[]; text: string; custom: boolean; mark: null | "dont_know" | "skipped" }
const blank = (): Draft => ({ sel: [], text: "", custom: false, mark: null });

type DraftState = "empty" | "answered" | "dont_know" | "skipped";
function stateOf(q: SchoolQuestion, d: Draft | undefined): DraftState {
  if (!d) return "empty";
  if (d.mark) return d.mark;
  if (q.type === "free_text") return d.text.trim() ? "answered" : "empty";
  if (d.custom) return d.text.trim() ? "answered" : "empty";
  return d.sel.length ? "answered" : "empty";
}
const STATE_LABEL: Record<DraftState, string> = { answered: "есть ответ", dont_know: "не знаю", skipped: "пропущен", empty: "не заполнен" };

export function toAnswers(qs: SchoolQuestion[], drafts: Record<string, Draft>): SchoolAnswer[] {
  return qs.map((q) => {
    const d = drafts[q.id], s = stateOf(q, d);
    if (s === "dont_know") return { question_id: q.id, status: "dont_know", selected_option_ids: [], text: "" };
    if (s !== "answered" || !d) return { question_id: q.id, status: "skipped", selected_option_ids: [], text: "" };
    if (q.type === "free_text" || d.custom) return { question_id: q.id, status: "answered", selected_option_ids: [], text: d.text.trim() };
    return { question_id: q.id, status: "answered", selected_option_ids: d.sel, text: "" };
  });
}

/** Rebuilds the editable drafts from the answers the hub saved (the hub is the only store). */
function fromAnswers(qs: SchoolQuestion[], answers: SchoolAnswer[] | undefined): Record<string, Draft> {
  const out: Record<string, Draft> = {};
  const byId = new Map((answers ?? []).map((a) => [a.question_id, a]));
  for (const q of qs) {
    const a = byId.get(q.id);
    if (!a || a.status === "skipped") continue;
    if (a.status === "dont_know") out[q.id] = { ...blank(), mark: "dont_know" };
    else if (q.type === "free_text") out[q.id] = { ...blank(), text: a.text };
    else if (!a.selected_option_ids.length && a.text) out[q.id] = { ...blank(), text: a.text, custom: true };
    else out[q.id] = { ...blank(), sel: a.selected_option_ids };
  }
  return out;
}

type Sync = "saved" | "saving" | "offline";

/* ------------------------------------------------------------------- timer */

const clock = (sec: number) => {
  const s = Math.max(0, Math.ceil(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(r)}` : `${two(m)}:${two(r)}`;
};

/* ------------------------------------------------------------------ choice */

function Choice({ kind, name, checked, onChange, children }: { kind: "radio" | "checkbox"; name: string; checked: boolean; onChange: () => void; children: ReactNode }) {
  const labelId = useId();
  return <label className={`ss-choice${checked ? " is-checked" : ""}`}>
    {kind === "radio" ? <md-radio name={name} checked={checked} aria-labelledby={labelId} onchange={onChange} /> : <md-checkbox checked={checked} aria-labelledby={labelId} onchange={onChange} />}
    <div id={labelId} className="ss-choice-label">{children}</div>
  </label>;
}

/* ------------------------------------------------------------------ runner */

/** The quiz in progress: one question at a time, a countdown on the hub's clock, auto-submit at zero. */
export function QuizRunner({ item, started, serverGap, onDone }: { item: StudentItem; started: StartedAttempt; serverGap: number; onDone: (r: AttemptResult, questions: SchoolQuestion[]) => void }) {
  const qs = started.questions;
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => fromAnswers(qs, started.answers));
  const [step, setStep] = useState(() => Math.min(Math.max(0, started.position ?? 0), qs.length - 1));
  const [sync, setSync] = useState<Sync>("saved");
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const stepRef = useRef(step);
  stepRef.current = step;
  const ver = useRef(0);
  const fails = useRef(0);
  const done = useRef(false);
  const heading = useRef<HTMLDivElement>(null);
  const dirty = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // ends_at is on the hub's clock; gap = hub time minus device time, measured when the attempt was fetched
  const endsAt = started.ends_at;
  const left = endsAt == null ? null : (endsAt - (now + serverGap)) / 1000;

  const finish = useCallback(async (auto: boolean) => {
    if (done.current) return;
    done.current = true;
    setBusy(true);
    setError("");
    clearTimeout(dirty.current);
    const answers = toAnswers(qs, draftsRef.current);
    for (let tries = 0; ; tries++) {
      try {
        const r = await school.submit(item.id, answers, auto);
        onDone(r, qs);
        return;
      } catch (e) {
        const code = (e as { status?: number }).status;
        if (code === 409) { // the hub already closed the attempt (time ran out elsewhere): show what it recorded
          const last = (await school.attempts(item.id).catch(() => [])).at(-1);
          if (last) { onDone(last, qs); return; }
        }
        if (code && code !== 0 && code < 500) { done.current = false; setBusy(false); setError(describe(e)); return; }
        if (!auto && tries >= 1) { done.current = false; setBusy(false); setError(describe(e)); return; }
        await new Promise((r) => setTimeout(r, 1500)); // timer submit and network errors retry until the hub answers
      }
    }
  }, [item.id, qs, onDone]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  useEffect(() => { if (left != null && left <= 0) void finish(true); }, [left, finish]);

  // every change is sent to the hub (debounced); failures retry with backoff, nothing is kept in the browser
  const save = useCallback(async () => {
    if (done.current) return;
    clearTimeout(dirty.current);
    const v = ver.current;
    setSync("saving");
    try {
      await school.draft(item.id, toAnswers(qs, draftsRef.current), stepRef.current);
      fails.current = 0;
      if (ver.current === v) setSync("saved"); else dirty.current = setTimeout(() => void save(), 300);
    } catch (e) {
      if ((e as { status?: number }).status === 409) { void finish(true); return; }
      fails.current++;
      setSync("offline");
      dirty.current = setTimeout(() => void save(), Math.min(30000, 1000 * 2 ** Math.min(fails.current, 5)));
    }
  }, [item.id, qs, finish]);
  const touch = useCallback((delay = 800) => {
    ver.current++;
    setSync("saving");
    clearTimeout(dirty.current);
    dirty.current = setTimeout(() => void save(), delay);
  }, [save]);
  const change = (qid: string, patch: Partial<Draft>) => {
    setDrafts((d) => ({ ...d, [qid]: { ...(d[qid] ?? blank()), ...patch } }));
    touch();
  };
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } touch(400); }, [step, touch]);
  useEffect(() => {
    const flush = () => { if (document.visibilityState === "hidden" && ver.current > 0 && !done.current) void save(); };
    const online = () => { if (!done.current && fails.current > 0) void save(); };
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("online", online);
    return () => { document.removeEventListener("visibilitychange", flush); window.removeEventListener("online", online); clearTimeout(dirty.current); };
  }, [save]);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [step, review]);

  const states = qs.map((q) => stateOf(q, drafts[q.id]));
  const filled = states.filter((s) => s !== "empty").length;
  const q = qs[step];
  const d = drafts[q.id] ?? blank();
  const last = step === qs.length - 1;
  const toggle = (oid: string) => {
    if (q.type === "multiple_choice") change(q.id, { mark: null, custom: false, sel: d.sel.includes(oid) && !d.custom ? d.sel.filter((x) => x !== oid) : [...(d.custom ? [] : d.sel), oid] });
    else change(q.id, { mark: null, custom: false, sel: [oid] });
  };
  const mark = (m: "dont_know" | "skipped") => {
    change(q.id, { mark: d.mark === m ? null : m });
    if (d.mark !== m) last ? setReview(true) : setStep(step + 1);
  };
  const kind = q.type === "multiple_choice" ? "checkbox" : "radio";
  const urgent = left != null && left <= 60;

  return <section className="ss-run" aria-label={item.title} data-ss-run>
    <header className="ss-run-head">
      <h2 className="ss-run-title">{item.title}</h2>
      <span className={`ss-sync is-${sync}`} role="status" data-ss-sync>{sync === "saved" ? t("сохранено") : sync === "saving" ? t("сохраняю…") : t("нет связи")}</span>
      {left != null && <div className={`ss-timer${urgent ? " is-urgent" : ""}`} role="timer" aria-label={t("Осталось времени")} data-ss-timer><Timer aria-hidden="true" size={18} /><span>{clock(left)}</span></div>}
    </header>
    <div className="ss-steps" role="group" aria-label={t("Вопросы теста")}>
      {qs.map((qq, i) => <button key={qq.id} type="button" className={`ss-step${!review && i === step ? " is-current" : ""}`} data-answer-state={states[i]}
        aria-label={t("Вопрос {0}: {1}", [i + 1, t(STATE_LABEL[states[i]])])} aria-current={!review && i === step ? "step" : undefined} onClick={() => { setReview(false); setStep(i); }}>{i + 1}</button>)}
    </div>
    {error && <p role="alert" className="ss-alert">{error}</p>}
    {review ? <div className="ss-card">
      <div role="heading" aria-level={3} ref={heading} tabIndex={-1} className="ss-q-title">{t("Обзор · заполнено")} {filled} {t("из")} {qs.length}</div>
      <ul className="ss-review">
        {qs.map((qq, i) => <li key={qq.id}>
          <span className="ss-review-n">{i + 1}</span>
          <div className="ss-review-text"><Markdown text={qq.prompt} className="md-ui" /><span className={`ss-review-state${states[i] === "empty" ? " is-empty" : ""}`}>{t(STATE_LABEL[states[i]])}</span></div>
          <Button variant="secondary" type="button" onClick={() => { setReview(false); setStep(i); }}>{t("Изменить")}</Button>
        </li>)}
      </ul>
      <p className="ss-hint">{t("После отправки ответы изменить нельзя.")}{filled < qs.length ? " " + t("Без ответа: {0}.", [qs.length - filled]) : ""}</p>
    </div> : <div className="ss-card">
      <div className="ss-q-count">{t("Вопрос")} {step + 1} {t("из")} {qs.length}</div>
      <div role="heading" aria-level={3} ref={heading} tabIndex={-1} className="ss-q-title"><Markdown rich text={q.prompt} className="md-ui" /></div>
      {q.type === "free_text" ? <Textarea aria-label={t("Ваш ответ")} rows={5} value={d.text} disabled={d.mark !== null} placeholder={t("Ответьте своими словами")} className="material-field" onInput={(e) => change(q.id, { text: e.currentTarget.value, mark: null })} />
        : <fieldset className="ss-choices">
          <legend className="sr-only">{q.prompt}</legend>
          {(q.options ?? []).map((o) => <Choice key={o.id} kind={kind} name={`${item.id}-${q.id}`} checked={d.mark === null && !d.custom && d.sel.includes(o.id)} onChange={() => toggle(o.id)}><Markdown rich text={o.label} className="md-ui" /></Choice>)}
          {q.allow_custom_answer && <Choice kind={kind} name={`${item.id}-${q.id}`} checked={d.mark === null && d.custom} onChange={() => change(q.id, { mark: null, custom: true, sel: [] })}>
            {d.custom && d.mark === null ? <Field type="text" autoFocus aria-label={t("Свой ответ")} placeholder={t("Свой ответ…")} value={d.text} className="material-field" onInput={(e) => change(q.id, { text: e.currentTarget.value })} /> : <span className="ss-muted">{t("Свой ответ…")}</span>}
          </Choice>}
        </fieldset>}
      {d.mark && <p className="ss-hint">{d.mark === "dont_know" ? t("Отмечено «Не знаю».") : t("Вопрос пропущен.")} {t("Чтобы ответить, выберите вариант или введите текст.")}</p>}
    </div>}
    <footer className="ss-run-foot">
      {review ? <>
        <Button variant="secondary" type="button" onClick={() => { setReview(false); setStep(qs.length - 1); }}>{t("К вопросам")}</Button>
        <span className="ss-grow" />
        <Button variant="primary" type="button" disabled={busy} onClick={() => void finish(false)} data-ss-submit>{busy ? t("Отправляю…") : t("Сдать работу")}</Button>
      </> : <>
        <Button variant="secondary" type="button" aria-pressed={d.mark === "dont_know"} onClick={() => mark("dont_know")}>{t("Не знаю")}</Button>
        <Button variant="secondary" type="button" aria-pressed={d.mark === "skipped"} onClick={() => mark("skipped")}>{t("Пропустить")}</Button>
        <span className="ss-grow" />
        <Button variant="secondary" type="button" disabled={step === 0} onClick={() => setStep(step - 1)}>{t("Назад")}</Button>
        <Button variant="primary" type="button" onClick={() => (last ? setReview(true) : setStep(step + 1))}>{last ? t("Обзор") : t("Далее")}</Button>
      </>}
    </footer>
    {busy && <p className="ss-hint" role="status">{left != null && left <= 0 ? t("Время вышло, отправляю ответы…") : t("Отправляю ответы…")}</p>}
  </section>;
}

/* ------------------------------------------------------------------ result */

/** Score line of an attempt: «Решено 7 из 10» with the pending note. */
export const scoreLine = (r: Pick<AttemptResult, "score" | "max" | "pending">) =>
  t("{0} из {1}", [r.score, r.max]) + (r.pending ? "; " + t("на проверке: {0}", [r.pending]) : "");

export function AttemptSummary({ r, questions: given0, showAnswersHint }: { r: AttemptResult; questions?: SchoolQuestion[]; showAnswersHint?: string }) {
  const questions = given0 ?? r.questions;
  const byQ = useMemo(() => new Map(r.results.map((x) => [x.question_id, x])), [r]);
  const given = useMemo(() => new Map((r.answers ?? []).map((a) => [a.question_id, a])), [r]);
  const label = (q: SchoolQuestion, ids: string[]) => ids.map((id) => q.options?.find((o) => o.id === id)?.label ?? id).join("; ");
  return <div className="ss-result" data-ss-result>
    <div className="ss-score" role="status"><strong>{t("{0} из {1}", [r.score, r.max])}</strong><span>{t("верных ответов")}</span></div>
    {r.pending > 0 && <p className="ss-note"><Hourglass aria-hidden="true" size={16} />{t("Ответов на проверке у учителя: {0}. Итог может измениться.", [r.pending])}</p>}
    {r.auto && <p className="ss-note"><WarningCircle aria-hidden="true" size={16} />{t("Время вышло: отправлены ответы, которые вы успели дать.")}</p>}
    <p className="ss-hint">{r.submitted_at ? t("Сдано {0}", [fmtDateTime(r.submitted_at)]) : ""}{r.duration_sec != null ? " · " + t("затрачено {0}", [fmtDuration(r.duration_sec)]) : ""}</p>
    {r.results.length === 0 && <p className="ss-hint">{showAnswersHint ?? t("Разбор ответов откроется по условию, заданному учителем.")}</p>}
    {questions && questions.length > 0 && <ol className="ss-breakdown">
      {questions.map((q) => {
        const res = byQ.get(q.id), a = given.get(q.id);
        const mine = !a || a.status !== "answered" ? (a?.status === "dont_know" ? t("Не знаю") : t("Нет ответа")) : q.type === "free_text" || (!a.selected_option_ids.length && a.text) ? a.text : label(q, a.selected_option_ids);
        return <li key={q.id} data-correct={String(res?.correct)}>
          <span className="ss-mark" aria-hidden="true">{!res ? null : res.correct === true ? <CheckCircle size={20} weight="fill" /> : res.correct === false ? <XCircle size={20} weight="fill" /> : <Hourglass size={20} />}</span>
          <div className="ss-break-body">
            <Markdown text={q.prompt} className="md-ui" />
            <p className="ss-given"><span>{t("Ваш ответ")}:</span> {mine}</p>
            {res?.correct === null && <p className="ss-hint">{t("Проверяет учитель")}</p>}
            {res?.correct !== true && res?.correct_option_ids && res.correct_option_ids.length > 0 && <p className="ss-given"><span>{t("Верно")}:</span> {label(q, res.correct_option_ids)}</p>}
            {res?.explanation && <Markdown text={res.explanation} className="md-ui ss-expl" />}
          </div>
        </li>;
      })}
    </ol>}
  </div>;
}
