import { Button } from "./ui/index";
import { t } from "../lib/i18n";
import { dueText, OUTCOME_LABEL, type DueResult } from "../lib/study-api";

/** What is worth refreshing now: weak topics first. The wording stays calm: nothing is overdue, only ready to refresh. */
export function StudyReview({ due, busy, onReview }: { due: DueResult; busy: boolean; onReview: (courseId?: string) => void }) {
  if (due.total_due === 0) return <div className="study-empty" data-empty>
    <h2 className="study-empty-title">{t("Сейчас всё свежо")}</h2>
    <p className="study-empty-text">{due.upcoming_week > 0
      ? t("На ближайшую неделю запланировано: {0}. Загляните позже.", [due.upcoming_week])
      : t("Решайте задачи на занятиях: они сами появятся здесь, когда придёт время освежить.")}</p>
  </div>;
  const topics = due.topics.filter(x => x.due_count > 0);
  return <div className="study-review" data-review>
    <div className="study-review-head">
      <div>
        <h2 className="study-h2">{t("Пора освежить")}</h2>
        <p className="study-muted">{t("Задач: {0}. Начнём с самых слабых тем, подсказок сразу не будет.", [due.total_due])}</p>
      </div>
      <Button disabled={busy} onClick={() => onReview()} data-review-start>{t("Повторить сейчас")}</Button>
    </div>
    <ul className="study-topics" aria-label={t("Темы")}>
      {topics.map(x => <li key={`${x.course_id}/${x.topic}`} className="study-topic" data-topic={x.topic}>
        <div className="study-topic-main">
          <span className="study-topic-name">{x.topic}</span>
        </div>
        <span className="study-pill" data-weak={x.weak > 0 ? "" : undefined}>{x.weak > 0 ? t("слабое: {0}", [x.weak]) : t("задач: {0}", [x.due_count])}</span>
        <Button variant="ghost" disabled={busy} onClick={() => onReview(x.course_id)} aria-label={t("Повторить тему «{0}»", [x.topic])}>{t("Освежить")}</Button>
      </li>)}
    </ul>
    <h3 className="study-h3">{t("Задачи")}</h3>
    <ul className="study-list" aria-label={t("Задачи к повторению")}>
      {due.items.slice(0, 20).map(i => <li key={i.id} className="study-row" data-item={i.id}>
        <span className="study-chip" data-outcome={i.outcome}>{t(OUTCOME_LABEL[i.outcome])}</span>
        <span className="study-row-text">{i.question}</span>
        <span className="study-muted study-row-meta">{i.topic} · {dueText(i.due_at, due.now)}</span>
      </li>)}
    </ul>
  </div>;
}
