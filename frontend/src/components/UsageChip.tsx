/** Under the input: tokens and cost of this lesson, with a breakdown popover. Updates live from the stream. */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isImeKey } from "../lib/ime";
import { t, useLanguage } from "../lib/i18n";
import { Progress } from "./ui/index";
import type { Session } from "../lib/types";
import { cacheHit, costNote, fmtCost, fmtInt, fmtPercent, fmtTokens, sessionTokens } from "../lib/usage";

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return <div className="usage-pop-row" data-strong={strong || undefined}><dt>{label}</dt><dd>{value}</dd></div>;
}

export function UsageChip({ session }: { session: Session }) {
  useLanguage();
  const u = session.usage;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ right: number; bottom: number; max: number } | null>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!open || !root.current) return;
    const place = () => {
      const r = root.current?.getBoundingClientRect();
      if (!r) return;
      // open above the composer card (not the chip under it), so the popover never covers the input and its controls
      const top = Math.min(r.top, root.current?.closest(".lesson-composer")?.getBoundingClientRect().top ?? r.top);
      const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1; // desktop scales the page: fixed offsets are in zoomed px
      setPos({ right: Math.max(8, (window.innerWidth - r.right) / zoom), bottom: (window.innerHeight - top) / zoom + 8, max: Math.max(120, (top - 16) / zoom) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !pop.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !isImeKey(e)) { e.stopPropagation(); setOpen(false); root.current?.querySelector("button")?.focus(); } };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc, true); };
  }, [open]);
  if (!u) return null;
  const tokens = sessionTokens(u);
  if (tokens <= 0 && u.cost <= 0) return null;
  const hit = cacheHit(u);
  const cost = fmtCost(u.cost, u.unknown_cost);
  const ctx = session.context;
  const ctxPct = ctx && ctx.limit > 0 ? Math.min(100, (ctx.used / ctx.limit) * 100) : null;
  const unpriced = u.unknown_cost && u.cost <= 0;
  const summary = `${fmtTokens(tokens)}${unpriced ? "" : ` · ${cost}`}`;
  return (
    <span className="usage-chip-root" ref={root}>
      <button type="button" className="usage-chip quiet-trigger" aria-expanded={open} aria-controls={id} aria-haspopup="dialog"
        aria-label={t("Расход занятия: {0} токенов, стоимость {1}, кэш {2}. Открыть подробности", [fmtInt(tokens), cost, fmtPercent(hit)])} onClick={() => setOpen((v) => !v)}>
        {ctxPct != null
          ? <Progress circular value={ctxPct / 100} aria-label={t("Контекст заполнен на {0}%", [Math.round(ctxPct)])} style={{ width: 18, height: 18, ...(ctxPct >= 90 ? { color: "var(--danger)" } : {}) }} />
          : <md-icon aria-hidden="true">data_usage</md-icon>}
        {ctxPct != null && <span className="tabular-nums" title={t("Заполнение контекста")}>{Math.round(ctxPct)}%</span>}
        <span className={`tabular-nums${ctxPct != null ? " usage-chip-cache" : ""}`}>{summary}</span>
        {hit != null && hit >= 0.005 && <span className="usage-chip-cache tabular-nums" title={t("Доля входных токенов из кэша")}>{fmtPercent(hit)}</span>}
      </button>
      {open && pos && createPortal(
        <div ref={pop} id={id} className="usage-pop" role="dialog" aria-label={t("Расход этого занятия")} style={{ position: "fixed", right: pos.right, bottom: pos.bottom, maxHeight: pos.max, top: "auto", left: "auto" }}>
          <div className="usage-pop-title">{t("Расход этого занятия")}</div>
          <dl>
            <Row label={t("Ввод")} value={fmtInt(u.input)} />
            <Row label={t("Вывод")} value={fmtInt(u.output)} />
            <Row label={t("Кэш: чтение")} value={fmtInt(u.cache_read)} />
            <Row label={t("Кэш: запись")} value={fmtInt(u.cache_write)} />
            <Row label={t("Попадания в кэш")} value={fmtPercent(hit)} />
            <Row label={t("Всего токенов")} value={fmtInt(tokens)} strong />
            <Row label={t("Стоимость")} value={cost} strong />
          </dl>
          <div className="usage-pop-note">{costNote(u.unknown_cost, u.cost)}</div>
          {ctx && ctxPct != null && (
            <div className="usage-pop-ctx">
              <div className="usage-pop-row"><dt>{t("Окно контекста")}</dt><dd>{fmtTokens(ctx.used)} / {fmtTokens(ctx.limit)}</dd></div>
              <div className="usage-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ctxPct)} aria-label={t("Контекст заполнен на {0}%", [Math.round(ctxPct)])}><span data-hot={ctxPct >= 90 || undefined} style={{ width: `${ctxPct}%` }} /></div>
            </div>
          )}
          <div className="usage-pop-note">{t("Общая статистика: Настройки → Использование")}</div>
        </div>,
        document.body
      )}
    </span>
  );
}
