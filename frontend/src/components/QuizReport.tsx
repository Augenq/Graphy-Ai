import { t } from "../lib/i18n";
import type { QuizReportData } from "../lib/mode-api";

/** Per-topic result of a finished quiz and a one-click lesson for the weakest topics. */
export function QuizReport({ report, onLearn }: { report: QuizReportData; onLearn: (topic: string) => void }) {
  if (!report.total) return <p className="quiz-report-empty">{t("Пока нет оценённых ответов. Итоги появятся после первого блока вопросов.")}</p>;
  return <div className="quiz-report" data-quiz-report>
    <p className="quiz-report-score" data-quiz-score>
      {t("Самостоятельно: {0} из {1}", [report.independent, report.total])}
      {report.gap > 0 && ` · ${t("пробелы: {0}", [report.gap])}`}
      {report.other > 0 && ` · ${t("без оценки: {0}", [report.other])}`}
    </p>
    <ul className="quiz-topics" aria-label={t("Результат по темам")}>
      {report.topics.map(x => <li key={x.topic} className="quiz-topic">
        <span className="quiz-topic-name">{x.topic}</span>
        <span className="quiz-topic-bar" role="img" aria-label={t("{0} из {1} самостоятельно", [x.independent, x.total])}>
          <i className="ok" style={{ flex: x.independent }} /><i className="bad" style={{ flex: x.gap }} /><i className="rest" style={{ flex: x.other }} />
        </span>
        <span className="quiz-topic-count tabular-nums">{x.independent}/{x.total}</span>
      </li>)}
    </ul>
    {report.fixFirst.length > 0 && <>
      <h3 className="quiz-fix-title">{t("Что исправить в первую очередь")}</h3>
      <ul className="quiz-fix">
        {report.fixFirst.map(topic => <li key={topic}>
          <span>{topic}</span>
          <button type="button" className="quiz-learn" data-quiz-learn onClick={() => onLearn(topic)}>{t("Учиться: {0}", [topic])}</button>
        </li>)}
      </ul>
    </>}
  </div>;
}
