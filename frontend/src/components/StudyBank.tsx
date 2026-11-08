import { useEffect, useState } from "react";
import { Button, IconButton } from "./ui/index";
import { describe } from "../lib/api";
import { t } from "../lib/i18n";
import { dueText, loadBank, OUTCOME_LABEL, updateItem, type BankFilter, type BankItem, type BankResult } from "../lib/study-api";

/** The bank of tasks the tutor gave and the learner answered, with the learner's own tags, notes, pause and removal. */
export function StudyBank({ now, busy, onReview, onChanged }: { now: number; busy: boolean; onReview: () => void; onChanged: () => void }) {
  const [filter, setFilter] = useState<BankFilter>({});
  const [bank, setBank] = useState<BankResult | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const set = (patch: BankFilter) => setFilter(f => ({ ...f, ...patch }));
  useEffect(() => {
    let live = true;
    const wait = setTimeout(() => {
      loadBank(filter).then(r => { if (live) { setBank(r); setError(""); } }, e => { if (live) setError(describe(e)); });
    }, filter.q ? 200 : 0);
    return () => { live = false; clearTimeout(wait); };
  }, [filter, tick]);
  const changed = () => { setTick(n => n + 1); onChanged(); };
  const f = bank?.facets;
  const select = (label: string, key: keyof BankFilter, options: { value: string; label: string; count?: number }[], any = t("Все")) =>
    <label className="study-filter"><span>{label}</span>
      <select className="study-select" value={filter[key] ?? ""} onChange={e => set({ [key]: e.target.value || undefined })} aria-label={label}>
        <option value="">{any}</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.count === undefined ? o.label : `${o.label} (${o.count})`}</option>)}
      </select>
    </label>;
  return <div className="study-bank" data-bank>
    <div className="study-filters" role="search">
      <input className="study-input study-search" type="search" value={filter.q ?? ""} onChange={e => set({ q: e.target.value || undefined })}
        placeholder={t("Поиск по задачам")} aria-label={t("Поиск по задачам")} />
      {f && select(t("Тема"), "topic", f.topics.map(c => ({ value: c.topic, label: c.topic, count: c.count })))}
      {f && select(t("Результат"), "outcome", f.outcomes.map(c => ({ value: c.outcome, label: t(OUTCOME_LABEL[c.outcome]), count: c.count })))}
      {f && f.tags.length > 0 && select(t("Метка"), "tag", f.tags.map(c => ({ value: c.tag, label: c.tag, count: c.count })))}
      {f && f.error_types.length > 0 && select(t("Тип ошибки"), "error_type", f.error_types.map(c => ({ value: c.error_type, label: c.error_type, count: c.count })))}
      {select(t("Показать"), "state", [{ value: "suspended", label: t("Отложенные") }, { value: "all", label: t("Все, с отложенными") }], t("Активные"))}
    </div>
    {error && <div className="study-error" role="alert"><span>{error}</span></div>}
    {bank && bank.items.length === 0 && <div className="study-empty" data-empty>
      <h2 className="study-empty-title">{bank.total === 0 && !hasFilter(filter) ? t("Банк пока пуст") : t("Ничего не найдено")}</h2>
      <p className="study-empty-text">{hasFilter(filter) ? t("Попробуйте убрать часть фильтров.") : t("Задачи, на которые вы ответили на занятиях, появятся здесь.")}</p>
      {hasFilter(filter) && <Button variant="ghost" onClick={() => setFilter({})}>{t("Сбросить фильтры")}</Button>}
    </div>}
    {bank && bank.items.length > 0 && <>
      <div className="study-bank-bar">
        <span className="study-muted" role="status">{t("Задач: {0}", [bank.total])}</span>
        <Button variant="ghost" disabled={busy} onClick={onReview}>{t("Повторить слабое")}</Button>
      </div>
      <ul className="study-list" aria-label={t("Банк задач")}>
        {bank.items.map(i => <BankRow key={i.id} item={i} now={now} onChanged={changed} />)}
      </ul>
      {bank.truncated && <p className="study-muted">{t("Показаны последние 500: уточните поиск.")}</p>}
    </>}
  </div>;
}

const hasFilter = (f: BankFilter) => Object.values(f).some(Boolean);

function BankRow({ item: i, now, onChanged }: { item: BankItem; now: number; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState("");
  const [note, setNote] = useState(i.note);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const run = async (change: Parameters<typeof updateItem>[1]) => {
    setError("");
    try { await updateItem(i.id, change); onChanged(); } catch (e) { setError(describe(e)); }
  };
  return <li className="study-card" data-item={i.id} data-suspended={i.suspended ? "" : undefined}>
    <div className="study-card-head">
      <span className="study-chip" data-outcome={i.outcome}>{t(OUTCOME_LABEL[i.outcome])}</span>
      <button type="button" className="study-card-q" aria-expanded={open} onClick={() => setOpen(v => !v)}>{i.question}</button>
    </div>
    <p className="study-muted study-card-meta">
      {[i.topic, i.error_type && t("ошибка: {0}", [i.error_type]), i.suspended ? t("отложено") : dueText(i.due_at, now)].filter(Boolean).join(" · ")}
    </p>
    {i.tags.length > 0 && <div className="study-tags">{i.tags.map(x => <span key={x} className="study-tag">
      {x}<button type="button" aria-label={t("Убрать метку «{0}»", [x])} onClick={() => void run({ tags: i.tags.filter(y => y !== x) })}>×</button></span>)}</div>}
    {open && <div className="study-detail">
      {i.answer && <p><b>{t("Ваш ответ")}</b><br />{i.answer}</p>}
      {i.feedback && <p><b>{t("Разбор")}</b><br />{i.feedback}</p>}
      <form className="study-inline" onSubmit={e => { e.preventDefault(); const v = tag.trim(); if (v) { void run({ tags: [...i.tags, v] }); setTag(""); } }}>
        <input className="study-input" value={tag} onChange={e => setTag(e.target.value)} placeholder={t("Новая метка")} aria-label={t("Новая метка")} maxLength={30} />
        <Button variant="ghost" type="submit" disabled={!tag.trim()}>{t("Добавить")}</Button>
      </form>
      <form className="study-inline" onSubmit={e => { e.preventDefault(); void run({ note }); }}>
        <input className="study-input" value={note} onChange={e => setNote(e.target.value)} placeholder={t("Заметка")} aria-label={t("Заметка")} maxLength={1000} />
        <Button variant="ghost" type="submit" disabled={note === i.note}>{t("Сохранить")}</Button>
      </form>
    </div>}
    <div className="study-actions">
      <Button variant="ghost" onClick={() => void run({ suspended: !i.suspended })}>{i.suspended ? t("Вернуть в повторение") : t("Отложить")}</Button>
      {confirm
        ? <><span className="study-muted">{t("Убрать из банка? Занятие останется.")}</span>
          <Button variant="ghost" onClick={() => void run({ deleted: true })}>{t("Убрать")}</Button>
          <IconButton aria-label={t("Отмена")} onClick={() => setConfirm(false)}><md-icon aria-hidden="true">close</md-icon></IconButton></>
        : <Button variant="ghost" onClick={() => setConfirm(true)}>{t("Удалить")}</Button>}
    </div>
    {error && <p className="study-error-text" role="alert">{error}</p>}
  </li>;
}
