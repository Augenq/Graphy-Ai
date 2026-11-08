import { useCallback, useEffect, useMemo, useState } from "react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { Button, IconButton } from "./ui/index";
import { describe } from "../lib/api";
import { locale, t } from "../lib/i18n";
import {
  createEvent, days as fmtDays, deleteEvent, downloadIcs, loadCalendar, monthGrid, parseYmd, ymd,
  type CalendarDay, type CalendarResult, type DueResult, type EventKind, type StudyEvent,
} from "../lib/study-api";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const KIND_LABEL: Record<EventKind, string> = { exam: "Экзамен", session: "Занятие", note: "Заметка" };

/** Month grid with review counts and the learner's events, a day panel, and exam countdowns. */
export function StudyCalendar({ due, busy, onReview, onChanged }: { due: DueResult | null; busy: boolean; onReview: () => void; onChanged: () => void }) {
  const now = new Date();
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [selected, setSelected] = useState(ymd(now));
  const [cal, setCal] = useState<CalendarResult | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const grid = useMemo(() => monthGrid(cursor.y, cursor.m), [cursor]);
  useEffect(() => {
    let live = true;
    loadCalendar(grid[0].date, grid[41].date).then(r => { if (live) { setCal(r); setError(""); } }, e => { if (live) setError(describe(e)); });
    return () => { live = false; };
  }, [grid, tick]);
  const byDate = useMemo(() => new Map((cal?.days ?? []).map(d => [d.date, d])), [cal]);
  const today = cal?.today ?? ymd(now);
  const refresh = useCallback(() => { setTick(n => n + 1); onChanged(); }, [onChanged]);
  const month = new Intl.DateTimeFormat(locale(), { month: "long", year: "numeric" }).format(new Date(cursor.y, cursor.m, 1)).replace(/^./, c => c.toUpperCase());
  const weekdays = useMemo(() => Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(locale(), { weekday: "short" }).format(new Date(2024, 0, 1 + i))), [locale()]);
  const step = (n: number) => { const d = new Date(cursor.y, cursor.m + n, 1); setCursor({ y: d.getFullYear(), m: d.getMonth() }); };
  const goToday = () => { setCursor({ y: now.getFullYear(), m: now.getMonth() }); setSelected(ymd(now)); };
  const day = byDate.get(selected);
  return <div className="study-calendar" data-calendar>
    {error && <div className="study-error" role="alert"><span>{error}</span></div>}
    {cal && cal.exam_countdown.length > 0 && <ul className="study-countdown" aria-label={t("До экзаменов")}>
      {cal.exam_countdown.slice(0, 3).map(e => <li key={e.id} className="study-count-card" data-exam={e.id}>
        <span className="study-count-days">{e.days_left === 0 ? t("Сегодня") : fmtDays(e.days_left)}</span>
        <span className="study-count-title">{e.title}</span>
        {e.reviews_before > 0 && <span className="study-muted">{t("К повторению до него: {0}", [e.reviews_before])}</span>}
      </li>)}
    </ul>}
    <div className="study-cal-layout">
      <div className="study-month">
        <div className="study-month-bar">
          <h2 className="study-h2 study-month-title" aria-live="polite">{month}</h2>
          <span className="study-spacer" />
          <Button variant="ghost" onClick={goToday}>{t("Сегодня")}</Button>
          <IconButton aria-label={t("Предыдущий месяц")} onClick={() => step(-1)}><CaretLeft aria-hidden="true" /></IconButton>
          <IconButton aria-label={t("Следующий месяц")} onClick={() => step(1)}><CaretRight aria-hidden="true" /></IconButton>
        </div>
        <div className="study-grid" role="grid" aria-label={month}>
          <div className="study-grid-row" role="row">{weekdays.map(w => <span key={w} className="study-weekday" role="columnheader">{w}</span>)}</div>
          {[0, 1, 2, 3, 4, 5].map(r => <div key={r} className="study-grid-row" role="row">
            {grid.slice(r * 7, r * 7 + 7).map(c => {
              const d = byDate.get(c.date);
              const label = new Intl.DateTimeFormat(locale(), { day: "numeric", month: "long" }).format(parseYmd(c.date));
              const info = [d?.reviews.count ? t("к повторению: {0}", [d.reviews.count]) : "", d?.events.length ? t("событий: {0}", [d.events.length]) : ""].filter(Boolean).join(", ");
              return <button key={c.date} type="button" role="gridcell" className="study-cell" data-date={c.date}
                data-out={c.inMonth ? undefined : ""} data-today={c.date === today ? "" : undefined} aria-selected={c.date === selected}
                data-has-exam={d?.events.some(e => e.kind === "exam") ? "" : undefined}
                aria-label={info ? `${label}: ${info}` : label} onClick={() => setSelected(c.date)}>
                <span className="study-cell-num">{parseYmd(c.date).getDate()}</span>
                {d && <span className="study-cell-marks" aria-hidden="true">
                  {d.reviews.count > 0 && <span className="study-mark-review">{d.reviews.count}</span>}
                  {d.events.slice(0, 3).map(e => <span key={e.id} className="study-mark-event" data-kind={e.kind} />)}
                </span>}
              </button>;
            })}
          </div>)}
        </div>
        <div className="study-cal-actions">
          <Button variant="ghost" disabled={busy || !due || due.total_due === 0} onClick={onReview}>{t("Повторить сейчас")}</Button>
          <Button variant="ghost" onClick={() => void downloadIcs().catch(e => setError(describe(e)))}>{t("Экспорт в календарь (.ics)")}</Button>
        </div>
      </div>
      <DayPanel date={selected} day={day} today={today} onChanged={refresh} />
    </div>
  </div>;
}

