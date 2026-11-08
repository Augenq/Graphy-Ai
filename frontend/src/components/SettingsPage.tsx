import { Button, Field, IconButton } from "./ui/index";
import { t, useLanguage } from "../lib/i18n";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { isPhone, returnFocus, type SettingsSection } from "../lib/settings-route";
import { radioKeys } from "../lib/radio-keys";
import { resetInterfaceState } from "../lib/store";
import { setWebKey, updateAgentSettings, useRemote } from "../lib/remote";
import { ModelPicker } from "./ModelPicker";
import { ProviderSetup } from "./ProviderSetup";
import { SHORTCUTS } from "../lib/shortcuts";
import { defaultSettings, updateSettings, useSettings, type Settings } from "../lib/settings";
import { EXPLANATION_DEPTHS, EXPLANATION_PRESENTATIONS, EXPLANATION_STYLES } from "../lib/styles";
import { InfoMark } from "./InfoMark";
import { Markdown } from "./Markdown";
import { Select } from "./Select";
import { ThemeChoice } from "./ThemePreviewCard";
import { paletteFor, type ColorPalette } from "../lib/palette";
import { UsageSettings } from "./UsageSettings";
import { MemoryView } from "./MemoryView";
import { SkillsView } from "./SkillsView";
import { TeacherModeRow } from "./TeacherModeRow";
import { MaxProfile } from "./MaxProfile";
import { useMax } from "../lib/max";
import { btnOutline } from "./ui";

export type { SettingsSection };

const SECTIONS: { id: SettingsSection; label: string; blurb: string; icon: ReactNode }[] = [
  { id: "profile", blurb: "Ваш аккаунт MAX, роль и привязка к учителю.", label: "Профиль", icon: <md-icon aria-hidden="true" className="shrink-0">account_circle</md-icon> },
  { id: "general", blurb: "Язык интерфейса и повторный показ первого запуска.", label: "Общие", icon: <md-icon aria-hidden="true" className="shrink-0" >settings</md-icon> },
  { id: "appearance", blurb: "Тема, размер и ширина текста в диалоге. Всё применяется сразу.", label: "Внешний вид", icon: <md-icon aria-hidden="true" className="shrink-0" >palette</md-icon> },
  { id: "agent", blurb: "Как агент объясняет, ищет в сети и хранит историю.", label: "Агент", icon: <md-icon aria-hidden="true" className="shrink-0" >smart_toy</md-icon> },
  { id: "skills", blurb: "Умения агента: включить, установить, изменить.", label: "Навыки", icon: <md-icon aria-hidden="true" className="shrink-0">extension</md-icon> },
  { id: "memory", blurb: "Что Graphy запоминает о том, как вам удобно учиться.", label: "Память", icon: <md-icon aria-hidden="true" className="shrink-0">psychology</md-icon> },
  { id: "data", blurb: "Очистка черновиков и возврат настроек по умолчанию.", label: "Данные и приватность", icon: <md-icon aria-hidden="true" className="shrink-0" >lock</md-icon> },
  { id: "usage", blurb: "Расход токенов и стоимость по моделям и дням.", label: "Использование", icon: <md-icon aria-hidden="true" className="shrink-0" >bar_chart</md-icon> },
  { id: "keyboard", blurb: "Сочетания клавиш для занятий и поиска.", label: "Клавиатура", icon: <md-icon aria-hidden="true" className="shrink-0" >keyboard</md-icon> },
  { id: "about", blurb: "Версия, режим преподавателя и лицензии.", label: "О программе", icon: <md-icon aria-hidden="true" className="shrink-0" >info</md-icon> },
];

