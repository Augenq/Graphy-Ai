import { useMemo, useState } from "react";
import { Spinner } from "@maxhub/max-ui";
import { Button, Field } from "./ui/index";
import { Segmented } from "./ui-new/Segmented";
import { StrategyCard } from "./StrategyCard";
import { describe } from "../lib/api";
import { plural, t } from "../lib/i18n";
import {
  deleteObservation, editObservation, FORMS, FORM_LABELS, rescanMemory, rollbackMemory, setMemorySettings, useMemory,
  type Observation, type StrategyVersion,
} from "../lib/memory-api";

type Grouping = "form" | "topic";

const OUTCOME_ICON: Record<Observation["outcome"], string> = { independent: "check_circle", with_hints: "help", gap: "error_outline" };

function Row({ o, onOpenLesson, onChanged, onError }: { o: Observation; onOpenLesson: (id: string) => void; onChanged: () => void; onError: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [why, setWhy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [text, setText] = useState(o.text);
  const [tag, setTag] = useState(o.tag);
  const [busy, setBusy] = useState(false);
  const run = async (job: () => Promise<unknown>) => {
    setBusy(true);
    try { await job(); onChanged(); setEditing(false); setConfirm(false); } catch (e) { onError(describe(e)); } finally { setBusy(false); }
  };
  return (
    <li className="memory-obs" data-obs={o.id} data-status={o.status} data-outcome={o.outcome}>
      <md-icon aria-hidden="true" className="memory-obs-icon">{OUTCOME_ICON[o.outcome]}</md-icon>
      <div className="memory-obs-body">
        {editing ? (
          <form className="memory-edit" onSubmit={(e) => { e.preventDefault(); void run(() => editObservation(o.id, { text, tag })); }}>
            <Field aria-label={t("Текст наблюдения")} value={text} maxLength={300} onInput={(e) => setText(e.currentTarget.value)} className="memory-edit-text" />
            <select aria-label={t("Приём")} value={tag} onChange={(e) => setTag(e.target.value)} className="memory-select">
              <option value="">{t("Без метки")}</option>
              {FORMS.map((f) => <option key={f} value={f}>{t(FORM_LABELS[f])}</option>)}
            </select>
            <Button variant="primary" type="submit" disabled={busy || !text.trim()}>{t("Сохранить")}</Button>
            <Button variant="ghost" type="button" onClick={() => { setEditing(false); setText(o.text); setTag(o.tag); }}>{t("Отмена")}</Button>
          </form>
        ) : (
          <p className="memory-obs-text">{o.text}</p>
        )}
        <div className="memory-obs-meta">
          {o.tag && <span className="memory-tag">{t(FORM_LABELS[o.tag] ?? o.tag)}</span>}
          {o.status === "edited" && (o.included
            ? <span className="memory-flag" data-kind="current" title={t("Вы поправили метку: запись учитывается под новой меткой")}>{t("метка исправлена")}</span>
            : <span className="memory-flag" data-kind="edited" title={t("Вы изменили текст: запись больше не влияет на стратегию")}>{t("изменено · не учитывается")}</span>)}
        </div>
        {why && (
          <div className="memory-why" role="note">
            <p>{t("Запись появилась после оценки вашей попытки в занятии. Приём объяснения определён по тексту репетитора, исход берётся из оценки.")}</p>
            <Button variant="secondary" type="button" onClick={() => onOpenLesson(o.source.session)}>{t("Открыть занятие")}</Button>
          </div>
        )}
      </div>
      <div className="memory-obs-actions">
        <button type="button" className="memory-icon" aria-label={t("Откуда это")} aria-expanded={why} onClick={() => setWhy(!why)}><md-icon aria-hidden="true">help_outline</md-icon></button>
        <button type="button" className="memory-icon" aria-label={t("Изменить")} onClick={() => setEditing(true)} disabled={editing}><md-icon aria-hidden="true">edit</md-icon></button>
        {confirm ? (
          <span className="memory-confirm" role="group" aria-label={t("Удалить запись?")}>
            <Button variant="secondary" type="button" disabled={busy} onClick={() => void run(() => deleteObservation(o.id))}>{t("Удалить")}</Button>
            <Button variant="ghost" type="button" onClick={() => setConfirm(false)}>{t("Нет")}</Button>
          </span>
        ) : (
          <button type="button" className="memory-icon" aria-label={t("Удалить")} onClick={() => setConfirm(true)}><md-icon aria-hidden="true">delete</md-icon></button>
        )}
      </div>
    </li>
  );
}

export function MemoryView({ onOpenLesson }: { onOpenLesson: (id: string) => void }) {
  const { data, error, reload, setError } = useMemory();
  const [grouping, setGrouping] = useState<Grouping>("form");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const groups = useMemo(() => {
    const map = new Map<string, Observation[]>();
    for (const o of data?.observations ?? []) {
      const key = grouping === "form" ? (o.tag || o.form) : (o.topic || "");
      map.set(key, [...(map.get(key) ?? []), o]);
    }
    return [...map.entries()].map(([key, rows]) => ({ key, rows, title: grouping === "form" ? t(FORM_LABELS[key] ?? key) : key || t("Без темы") }));
  }, [data, grouping]);

  const act = async (job: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setNote("");
    try { await job(); await reload(); if (done) setNote(done); } catch (e) { setError(describe(e)); } finally { setBusy(false); }
  };
  const rollback = (v: StrategyVersion) => void act(() => rollbackMemory(v.version), t("Стратегия возвращена к версии {0}", [String(v.version)]));

  return (
    <section className="memory-view" aria-label={t("Память")} data-memory-view>
      <header className="memory-head">
        <p className="memory-sub">{t("Здесь видно, что Graphy заметил о том, как вам лучше объяснять. Всё хранится на этом компьютере; любую запись можно исправить или удалить.")}</p>
      </header>
      <div className="memory-scroll scroll-y">
        {error && <div className="memory-error" role="alert"><span>{error}</span><Button variant="ghost" onClick={() => void reload()}>{t("Повторить")}</Button></div>}
        {note && <div className="memory-note" role="status">{note}</div>}
        {!data && !error && <div className="memory-loading" role="status"><Spinner size={20} aria-hidden="true" />{t("Загрузка памяти")}</div>}
        {data && (
          <>
            <section className="memory-card memory-switches" aria-label={t("Управление")}>
              <label className="memory-switch">
                <span><strong>{t("Подстраиваться под меня")}</strong><span className="memory-muted">{t("Выключено: репетитор не использует заметки и ничего новое не записывается.")}</span></span>
                <md-switch aria-label={t("Подстраиваться под меня")} selected={data.settings.adaptive} onchange={(e) => void act(() => setMemorySettings({ adaptive: e.target.selected }))} />
              </label>
            </section>
            <StrategyCard data={data} busy={busy} onRollback={rollback} />
            <div className="memory-list-head">
              <h2>{t("Наблюдения")} <span className="memory-count">{data.observations.length}</span></h2>
              <Segmented label={t("Группировка")} value={grouping} onChange={setGrouping} items={[{ id: "form", title: t("По приёмам") }, { id: "topic", title: t("По темам") }]} />
              <Button variant="secondary" type="button" disabled={busy || !data.settings.adaptive}
                onClick={() => void act(async () => { const r = await rescanMemory(); setNote(r.added ? plural(r.added, "Добавлена {0} запись", "Добавлено {0} записи", "Добавлено {0} записей").replace("{0}", String(r.added)) : t("Новых записей нет")); })}>
                <md-icon slot="icon" aria-hidden="true">sync</md-icon>{t("Найти в прошлых занятиях")}
              </Button>
            </div>
            {data.observations.length === 0 && (
              <div className="memory-empty" data-empty>
                <md-icon aria-hidden="true">psychology</md-icon>
                <h3>{t("Пока ничего не запомнено")}</h3>
                <p>{t("После нескольких проверенных задач здесь появятся записи вроде «Объяснение через пример: задача решена без подсказок».")}</p>
              </div>
            )}
            {groups.map((g) => (
              <section key={g.key} className="memory-group" aria-label={g.title} data-group={g.key}>
                <h3>{g.title} <span className="memory-count">{g.rows.length}</span></h3>
                <ul className="memory-obs-list">
                  {g.rows.map((o) => <Row key={o.id} o={o} onOpenLesson={onOpenLesson} onChanged={() => void reload()} onError={setError} />)}
                </ul>
              </section>
            ))}
          </>
        )}
      </div>
    </section>
  );
}
