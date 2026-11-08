import { CaretDown } from "@phosphor-icons/react";
import { t } from "../lib/i18n";
import { QUIZ_MINUTES, type ModeChoice, type QuizKind } from "../lib/mode-api";
import { MODE_ICON } from "./GraphyIcons";
import { Menu } from "./Menu";

type Props = { value: ModeChoice; onChange: (value: ModeChoice) => void; side?: "top" | "bottom" | "auto" };

export const MODE_ITEMS = [
  { id: "explain", label: "Объяснение", hint: "Объяснения, подсказки и разбор по ходу" },
  { id: "check", label: "Квиз", hint: "Вопросы без подсказок; разбор после отчёта" },
  { id: "materials", label: "Материалы", hint: "Документы, раздатки и презентации файлами" },
] as const;
export const modeKey = (v: ModeChoice) => v.mode === "quiz" ? v.kind : v.mode;
const minutesLabel = (m: number) => (m ? t("{0} мин", [m]) : t("Без таймера"));

/**
 * The mode of the lesson as a quiet control of the options bar under the input: icon, name, chevron.
 * The menu rows repeat the icon, name and a description, and mark the chosen one by tone, tick and weight.
 * A quiz adds its timer right beside it (in the bar, so the send button never moves).
 */
export function ModeSwitch({ value, onChange, side = "auto" }: Props) {
  const current = modeKey(value);
  const label = t(MODE_ITEMS.find((x) => x.id === current)!.label);
  const CurrentIcon = MODE_ICON[current];
  return <span className="mode-switch" data-mode-switch>
    <Menu label={t("Режим занятия")} heading={t("Режим занятия")} side={side} width={392} rich
      items={MODE_ITEMS.map(x => { const Icon = MODE_ICON[x.id]; return { id: x.id, label: t(x.label), hint: t(x.hint), icon: <Icon size={22} className="mode-row-icon" />, checked: x.id === current }; })}
      onSelect={id => { if (id !== current) onChange(id === "explain" || id === "materials" ? { ...value, mode: id } : { ...value, mode: "quiz", kind: id as QuizKind }); }}
      trigger={props => <button type="button" {...props} className="tray-trigger mode-button" data-mode={value.mode}
        aria-label={t("Режим: {0}", [label])} title={t("Режим занятия")}>
        <CurrentIcon size={18} className="tray-icon" /><span className="mode-label">{label}</span><CaretDown aria-hidden="true" className="tray-chevron" />
      </button>} />
    {value.mode === "quiz" && <Menu label={t("Таймер")} heading={t("Таймер")} side={side} width={200} className="mode-timer"
      items={QUIZ_MINUTES.map(m => ({ id: String(m), label: minutesLabel(m), checked: m === value.minutes }))}
      onSelect={id => onChange({ ...value, minutes: Number(id) })}
      trigger={props => <button type="button" {...props} className="tray-trigger mode-timer-button" data-set={value.minutes > 0 || undefined}
        aria-label={t("Таймер: {0}", [minutesLabel(value.minutes)])} title={t("Таймер")}>
        <md-icon aria-hidden="true" className="tray-icon">timer</md-icon><span>{minutesLabel(value.minutes)}</span><CaretDown aria-hidden="true" className="tray-chevron" />
      </button>} />}
  </span>;
}
