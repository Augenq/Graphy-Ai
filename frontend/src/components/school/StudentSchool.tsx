import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, BookOpenText, ListChecks, Clock, CaretRight, Timer } from "@phosphor-icons/react";
import { t } from "../../lib/i18n";
import { describe } from "../../lib/api";
import { fmtDateTime, fmtDuration, school, type AttemptResult, type SchoolQuestion, type StartedAttempt, type StudentItem } from "../../lib/school";
import { Button } from "../ui/index";
import { StudentMaterial } from "./StudentMaterial";
import { AttemptSummary, QuizRunner, scoreLine } from "./StudentQuiz";

/* ----------------------------------------------------------------- status */

type Tone = "todo" | "doing" | "done" | "late" | "info";
function statusOf(i: StudentItem): { text: string; tone: Tone } {
  switch (i.status) {
    case "in_progress": return { text: t("В процессе"), tone: "doing" };
    case "submitted": return { text: i.best ? t("Сдано {0}", [scoreLine(i.best)]) : t("Сдано"), tone: "done" };
    case "missed": return { text: t("Просрочено"), tone: "late" };
    case "material": return { text: t("Материал"), tone: "info" };
    default: return { text: t("Не начато"), tone: "todo" };
  }
}
const finished = (i: StudentItem) => i.status === "submitted" || i.status === "missed";

/** Open work first (nearest deadline on top, no deadline after), then what is done or missed (latest deadline first). */
export function sortItems(items: StudentItem[]): StudentItem[] {
  const rank = (i: StudentItem) => (finished(i) ? 1 : 0);
  return [...items].sort((a, b) => rank(a) - rank(b)
    || (rank(a) === 0 ? (a.deadline ?? Infinity) - (b.deadline ?? Infinity) : (b.deadline ?? -Infinity) - (a.deadline ?? -Infinity))
    || b.created - a.created);
}

const deadlineText = (ms: number | null) => (ms == null ? t("Без срока") : t("До {0}", [fmtDateTime(ms)]));
const soon = (i: StudentItem) => i.deadline != null && !finished(i) && i.deadline - Date.now() < 86_400_000;

function ItemRow({ item, onOpen }: { item: StudentItem; onOpen: () => void }) {
  const st = statusOf(item);
  const Icon = item.kind === "quiz" ? ListChecks : BookOpenText;
  return <li>
    <button type="button" className="ss-row" data-ss-item={item.id} onClick={onOpen}>
      <span className="ss-row-icon" aria-hidden="true"><Icon size={22} /></span>
      <span className="ss-row-main">
        <span className="ss-row-title">{item.title}</span>
        <span className="ss-row-meta">{item.class_title}{item.teacher_name ? ` · ${item.teacher_name}` : ""}</span>
        <span className="ss-row-meta"><span className={soon(item) || item.status === "missed" ? "ss-late" : undefined}><Clock aria-hidden="true" size={13} /> {deadlineText(item.deadline)}</span>
          {item.kind === "quiz" && item.quiz?.settings.time_limit_sec ? <span> · <Timer aria-hidden="true" size={13} /> {fmtDuration(item.quiz.settings.time_limit_sec)}</span> : null}</span>
      </span>
      <span className="ss-badge" data-tone={st.tone}>{st.text}</span>
      <CaretRight aria-hidden="true" size={16} className="ss-chev" />
    </button>
  </li>;
}

/* ------------------------------------------------------------------- quiz */

type Phase = { k: "info" } | { k: "run"; started: StartedAttempt; gap: number } | { k: "result"; r: AttemptResult; questions: SchoolQuestion[] };