function DayPanel({ date, day, today, onChanged }: { date: string; day?: CalendarDay; today: string; onChanged: () => void }) {
  const [kind, setKind] = useState<EventKind>("exam");
  const [title, setTitle] = useState("");
  const [time, setTime] = useState("");
  const [error, setError] = useState("");
  const label = new Intl.DateTimeFormat(locale(), { weekday: "long", day: "numeric", month: "long" }).format(parseYmd(date));
  const submit = async () => {
    setError("");
    try {
      await createEvent({ kind, date, title: title.trim(), ...(time ? { time } : {}) });
      setTitle("");
      setTime("");
      onChanged();
    } catch (e) { setError(describe(e)); }
  };
  const remove = async (e: StudyEvent) => {
    try { await deleteEvent(e.id); onChanged(); } catch (x) { setError(describe(x)); }
  };
  return <aside className="study-day" aria-label={t("День: {0}", [label])} data-day-panel>
    <h3 className="study-h3">{cap(label)}{date === today ? ` · ${t("сегодня")}` : ""}</h3>
    {day && day.reviews.count > 0 && <section aria-label={t("Повторение")}>
      <p className="study-day-line"><b>{t("Пора освежить")}</b>: {t("задач {0}", [day.reviews.count])}</p>
      <ul className="study-day-topics">{day.reviews.topics.map(x => <li key={`${x.course_id}/${x.topic}`}>{x.topic} <span className="study-muted">· {x.count}</span></li>)}</ul>
    </section>}
    {day && day.events.length > 0 && <ul className="study-events" aria-label={t("События")}>
      {day.events.map(e => <li key={e.id} className="study-event" data-kind={e.kind}>
        <span className="study-mark-event" data-kind={e.kind} aria-hidden="true" />
        <span className="study-event-text"><b>{t(KIND_LABEL[e.kind])}</b>{e.time ? ` · ${e.time}` : ""}<br />{e.title}</span>
        <IconButton aria-label={t("Удалить событие «{0}»", [e.title])} onClick={() => void remove(e)}><md-icon aria-hidden="true">delete</md-icon></IconButton>
      </li>)}
    </ul>}
    {!(day && (day.reviews.count > 0 || day.events.length > 0)) && <p className="study-muted">{t("На этот день ничего не запланировано.")}</p>}
    <form className="study-form" onSubmit={e => { e.preventDefault(); if (title.trim()) void submit(); }} aria-label={t("Новое событие")}>
      <div className="study-kinds" role="radiogroup" aria-label={t("Тип события")}>
        {(["exam", "session", "note"] as const).map(k => <button key={k} type="button" role="radio" aria-checked={kind === k} className="study-kind" onClick={() => setKind(k)}>{t(KIND_LABEL[k])}</button>)}
      </div>
      <input className="study-input" value={title} onChange={e => setTitle(e.target.value)} placeholder={kind === "exam" ? t("Например: экзамен по алгебре") : t("Название")} aria-label={t("Название события")} maxLength={200} />
      <label className="study-time"><span>{t("Время (необязательно)")}</span><input className="study-input" type="time" value={time} onChange={e => setTime(e.target.value)} /></label>
      <Button type="submit" disabled={!title.trim()}>{t("Добавить")}</Button>
      {error && <p className="study-error-text" role="alert">{error}</p>}
    </form>
  </aside>;
}