/** Every setting is listed here so the search box can open the exact section. */
const INDEX: { section: SettingsSection; label: string; words: string }[] = [
  { section: "general", label: "Язык интерфейса", words: "язык language русский" },
  { section: "general", label: "Первый запуск", words: "приветствие онбординг подключение" },
  { section: "appearance", label: "Тема", words: "тёмная светлая системная theme цвет оформление" },
  // { section: "appearance", label: "Цветовая палитра", words: "палитра цвета max graphy оформление" }, // MAX hidden
  { section: "appearance", label: "Размер текста", words: "размер крупный мелкий" },
  { section: "appearance", label: "Ширина колонки", words: "ширина узкая широкая" },
  { section: "appearance", label: "Шрифт ответов", words: "serif шрифт с засечками гарнитура font" },
  { section: "appearance", label: "Анимации", words: "движение reduced motion анимация отключить" },
  { section: "agent", label: "Стиль объяснения", words: "сократический диалог метод стиль" },
  { section: "skills", label: "Навыки", words: "скиллы skills" },
  { section: "memory", label: "Память", words: "подстраиваться стратегия наблюдения" },
  { section: "about", label: "Режим преподавателя", words: "учитель teacher класс классы ученики" },
  { section: "agent", label: "Глубина объяснения", words: "кратко подробно по ситуации объяснение длина" },
  { section: "agent", label: "Оформление ответа", words: "связный текст разделы списки заголовки по ситуации формат layout" },
  { section: "agent", label: "Anti-slop framework", words: "стиль объяснение качество инструкции промпт slop" },
  { section: "agent", label: "Автосжатие истории", words: "compact контекст сжатие" },
  { section: "agent", label: "Изображения", words: "картинки фото vision блокировать" },
  { section: "agent", label: "Веб-поиск", words: "web searxng duckduckgo brave поиск в сети" },
  { section: "data", label: "Очистить незавершённый ввод и позиции прокрутки", words: "reset очистить сбросить" },
  { section: "usage", label: "Расход токенов и стоимость", words: "usage токены стоимость цена кэш статистика график деньги" },
  { section: "keyboard", label: "Горячие клавиши", words: "shortcuts сочетания клавиатура" },
  { section: "about", label: "Версия и лицензии", words: "about версия" },
];

function Row({ label, desc, info, children }: { label: string; desc?: string; info?: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-row-title">{label}{info && <InfoMark text={info} label={t("Подробнее: {0}", [label])} />}</div>
        {desc && <div className="settings-row-desc">{desc}</div>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return <Select label={label} value={value} options={options} onChange={onChange} />;
}

/** A titled group of rows (or any content) with a rule above it: the page divides by hairlines and space, not by boxes. */
function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="settings-section" aria-labelledby={id}>
      <header className="settings-section-head">
        <h2 id={id}>{title}</h2>
        {desc && <p>{desc}</p>}
      </header>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}

/** A few options shown at once, each with a sample of what it does (principle 5: a real example instead of an abstract name). */
function Choice<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string; sample: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  const ids = options.map(option => option.id);
  return (
    <div role="radiogroup" aria-label={label} className="choice" onKeyDown={event => radioKeys(event, ids, value, onChange)}>
      {options.map(option => (
        <button key={option.id} type="button" role="radio" aria-checked={option.id === value} tabIndex={option.id === value ? 0 : -1} data-value={option.id}
          className="choice-option" onClick={() => onChange(option.id)}>
          <span className="choice-sample" aria-hidden="true">{option.sample}</span>
          <span className="choice-label">{option.label}</span>
          <span className="choice-check" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.4 6.6 11.5 12.5 4.8" /></svg>
          </span>
        </button>
      ))}
    </div>
  );
}

const bars = (...widths: number[]) => <span className="choice-bars">{widths.map((w, i) => <i key={i} style={{ width: w }} />)}</span>;

/** A short answer with a formula, drawn by the dialog's own math-text component with the dialog's own variables: it changes as the choices above change. */
function TextPreview() {
  const text = `${t("Определитель — это **одно число**, которое матрица «рассказывает» о себе. Для матрицы 2×2 оно считается так:")}\n\n$$\\det\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix} = ad - bc$$`;
  return (
    <div className="settings-preview" data-text-preview>
      <div className="settings-preview-label">{t("Так будет выглядеть ответ в диалоге")}</div>
      <div className="settings-preview-stage">
        <div className="settings-preview-column" data-preview-column><Markdown text={text} /></div>
      </div>
    </div>
  );
}

