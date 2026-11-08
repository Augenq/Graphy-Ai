import { Field } from "./ui/index";
import { t } from "../lib/i18n";
import { useMemo, useState } from "react";
import { useRemote } from "../lib/remote";

const SHOWN = 40;

/** Models of every connected provider with a search box: catalogues like OpenRouter list hundreds. */
export function ModelPicker({ value, onPick, name }: { value: string; onPick: (id: string) => void; name: string }) {
  const models = useRemote((r) => r.models);
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows = models.filter((m) => !q || `${m.id} ${m.name}`.toLowerCase().includes(q));
    const head = rows.slice(0, SHOWN);
    const current = models.find((m) => m.id === value);
    return current && !head.includes(current) && !q ? [current, ...head] : head;
  }, [models, filter, value]);
  const total = models.filter((m) => !filter.trim() || `${m.id} ${m.name}`.toLowerCase().includes(filter.trim().toLowerCase())).length;

  if (models.length === 0) return <p role="status" className="md-typescale-body-medium m-0 text-warn-ui">{t("Моделей пока нет: подключите провайдера.")}</p>;
  return <div>
    <Field label={t("Найти модель")} value={filter} onInput={(e) => setFilter(e.currentTarget.value)} className="mb-2 w-full" autoComplete="off" />
    <div role="radiogroup" aria-label={t("Модель")} className="flex max-h-72 flex-col gap-1 overflow-y-auto">
      {shown.map((m) => <label key={m.id} className={`flex min-h-12 items-center gap-3 rounded-control px-3 py-2 ${value === m.id ? "bg-wash" : ""} ${m.tools ? "" : "opacity-40"}`}>
        <md-radio name={name} checked={value === m.id} disabled={!m.tools} aria-label={m.id} onchange={() => onPick(m.id)} />
        <span className="min-w-0 flex-1"><span className="md-typescale-title-small block truncate">{m.id}</span>
          <span className="md-typescale-body-small block text-ink-3">{[m.tools ? t("инструменты") : t("Без инструментов — не подходит для занятий"), m.vision && t("изображения"), m.reasoning && t("рассуждение")].filter(Boolean).join(" · ")}</span></span>
      </label>)}
    </div>
    {total > shown.length && <p className="md-typescale-body-small m-0 mt-2 text-ink-3">{t("Показано {0} из {1}: уточните поиск", [shown.length, total])}</p>}
  </div>;
}
