import { useEffect, useState } from "react";
import { describe } from "../lib/api";
import { t } from "../lib/i18n";
import { newSession, openSession, send } from "../lib/engine";
import { clock, fetchReport, secondsLeft, type QuizReportData } from "../lib/mode-api";
import { isBusy, type Session } from "../lib/types";
import { QuizReport } from "./QuizReport";

const FINISH = "Заверши проверку и покажи отчёт.";

/** Header chip of a quiz session: kind, timer, report. The timer only advises: late answers are flagged. */
export function QuizBar({ session }: { session: Session }) {
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<QuizReportData | null>(null);
  const [error, setError] = useState("");
  const left = secondsLeft(session.deadline, now);
  const over = left !== null && left <= 0;
  useEffect(() => {
    if (left === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [left === null]);
  const show = async () => {
    const next = !open;
    setOpen(next);
    if (!next) return;
    try { setReport(await fetchReport(session.id, t("Без темы"))); setError(""); } catch (e) { setError(describe(e)); }
  };
  const learn = async (topic: string) => {
    try {
      const id = await newSession(session.explanationStyle);
      await openSession(id);
      void send(id, t("Давай разберём тему: {0}. Начни с того, что в ней у меня не получилось.", [topic]));
    } catch (e) { setError(describe(e)); }
  };
  const kind = t("Проверка");
  return <div className="quiz-bar relative" data-quiz-bar>
    <span className={`quiz-chip${over ? " late" : ""}`}>
      <md-icon aria-hidden="true">quiz</md-icon>
      <span>{kind}</span>
      {left !== null && <span className="quiz-timer tabular-nums" role="timer" data-quiz-timer
        aria-label={over ? t("Время вышло") : t("Осталось {0}", [clock(left)])}>{clock(left)}</span>}
    </span>
    {over && <span className="quiz-note" data-quiz-late>{t("Срок прошёл: ответы отметим как поздние")}</span>}
    <button type="button" className="quiz-action" data-quiz-finish disabled={isBusy(session.agent)} onClick={() => void send(session.id, FINISH)}>{t("Завершить")}</button>
    <button type="button" className="quiz-action" data-quiz-results aria-expanded={open} onClick={() => void show()}>{t("Итоги")}</button>
    {open && <div role="dialog" aria-label={t("Итоги проверки")} className="quiz-popover fade-in absolute right-0 top-full z-30 mt-2 rounded-sheet border border-outline bg-sheet p-4 shadow-pop">
      {error ? <p role="alert">{error}</p> : report ? <QuizReport report={report} onLearn={t => void learn(t)} /> : <p>{t("Загрузка…")}</p>}
    </div>}
  </div>;
}