const PALETTES: { id: ColorPalette; label: string }[] = [
  { id: "graphy", label: "Graphy" },
  { id: "max", label: "MAX" },
];

/** The palette's own colours as a sample: the page, a card and the accent, so the choice shows what it applies. */
function PaletteSwatches({ id }: { id: ColorPalette }) {
  const dark = document.documentElement.dataset.theme === "dark";
  const p = paletteFor(dark, id);
  return (
    <span className="palette-swatches" aria-hidden="true">
      {[p.paper, p.sheet, p.accent].map((color, i) => <i key={i} style={{ background: color, boxShadow: `inset 0 0 0 1px ${p.rule}` }} />)}
    </span>
  );
}

/** Two radio buttons: the Graphy palette or MAX's. The choice applies at once and is remembered (lib/settings). */
function PaletteChoice({ value }: { value: ColorPalette }) {
  const ids = PALETTES.map((palette) => palette.id);
  return (
    <div role="radiogroup" aria-label={t("Цветовая палитра")} className="choice" onKeyDown={event => radioKeys(event, ids, value, id => updateSettings({ palette: id }))}>
      {PALETTES.map((palette) => (
        <button key={palette.id} type="button" role="radio" aria-checked={palette.id === value} tabIndex={palette.id === value ? 0 : -1} data-value={palette.id}
          className="choice-option" onClick={() => updateSettings({ palette: palette.id })}>
          <span className="choice-sample" aria-hidden="true"><PaletteSwatches id={palette.id} /></span>
          <span className="choice-label">{palette.label}</span>
          <span className="choice-check" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.4 6.6 11.5 12.5 4.8" /></svg>
          </span>
        </button>
      ))}
    </div>
  );
}

function Appearance() {
  const s = useSettings();
  return (
    <>
      <Section title={t("Тема")} desc={t("Применяется сразу. «Системная» следует настройке устройства.")}>
        <ThemeChoice value={s.theme} />
      </Section>
      {/* MAX palette hidden for now — re-enable when ready.
      <Section title={t("Цветовая палитра")} desc={t("Цвета всего интерфейса")}>
        <PaletteChoice value={s.palette} />
      </Section> */}
      <Section title={t("Текст в диалоге")} desc={t("Меняет только текст ответов; боковая панель и кнопки остаются прежними.")}>
        <Row label={t("Размер текста")} desc={t("Для ответов и чтения занятия")}>
          <Choice label={t("Размер текста")} value={s.textSize} onChange={(v) => updateSettings({ textSize: v })} options={[
            { id: "s", label: t("Мелкий"), sample: <span style={{ fontSize: 13 }}>Аа</span> },
            { id: "m", label: t("Средний"), sample: <span style={{ fontSize: 15 }}>Аа</span> },
            { id: "l", label: t("Крупный"), sample: <span style={{ fontSize: 18 }}>Аа</span> },
          ]} />
        </Row>
        <Row label={t("Ширина колонки")} desc={t("Ширина текста в диалоге")}>
          <Choice label={t("Ширина колонки")} value={s.width} onChange={(v) => updateSettings({ width: v })} options={[
            { id: "narrow", label: t("Узкая"), sample: bars(12, 16, 10) },
            { id: "medium", label: t("Средняя"), sample: bars(16, 20, 13) },
            { id: "wide", label: t("Широкая"), sample: bars(22, 26, 17) },
          ]} />
        </Row>
        <Row label={t("Шрифт ответов")} desc={t("Гарнитура текста ответов в диалоге")}>
          <Choice label={t("Шрифт ответов")} value={s.font} onChange={(v) => updateSettings({ font: v })} options={[
            { id: "sans", label: t("Без засечек"), sample: <span style={{ fontSize: 15 }}>Аа</span> },
            { id: "serif", label: t("С засечками"), sample: <span style={{ fontSize: 15, fontFamily: "var(--font-answer-serif)" }}>Аа</span> },
          ]} />
        </Row>
        <TextPreview />
      </Section>
      <Section title={t("Анимации")} desc={t("«Системные» следуют настройке устройства; «Выкл» убирает движение в интерфейсе.")}>
        <Row label={t("Анимации")} desc={t("Переходы, появление текста, подсветка")}>
          <Choice label={t("Анимации")} value={s.motion} onChange={(v) => updateSettings({ motion: v })} options={[
            { id: "system", label: t("Системные"), sample: <md-icon aria-hidden="true">play_arrow</md-icon> },
            { id: "off", label: t("Выкл"), sample: <md-icon aria-hidden="true">block</md-icon> },
          ]} />
        </Row>
      </Section>
    </>
  );
}

