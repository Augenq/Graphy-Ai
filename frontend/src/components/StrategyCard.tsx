import { useState } from "react";
import { Button } from "./ui/index";
import { t, locale } from "../lib/i18n";
import { describeProfile, type MemoryOverview, type StrategyVersion } from "../lib/memory-api";

function when(ts: number) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** The current strategy in plain words, its evidence, and the version history with rollback. */
export function StrategyCard({ data, busy, onRollback }: { data: MemoryOverview; busy: boolean; onRollback: (v: StrategyVersion) => void }) {
  const [open, setOpen] = useState(false);
  const { strategy, versions, settings, rules } = data;
  const rows = describeProfile(strategy.profile);
  const off = !settings.adaptive ? "off" : "on";
  return (
    <section className="memory-card memory-strategy" aria-label={t("Стратегия")} data-strategy data-state={off}>
      <div className="memory-card-head">
        <md-icon aria-hidden="true">tune</md-icon>
        <h2>{t("Моя стратегия")}</h2>
        <span className="memory-version" data-version={strategy.version}>{strategy.version ? t("версия {0}", [String(strategy.version)]) : t("пока нет данных")}</span>
        {off !== "on" && <span className="memory-flag" data-kind={off}>{t("выключена")}</span>}
      </div>
      {rows.length ? (
        <dl className="memory-profile">
          {rows.map((r) => (
            <div key={r.label}><dt>{t(r.label)}</dt><dd>{t(r.value)}</dd></div>
          ))}
        </dl>
      ) : (
        <p className="memory-muted">{t("Пока мало данных: стратегия начнёт меняться, когда накопится хотя бы {0} похожих случая.", [String(rules.min_samples)])}</p>
      )}
      {strategy.reason && <p className="memory-reason"><md-icon aria-hidden="true">info</md-icon><span>{t("Почему так")}: {strategy.reason}</span></p>}
      <p className="memory-muted memory-fine">{t("Репетитор не называет вам оценок: он только подстраивает объяснения. Любая ваша просьба в чате важнее этих заметок.")}</p>
      <button type="button" className="memory-toggle" aria-expanded={open} aria-controls="memory-history" onClick={() => setOpen(!open)}>
        <md-icon aria-hidden="true">{open ? "expand_less" : "history"}</md-icon>
        {t("История версий")} ({versions.length})
      </button>
      {open && (
        <ol id="memory-history" className="memory-history">
          {versions.length === 0 && <li className="memory-muted">{t("Изменений ещё не было")}</li>}
          {versions.map((v, i) => (
            <li key={v.version} data-version-row={v.version}>
              <div className="memory-history-main">
                <strong>{t("версия {0}", [String(v.version)])}</strong>
                <span className="memory-muted">{when(v.created)}{v.kind === "rollback" ? ` · ${t("откат")}` : ""}</span>
                <p>{v.reason}</p>
                <p className="memory-muted">{describeProfile(v.profile).map((r) => `${t(r.label)}: ${t(r.value)}`).join("; ") || t("пусто")}</p>
              </div>
              {i === 0 ? <span className="memory-flag" data-kind="current">{t("текущая")}</span>
                : <Button variant="secondary" type="button" disabled={busy} onClick={() => onRollback(v)} aria-label={t("Откатиться к версии {0}", [String(v.version)])}>{t("Откатить")}</Button>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