function QuizPage({ item, reload }: { item: StudentItem; reload: () => void }) {
  const [phase, setPhase] = useState<Phase>({ k: "info" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [past, setPast] = useState<AttemptResult[]>([]);
  const settings = item.quiz?.settings;
  useEffect(() => { if (phase.k === "info") school.attempts(item.id).then(setPast, () => undefined); }, [item.id, item.status, phase.k]);

  const closed = item.deadline != null && Date.now() > item.deadline;
  const noAttempts = (item.attempts_left ?? 1) <= 0;
  const resuming = item.status === "in_progress";
  const blocked = !resuming && (closed || noAttempts);

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const sent = Date.now();
      const s = await school.start(item.id);
      // the hub stamped server_time somewhere inside the round trip: assume the middle
      const gap = s.server_time - (sent + Date.now()) / 2;
      setPhase({ k: "run", started: s, gap });
      reload();
    } catch (e) {
      setError(describe(e));
      reload();
    } finally { setBusy(false); }
  };
  const done = useCallback((r: AttemptResult, questions: SchoolQuestion[]) => { setPhase({ k: "result", r, questions }); reload(); }, [reload]);

  if (phase.k === "run") return <QuizRunner item={item} started={phase.started} serverGap={phase.gap} onDone={done} />;
  if (phase.k === "result") return <div className="ss-card">
    <h3 className="ss-h3">{t("Работа сдана")}</h3>
    <AttemptSummary r={phase.r} questions={phase.questions} showAnswersHint={settings?.show_answers === "never" ? t("Учитель не показывает разбор ответов.") : settings?.show_answers === "after_deadline" ? t("Разбор ответов откроется после дедлайна.") : undefined} />
    <div className="ss-actions"><Button variant="secondary" type="button" onClick={() => setPhase({ k: "info" })}>{t("К заданию")}</Button></div>
  </div>;

  const hide = settings?.show_answers === "never" ? t("Учитель не показывает разбор ответов.") : settings?.show_answers === "after_deadline" ? t("Разбор ответов откроется после дедлайна.") : undefined;
  return <>
    <dl className="ss-facts">
      <div><dt>{t("Вопросов")}</dt><dd>{item.quiz?.question_count ?? "—"}</dd></div>
      <div><dt>{t("Время")}</dt><dd>{settings?.time_limit_sec ? fmtDuration(settings.time_limit_sec) : t("не ограничено")}</dd></div>
      <div><dt>{t("Срок сдачи")}</dt><dd className={closed ? "ss-late" : undefined}>{item.deadline == null ? t("без срока") : fmtDateTime(item.deadline)}</dd></div>
      <div><dt>{t("Попыток осталось")}</dt><dd>{item.attempts_left ?? settings?.attempts ?? "—"}{settings ? ` ${t("из")} ${settings.attempts}` : ""}</dd></div>
    </dl>
    {settings?.time_limit_sec ? <p className="ss-hint">{t("Время идёт с нажатия «Начать». Когда оно закончится, уже данные ответы отправятся автоматически.")}</p> : null}
    {error && <p role="alert" className="ss-alert">{error}</p>}
    {blocked && <p role="status" className="ss-alert">{closed ? t("Срок сдачи прошёл: начать тест нельзя.") : t("Попыток не осталось.")}</p>}
    <div className="ss-actions"><Button variant="primary" type="button" disabled={busy || blocked} onClick={() => void start()} data-ss-start>
      {busy ? t("Загрузка…") : resuming ? t("Продолжить") : past.length ? t("Начать заново") : t("Начать")}</Button></div>
    {past.length > 0 && <section className="ss-past" aria-label={t("Ваши попытки")}>
      <h3 className="ss-h3">{t("Ваши попытки")}</h3>
      {past.filter((a) => a.submitted_at).map((a) => <details key={a.attempt} className="ss-attempt">
        <summary><span>{t("Попытка {0}", [a.attempt])} · {fmtDateTime(a.submitted_at)}</span><strong>{scoreLine(a)}</strong></summary>
        <AttemptSummary r={a} showAnswersHint={hide} />
      </details>)}
    </section>}
  </>;
}

/* ----------------------------------------------------------------- detail */

function Detail({ item, onBack, reload }: { item: StudentItem; onBack: () => void; reload: () => void }) {
  const st = statusOf(item);
  return <div className="ss-detail" data-ss-detail>
    <button type="button" className="ss-back" onClick={onBack}><ArrowLeft aria-hidden="true" size={18} />{t("Все задания")}</button>
    <header className="ss-detail-head">
      <h2 className="ss-title">{item.title}</h2>
      <p className="ss-row-meta">{item.class_title}{item.teacher_name ? ` · ${item.teacher_name}` : ""}</p>
      <div className="ss-detail-line"><span className="ss-badge" data-tone={st.tone}>{st.text}</span><span className={soon(item) || item.status === "missed" ? "ss-late" : "ss-row-meta"}><Clock aria-hidden="true" size={13} /> {deadlineText(item.deadline)}</span></div>
    </header>
    {item.description && <section className="ss-task"><h3 className="ss-h3">{t("Что нужно сделать")}</h3><p className="ss-desc selectable">{item.description}</p></section>}
    {item.kind === "material" ? <StudentMaterial id={item.id} title={item.title} /> : <QuizPage item={item} reload={reload} />}
  </div>;
}

/* ------------------------------------------------------------------- list */

export function StudentSchool() {
  const [items, setItems] = useState<StudentItem[] | null>(null);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const load = useCallback(() => school.my().then((x) => { setItems(x); setError(""); }, (e) => setError(describe(e))), []);
  useEffect(() => {
    void load();
    const again = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, [load]);
  const sorted = useMemo(() => sortItems(items ?? []), [items]);
  const open = openId ? items?.find((i) => i.id === openId) : undefined;
  const upcoming = sorted.filter((i) => !finished(i)), closed = sorted.filter(finished);

  if (open) return <Detail item={open} onBack={() => setOpenId(null)} reload={() => void load()} />;
  return <div className="ss-list" data-ss-list>
    <h2 className="ss-title">{t("Школа")}</h2>
    {error && <p role="alert" className="ss-alert">{error} <button type="button" className="ss-link" onClick={() => void load()}>{t("Повторить")}</button></p>}
    {items === null && !error && <p className="ss-hint" role="status">{t("Загружаю задания…")}</p>}
    {items?.length === 0 && <div className="ss-empty" data-ss-empty><BookOpenText aria-hidden="true" size={40} weight="light" /><strong>{t("Заданий пока нет")}</strong><span>{t("Здесь появятся материалы и тесты от учителей ваших классов.")}</span></div>}
    {upcoming.length > 0 && <section aria-label={t("Нужно сделать")}><h3 className="ss-h3">{t("Нужно сделать")}</h3><ul className="ss-items">{upcoming.map((i) => <ItemRow key={i.id} item={i} onOpen={() => setOpenId(i.id)} />)}</ul></section>}
    {closed.length > 0 && <section aria-label={t("Завершённые")}><h3 className="ss-h3">{t("Завершённые")}</h3><ul className="ss-items">{closed.map((i) => <ItemRow key={i.id} item={i} onOpen={() => setOpenId(i.id)} />)}</ul></section>}
  </div>;
}