const LEVELS: Record<string, string> = { off: "Нет", minimal: "Минимальное", low: "Лёгкое", medium: "Среднее", high: "Высокое", xhigh: "Очень высокое", max: "Макс." };

function AgentSection() {
  const agent = useRemote((r) => r.settings);
  const [key, setKey] = useState("");
  if (!agent) return null;
  const toggle = (name: "auto_compact" | "block_images" | "anti_slop_enabled", label: string, desc: string) => (
    <Row label={label} desc={desc}>
      <md-switch aria-label={label} selected={agent[name]} onchange={(e) => void updateAgentSettings({ [name]: e.target.selected })} />
    </Row>
  );
  return (
    <>
      <Row label={t("Стиль объяснения")} desc={t("Действует во всех занятиях со следующего ответа.")}>
        <Seg label={t("Стиль объяснения")} value={agent.default_style} onChange={(v) => void updateAgentSettings({ default_style: v })}
          options={EXPLANATION_STYLES.map((o) => ({ id: o.id, label: t(o.label) }))} />
      </Row>
      <Row label={t("Глубина объяснения")} info={t("«По ситуации» оставляет выбор за методом обучения и вашим вопросом. Действует во всех занятиях со следующего ответа.")}>
        <Seg label={t("Глубина объяснения")} value={agent.explanation_depth} onChange={(v) => void updateAgentSettings({ explanation_depth: v })}
          options={EXPLANATION_DEPTHS.map((o) => ({ id: o.id, label: t(o.label) }))} />
      </Row>
      <Row label={t("Оформление ответа")} info={t("«По ситуации» оставляет выбор за методом обучения и вашим вопросом. Действует во всех занятиях со следующего ответа.")}>
        <Seg label={t("Оформление ответа")} value={agent.explanation_presentation} onChange={(v) => void updateAgentSettings({ explanation_presentation: v })}
          options={EXPLANATION_PRESENTATIONS.map((o) => ({ id: o.id, label: t(o.label) }))} />
      </Row>
      {toggle("anti_slop_enabled", t("Anti-slop framework"), t("Добавляет правила ясного и обоснованного объяснения во всех занятиях. Изменение действует со следующего запроса."))}
      {toggle("auto_compact", t("Автосжатие истории"), t("Когда контекст заполнен, ранняя история сворачивается в краткое содержание"))}
      {toggle("block_images", t("Блокировать изображения"), t("Не отправлять вложенные картинки моделям"))}
      <Row label={t("Веб-поиск")} desc={t("SearXNG на этом компьютере (npm run search), DuckDuckGo или Brave Search")}>
        <Seg label={t("Веб-поиск")} value={agent.web_provider} onChange={(v) => void updateAgentSettings({ web_provider: v })} options={[{ id: "searxng", label: "SearXNG" }, { id: "duckduckgo", label: "DuckDuckGo" }, { id: "brave", label: "Brave" }]} />
      </Row>
      {agent.web_provider === "brave" && (
        <Row label={t("Ключ Brave Search")} desc={agent.web_key_set ? t("Ключ сохранён") : t("Ключ не задан")}>
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (key.trim()) void setWebKey(key.trim()).then(() => setKey("")); }}>
            <Field type="password" aria-label={t("Ключ Brave Search")} value={key} onInput={(e) => setKey(e.currentTarget.value)} autoComplete="off" />
            <Button variant="secondary" type="submit" disabled={!key.trim()}>{t("Сохранить")}</Button>
          </form>
        </Row>
      )}
    </>
  );
}

