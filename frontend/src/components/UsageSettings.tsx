import { Spinner } from "@maxhub/max-ui";
import { Button } from "./ui/index";
import { Segmented } from "./ui-new/Segmented";
/** Settings → «Использование»: tokens and cost of the lessons, computed on this computer from their journals. */
import { useRef, useState } from "react";
import { t, useLanguage } from "../lib/i18n";
import {
  buckets, costNote, fmtCost, fmtInt, fmtPercent, fmtTokens, shares, useUsageOverview,
  type UsageOverview, type UsageRange,
} from "../lib/usage";
import { CostLegend, CostLine, Donut, Heatmap, TokenBars, TokenLegend } from "./UsageCharts";

const RANGES: { id: UsageRange; label: string }[] = [
  { id: "7d", label: "7 дней" },
  { id: "30d", label: "30 дней" },
  { id: "all", label: "Всё время" },
];

function Kpi({ icon, label, value, sub, title }: { icon: string; label: string; value: string; sub: string; title?: string }) {
  return (
    <div className="usage-kpi" title={title}>
      <div className="usage-kpi-label"><md-icon aria-hidden="true">{icon}</md-icon>{label}</div>
      <div className="usage-kpi-value">{value}</div>
      <div className="usage-kpi-sub">{sub}</div>
    </div>
  );
}

function Card({ title, desc, children, wide }: { title: string; desc?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <section className="usage-card" data-wide={wide || undefined}>
      <h3>{title}</h3>
      {desc && <p>{desc}</p>}
      {children}
    </section>
  );
}

function Skeleton() {
  return (
    <div className="usage-skeleton" aria-hidden="true">
      <div className="usage-kpis">{[0, 1, 2, 3].map((i) => <div key={i} className="usage-kpi usage-skel" />)}</div>
      <div className="usage-card usage-skel" style={{ height: 250 }} />
      <div className="usage-card usage-skel" style={{ height: 210 }} />
    </div>
  );
}

function Empty() {
  return (
    <div className="usage-empty" role="status">
      <md-icon aria-hidden="true">insights</md-icon>
      <div className="usage-empty-title">{t("Здесь пока пусто")}</div>
      <div>{t("Расход токенов появится после первого ответа агента. Он считается по журналам занятий на этом компьютере.")}</div>
    </div>
  );
}

function Report({ data }: { data: UsageOverview }) {
  const tot = data.totals;
  const bars = buckets(data);
  const unknown = tot.unknown_cost;
  const costText = fmtCost(tot.cost, unknown || !tot.known_cost);
  const modelName = (m: string) => (m === "?" ? t("Неизвестная модель") : m);
  const costOf = (r: { cost: number; unknown_cost: boolean; known_cost: boolean }) => fmtCost(r.cost, r.unknown_cost || !r.known_cost);
  const slices = shares(data.models, 5).map((s, i) => ({
    id: s.row?.model ?? `rest${i}`,
    label: s.row ? modelName(s.row.model) : t("Остальные модели ({0})", [s.rest]),
    share: s.share, tokens: s.tokens,
    cost: s.row ? costOf(s.row) : "",
  }));
  return (
    <>
      <div className="usage-kpis">
        <Kpi icon="data_usage" label={t("Токены")} value={fmtTokens(tot.tokens)} sub={t("ввод {0} · вывод {1}", [fmtTokens(tot.input), fmtTokens(tot.output)])} title={`${fmtInt(tot.tokens)}`} />
        <Kpi icon="payments" label={t("Стоимость")} value={costText} sub={tot.known_cost || !unknown ? (unknown ? t("сумма известных цен") : t("по ценам моделей")) : t("цена неизвестна")} title={costNote(unknown, tot.cost)} />
        <Kpi icon="school" label={t("Занятия")} value={fmtInt(tot.lessons)} sub={tot.lessons ? t("≈ {0} токенов на занятие", [fmtTokens(tot.tokens / tot.lessons)]) : "—"} />
        <Kpi icon="bolt" label={t("Попадания в кэш")} value={fmtPercent(tot.cache_hit)} sub={t("из кэша прочитано {0}", [fmtTokens(tot.cache_read)])} title={t("Доля входных токенов, которые провайдер взял из кэша")} />
      </div>
      <Card title={t("Токены по дням")} wide>
        <TokenBars buckets={bars} />
        <TokenLegend />
      </Card>
      <Card title={t("Стоимость во времени")} desc={tot.known_cost ? t("Только известные цены: что провайдер сообщил или что посчитано по прайсу модели. Неизвестное не оценивается.") : undefined} wide>
        {tot.known_cost ? <><CostLine buckets={bars} /><CostLegend /></> : <p className="usage-note">{t("Ни для одной модели не известна цена, поэтому стоимость не показана. Токены считаются в любом случае.")}</p>}
      </Card>
      <div className="usage-pair">
        <Card title={t("По моделям")}>
          <Donut slices={slices} centerLabel={t("токенов")} />
        </Card>
      </div>
      <Card title={t("Дни занятий")} desc={t("Последние полгода, независимо от выбранного периода. Чем насыщеннее клетка, тем больше токенов.")} wide>
        <Heatmap days={data.heatmap} today={data.today} />
      </Card>
      {data.sessions.length > 0 && (
        <Card title={t("Самые затратные занятия")} wide>
          <div className="usage-table-wrap"><table className="usage-table">
            <thead><tr><th scope="col">{t("Занятие")}</th><th scope="col">{t("Токены")}</th><th scope="col">{t("Кэш")}</th><th scope="col">{t("Стоимость")}</th></tr></thead>
            <tbody>
              {data.sessions.map((s) => (
                <tr key={s.id}>
                  <th scope="row"><span className="usage-clip" title={s.name}>{s.name || t("Без названия")}</span></th>
                  <td>{fmtTokens(s.tokens)}</td>
                  <td>{fmtPercent(s.input + s.cache_read + s.cache_write > 0 ? s.cache_read / (s.input + s.cache_read + s.cache_write) : null)}</td>
                  <td>{costOf(s)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Card>
      )}
    </>
  );
}

export function UsageSettings() {
  useLanguage();
  const [range, setRange] = useState<UsageRange>("30d");
  const { load, reload } = useUsageOverview(range);
  const last = useRef<UsageOverview | null>(null);
  if (load.state === "ready") last.current = load.data;
  const shown = load.state === "ready" ? load.data : load.state === "loading" ? last.current : null;
  return (
    <div className="usage" aria-busy={load.state === "loading"}>
      <div className="usage-top">
        <Segmented className="usage-seg" label={t("Период")} value={range} onChange={setRange} items={RANGES.map(r => ({ id: r.id, title: t(r.label) }))} />
        {load.state === "loading" && shown && <Spinner size={20} className="usage-spinner" aria-hidden="true" />}
        <span className="usage-private"><md-icon aria-hidden="true">lock</md-icon>{t("Считается на этом компьютере")}</span>
      </div>
      {load.state === "error" && (
        <div className="usage-error" role="alert">
          <md-icon aria-hidden="true">error</md-icon>
          <span>{t("Не удалось получить расход")}: {load.message}</span>
          <Button variant="secondary" type="button" onClick={reload}>{t("Повторить")}</Button>
        </div>
      )}
      {load.state === "loading" && !shown && <Skeleton />}
      {shown && (shown.totals.tokens === 0 ? <Empty /> : <div className="usage-report" data-stale={load.state === "loading" || undefined}><Report data={shown} /></div>)}
    </div>
  );
}
