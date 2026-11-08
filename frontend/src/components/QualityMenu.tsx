import { Menu } from "./Menu";
import { CaretDown, Lightning, Brain } from "@phosphor-icons/react";
import { IconQualityBalanced } from "./GraphyIcons";
import { t, useLanguage } from "../lib/i18n";

export type Quality = "fast" | "balanced" | "deep";

const ITEMS = [
  { id: "fast", label: "Быстрый", hint: "Быстрый ответ для простых вопросов", Icon: Lightning },
  { id: "balanced", label: "Сбалансированный", hint: "Хороший баланс для большинства задач", Icon: IconQualityBalanced },
  { id: "deep", label: "Глубокий", hint: "Для сложных тем и разбора ошибок", Icon: Brain },
] as const;

export function QualityMenu({ value, onPick, side = "auto" }: { value: Quality; onPick: (v: Quality) => void; side?: "top" | "bottom" | "auto" }) {
  useLanguage();
  const current = ITEMS.find(i => i.id === value) ?? ITEMS[1];
  const CurrentIcon = current.Icon;
  return <Menu label={t("Качество ответа")} fieldLabel={`${t("Режим")}: ${t(current.label)}`}
    side={side} align="end" width={320} fitViewport className="model-control quality-control"
    items={ITEMS.map(i => ({ id: i.id, label: t(i.label), hint: t(i.hint), checked: i.id === value, icon: <i.Icon size={18} weight="duotone" aria-hidden="true" /> }))}
    onSelect={id => onPick(id as Quality)}
    trigger={props => <button type="button" {...props} className="tray-trigger model-trigger" aria-label={t("Качество ответа: {0}", [t(current.label)])} title={t(current.hint)}>
      <CurrentIcon size={16} weight="duotone" aria-hidden="true" /><span className="model-name">{t(current.label)}</span><CaretDown aria-hidden="true" className="tray-chevron" />
    </button>} />;
}

export const DEFAULT_QUALITY: Quality = "balanced";