function SkillsSection({ onOpenLesson }: { onOpenLesson: (id: string) => void }) {
  const agent = useRemote((r) => r.settings);
  return <>
    <Row label={t("Использовать навыки")}>
      <md-switch aria-label={t("Использовать навыки")} selected={agent?.skills_enabled ?? false} disabled={!agent} onchange={(e) => void updateAgentSettings({ skills_enabled: e.target.selected })} />
    </Row>
    <div className="settings-embedded"><SkillsView onOpenLesson={onOpenLesson} /></div>
  </>;
}

function Body({ section, onFirstRun, onOpenLesson }: { section: SettingsSection; onFirstRun: () => void; onOpenLesson: (id: string) => void }) {
  const s = useSettings();
  const version = useRemote((r) => r.version);
  const hubMode = useMax().hub;
  const [filter, setFilter] = useState("");
  const keys = useMemo(() => SHORTCUTS.map((k) => ({ ...k, group: t(k.group), label: t(k.label), keys: t(k.keys) })).filter((k) => `${k.label} ${k.keys}`.toLowerCase().includes(filter.toLowerCase())), [filter, s.language]);

  switch (section) {
    case "profile":
      return <MaxProfile />;
    case "general":
      return (
        <>
          <Row label={t("Язык интерфейса")} desc={t("Языки ответов агента определяются вашими сообщениями")}>
            <Select label={t("Язык интерфейса")} value={s.language} onChange={(v) => updateSettings({ language: v })} options={[{ id: "ru", label: "Русский" }, { id: "en", label: "English" }]} />
          </Row>
          <Row label={t("Первый запуск")} desc={t("Подключение провайдера и выбор модели")}>
            <Button variant="secondary" type="button" className={btnOutline} onClick={onFirstRun}>
              {t("Показать снова")}
            </Button>
          </Row>
        </>
      );
    case "appearance":
      return <Appearance />;
    case "agent":
      return <AgentSection />;
    case "skills":
      return <SkillsSection onOpenLesson={onOpenLesson} />;
    case "memory":
      return <div className="settings-embedded"><MemoryView onOpenLesson={onOpenLesson} /></div>;
    case "data":
      return (
        <>
          <Row label={t("Очистить незавершённый ввод и позиции прокрутки")} desc={t("Удаляет неотправленный текст и сохранённые позиции прокрутки. Занятия и ответы сохраняются.")}>
            <Button variant="secondary" type="button" className={btnOutline} onClick={resetInterfaceState}>
              {t("Очистить")}
            </Button>
          </Row>
          <Row label={t("Настройки по умолчанию")}>
            <Button variant="secondary" type="button" className={btnOutline} onClick={() => { updateSettings({ ...defaultSettings }); }}>
              {t("Вернуть")}
            </Button>
          </Row>
        </>
      );
    case "usage":
      return <UsageSettings />;
    case "keyboard":
      return (
        <>
          <div className="settings-search relative mb-3">
            <Field
              aria-label={t("Поиск по сочетаниям")}
              value={filter}
              onInput={(e) => setFilter(e.currentTarget.value)}
              placeholder={t("Поиск по сочетаниям")}
              className="search-field w-full"
            />
          </div>
          {([t("Общие"), t("Диалог"), t("Тест")] as const).map((g) => {
            const rows = keys.filter((k) => k.group === g);
            if (!rows.length) return null;
            return (
              <section key={g} className="mb-4">
                <h3 className="m-0 mb-1 text-xs font-medium text-ink-3">{g}</h3>
                <ul className="m-0 list-none p-0">
                  {rows.map((k) => (
                    <li key={k.label} className="flex items-center justify-between gap-4 border-b border-rule py-2 text-base last:border-b-0">
                      <span className="text-ink">{k.label}</span>
                      <kbd className="rounded-control border border-rule-2 px-2 py-0.5 font-sans text-xs text-ink-2">{k.keys}</kbd>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          {keys.length === 0 && <p className="m-0 text-md text-ink-3">{t("Ничего не найдено")}</p>}
        </>
      );
    case "about":
      return (
        <>
          {!hubMode && <TeacherModeRow />}
          <Row label="Graphy" desc={t("Учёба, которая оставляет след")}>
            <span className="text-sm text-ink-3">{`0.1.0 · Material Design 3 · ${t("агент")} ${version}`}</span>
          </Row>
          <Row label={t("Шрифты и иконки")} info={t("Roboto и Material Symbols (Apache-2.0), Instrument Serif и Playfair Display (SIL OFL), Lucide (ISC), Material Web (Apache-2.0), KaTeX (MIT)")}>
            <span />
          </Row>
        </>
      );
  }
}

const ALL_GROUPS: { id: string; label: string; sections: SettingsSection[] }[] = [
  { id: "app", label: "Приложение", sections: ["profile", "general", "appearance", "keyboard"] },
  { id: "learning", label: "Обучение", sections: ["agent", "skills", "memory"] },
  { id: "connect", label: "Подключение", sections: ["usage"] },
  { id: "system", label: "Система", sections: ["data", "about"] },
];
const SIMPLE_GROUPS: { id: string; label: string; sections: SettingsSection[] }[] = [
  { id: "app", label: "Приложение", sections: ["profile", "appearance"] },
  { id: "system", label: "Система", sections: ["about"] },
];
const GROUPS_UNUSED: { id: string; label: string; sections: SettingsSection[] }[] = [
  { id: "app", label: "Приложение", sections: ["profile", "general", "appearance", "keyboard"] },
  { id: "learning", label: "Обучение", sections: ["agent", "skills", "memory"] },
  { id: "connect", label: "Подключение", sections: ["usage"] },
  { id: "system", label: "Система", sections: ["data", "about"] },
];

const focusTitle = (page: HTMLElement | null) =>
  [...(page?.querySelectorAll<HTMLElement>("[data-settings-title]") ?? [])].find(el => el.getClientRects().length)?.focus({ preventScroll: true });

/** Settings as a page of their own (not a dialog): sections on the left, one section on the right, «Back» to where the learner came from.
 *  The workspace stays mounted underneath (inert), so drafts, reading position and a running agent are untouched. On a phone the list of sections and the chosen section are two screens. */
export function SettingsPage({ section, onSection, onUp, onClose, backLabel, onFirstRun, onOpenLesson }: {
  section: SettingsSection | null; onSection: (s: SettingsSection) => void; onUp: () => void; onClose: () => void; backLabel: string; onFirstRun: () => void; onOpenLesson: (id: string) => void;
}) {
  useLanguage();
  const [q, setQ] = useState("");
  const page = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const hubOn = useMax().hub;
  const detail = section !== null;
  const info = SECTIONS.find((s) => s.id === section);
  const title = info ? t(info.label) : t("Настройки");
  const hits = q.trim() ? INDEX.filter((i) => `${t(i.label)} ${i.words} ${t(i.words)}`.toLowerCase().includes(q.trim().toLowerCase())) : [];

  // opening: the focus moves to the title; leaving: it goes back to what had it (read when Settings were opened, see takeOpener)
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    focusTitle(page.current);
    return () => { alive.current = false; setTimeout(() => { if (!alive.current) returnFocus(); }, 0); }; // not when React only re-mounts the page in development
  }, []);
  // another section: the page starts from its top; on a phone the screen changed, so the focus follows it
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    scroller.current?.scrollTo({ top: 0 });
    if (!isPhone()) return;
    if (detail) focusTitle(page.current);
    else (page.current?.querySelector<HTMLElement>('.settings-nav md-list-item[aria-current="page"], .settings-nav md-list-item') ?? null)?.focus({ preventScroll: true });
  }, [section]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (s: SettingsSection, fromSearch = false) => {
    onSection(s);
    if (fromSearch) { setQ(""); requestAnimationFrame(() => focusTitle(page.current)); }
  };
  const item = (s: (typeof SECTIONS)[number]) => (
    <md-list-item key={s.id} type="button" data-section={s.id} aria-label={t(s.label)} aria-current={section === s.id ? "page" : undefined} onClick={() => choose(s.id)}>
      <span slot="start">{s.icon}</span><span slot="headline" className="settings-label">{t(s.label)}</span>
    </md-list-item>
  );

  return (
    <div ref={page} className={`settings-page${detail ? " settings-detail-open" : ""}`} role="region" aria-label={t("Настройки")} data-settings-page data-section={section ?? "list"}>
      <div className="mobile-settings-header">
        <IconButton variant="ghost" data-no-ripple aria-label={detail ? t("Назад к разделам") : backLabel} onClick={detail ? onUp : onClose}><md-icon aria-hidden="true">arrow_back</md-icon></IconButton>
        <h1 tabIndex={-1} data-settings-title>{title}</h1>
        <span className="mobile-settings-header-end" aria-hidden="true" />
      </div>
      <aside className="settings-side">
        <div className="settings-back-row">
          <button type="button" className="settings-back" data-settings-back data-no-ripple onClick={onClose}>
            <md-icon aria-hidden="true">arrow_back</md-icon>
            <span>{backLabel}</span>
          </button>
        </div>
        <nav className="settings-nav scroll-y" aria-label={t("Разделы настроек")}>
          <div className="settings-search relative">
            <Field
              aria-label={t("Поиск по настройкам")}
              value={q}
              onInput={(e) => setQ(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Escape" && q) { e.preventDefault(); setQ(""); } }}
              placeholder={t("Поиск по настройкам")}
              className="search-field w-full"
            />
          </div>
          {q.trim() ? (
            <ul className="settings-hits" aria-label={t("Результаты поиска")}>
              {hits.map((h) => (
                <li key={t(h.label)}>
                  <button data-material-disclosure type="button" className="settings-hit" onClick={() => choose(h.section, true)}>
                    <md-ripple /><md-focus-ring />
                    <span className="settings-hit-title">{t(h.label)}</span>
                    <span className="settings-hit-where">{t(SECTIONS.find((s) => s.id === h.section)?.label ?? "")}</span>
                  </button>
                </li>
              ))}
              {hits.length === 0 && <li className="settings-hits-empty">{t("Ничего не найдено")}</li>}
            </ul>
          ) : (
            (hubOn ? SIMPLE_GROUPS : ALL_GROUPS).map((g) => (
              <div key={g.id} className="settings-group">
                <div className="settings-group-title" aria-hidden="true">{t(g.label)}</div>
                <md-list aria-label={t(g.label)}>
                  {g.sections.filter((id) => id !== "profile" || hubOn).map((id) => item(SECTIONS.find((s) => s.id === id)!))}
                </md-list>
              </div>
            ))
          )}
        </nav>
      </aside>
      <div className="settings-main scroll-y" ref={scroller} data-settings-scroll>
        <div className="settings-column">
          <header className="settings-head">
            <h1 tabIndex={-1} data-settings-title>{title}</h1>
            {info && <p>{t(info.blurb)}</p>}
          </header>
          <div className="settings-body">
            {section && <Body section={section} onFirstRun={onFirstRun} onOpenLesson={onOpenLesson} />}
          </div>
        </div>
      </div>
    </div>
  );
}

export type { Settings };
