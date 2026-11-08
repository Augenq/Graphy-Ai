import { Field, IconButton } from "./ui/index";
import { t, useLanguage } from "../lib/i18n";
import { isImeKey } from "../lib/ime";

import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { matchScore, pushRecent, readRecents } from "../lib/commands";
import { setLessonModel } from "../lib/engine";
import { useRemote } from "../lib/remote";
import { updateSettings, getSettings } from "../lib/settings";
import { useStore } from "../lib/store";
import type { SettingsSection } from "../lib/settings-route";
import { Modal } from "./Modal";
import { fmtAgo } from "./ui";

interface Props {
  onClose: () => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onSettings: () => void;
  onSchool?: () => void;
  onSettingsSection?: (section: SettingsSection) => void;
}

interface Item {
  key: string;
  icon: "chat" | "new" | "gear" | "style" | "model" | "theme" | "skills" | "reasoning";
  /** palette section the row sits in */
  section?: "recent" | "lessons" | "actions";
  title: string;
  /** extra words that find the row */
  words?: string;
  /** shortcut hint on the right */
  hint?: string;
  meta: string;
  snippet?: string;
  run: () => void;
}

const ICONS = {
  chat: <md-icon aria-hidden="true" className="" >folder</md-icon>,
  new: <md-icon aria-hidden="true" className="" >edit_square</md-icon>,
  gear: <md-icon aria-hidden="true" className="" >settings</md-icon>,
  style: <md-icon aria-hidden="true">school</md-icon>,
  model: <md-icon aria-hidden="true">model_training</md-icon>,
  theme: <md-icon aria-hidden="true">contrast</md-icon>,
  skills: <md-icon aria-hidden="true">extension</md-icon>,
  reasoning: <md-icon aria-hidden="true">psychology</md-icon>,
};

const SECTION_LABELS: [SettingsSection, string, string][] = [
  ["general", "Общие", "язык language"], ["appearance", "Внешний вид", "тема палитра цвета размер текста ширина"], ["models", "Модели и провайдеры", "провайдер ключ api"],
  ["agent", "Агент", "стиль объяснение веб-поиск изображения"], ["skills", "Навыки", "skills скиллы"], ["memory", "Память", "memory воспоминания"], ["data", "Данные и приватность", "приватность сброс"], ["usage", "Использование", "токены стоимость расход"],
  ["keyboard", "Клавиатура", "горячие клавиши shortcuts"], ["about", "О программе", "версия лицензии"],
];
type Tab = "all" | "chats" | "actions" | "settings";
const TABS: [Tab, string][] = [["all", "Все"], ["chats", "Чаты"], ["actions", "Действия"], ["settings", "Настройки"]];
const tabOf = (key: string): Tab => { const k = key.replace(/^r:/, ""); return k.startsWith("a:sec:") ? "settings" : k.startsWith("a:") ? "actions" : "chats"; };

const SECTION_TITLES: Record<NonNullable<Item["section"]>, string> = { recent: "Недавнее", lessons: "Занятия", actions: "Действия" };

function snippet(text: string, q: string) {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return undefined;
  const s = text.slice(Math.max(0, i - 30), i + 70).replace(/\s+/g, " ").replace(/[$#*`>]/g, "");
  return (i > 30 ? "…" : "") + s;
}

/** Ctrl+K: lessons by title and by what was said in them, plus the main actions. */
export function SearchPalette({ onClose, onOpen, onNew, onSettings, onSchool, onSettingsSection }: Props) {
  const language = useLanguage();
  const sessions = useStore((s) => s.sessions);
  const order = useStore((s) => s.order);
  const models = useRemote((r) => r.models);
  const activeId = useStore((s) => s.activeId);
  const active = useStore((s) => (s.activeId ? s.sessions[s.activeId] : undefined));
  const [recents, setRecents] = useState(readRecents);
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const [tab, setTab] = useState<Tab>("all");
  const [keyboardSelection, setKeyboardSelection] = useState(false);
  const results = useRef<HTMLUListElement>(null);

  const all = useMemo<Item[]>(() => {
    const query = q.trim().toLowerCase();
    const lessons: Item[] = order
      .map((id) => sessions[id])
      .filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .flatMap((s) => {
        const body = s.blocks.map((b) => (b.kind === "user" || b.kind === "text" ? b.text : "")).join(" ");
        const inTitle = !query || matchScore(query, s.title) !== null;
        const snip = query ? snippet(body, query) : undefined;
        if (query && !inTitle && !snip) return [];
        return [{ key: s.id, icon: "chat" as const, title: s.title, meta: fmtAgo(s.updatedAt), snippet: inTitle ? undefined : snip, run: () => onOpen(s.id) }];
      });
    const dark = document.documentElement.dataset.theme === "dark";
    const actions: Item[] = [
      { key: "a:new", icon: "new", title: t("Новое занятие"), meta: "", hint: "Ctrl N", run: onNew, words: "new lesson создать начать" },
      ...(onSchool ? [{ key: "a:school", icon: "style" as const, title: t("Школа"), meta: "", run: onSchool, words: "school школа задания тесты материалы" }] : []),
      { key: "a:settings", icon: "gear", title: t("Настройки"), meta: "", hint: "Ctrl ,", run: onSettings, words: "settings параметры" },
      ...(onSettingsSection ? SECTION_LABELS.map(([id, label, words]): Item => ({ key: `a:sec:${id}`, icon: "gear", title: t("Настройки: {0}", [t(label)]), meta: "", hint: id === "keyboard" ? "Ctrl /" : undefined, run: () => onSettingsSection(id), words })) : []),
      { key: "a:theme", icon: "theme", title: dark ? t("Включить светлую тему") : t("Включить тёмную тему"), meta: "", run: () => updateSettings({ theme: dark ? "light" : "dark" }), words: "theme тема светлая тёмная dark light" },
      ...(getSettings().theme !== "system" ? [{ key: "a:theme-system", icon: "theme" as const, title: t("Тема как в системе"), meta: "", run: () => updateSettings({ theme: "system" }), words: "theme тема system" }] : []),
    ];
    if (active && activeId) {
      const current = models.find((m) => m.id === active.model);
      for (const level of current?.thinking_levels ?? []) if (level !== active.thinking && (current?.thinking_levels.length ?? 0) > 1) actions.push({ key: `a:think:${level}`, icon: "reasoning", title: t("Рассуждение: {0}", [level]), meta: current?.name ?? "", run: () => void setLessonModel(activeId, active.model, level), words: "reasoning thinking рассуждение глубина" });
      // models are many: they show once something is typed
      if (query) for (const m of models) if (m.id !== active.model && m.tools) actions.push({ key: `a:model:${m.id}`, icon: "model", title: t("Модель: {0}", [m.name]), meta: m.provider, run: () => void setLessonModel(activeId, m.id), words: `model модель ${m.id}` });
    }
    const scored = (list: Item[], section: Item["section"]) =>
      list.flatMap((it) => {
        const score = matchScore(query, it.title, `${it.words ?? ""} ${it.meta}`);
        return score === null ? [] : [{ it: { ...it, section }, score }];
      });
    const acts = scored(actions, "actions").sort((a, b) => b.score - a.score).map((x) => x.it);
    if (query) {
      // a lesson found by text first, then actions by how well they match
      const lessonScores = lessons.map((l) => ({ l, score: matchScore(query, l.title) ?? -1 }));
      lessonScores.sort((a, b) => b.score - a.score);
      return [...lessonScores.map((x) => ({ ...x.l, section: "lessons" as const })), ...acts].slice(0, 80);
    }
    const byKey = new Map([...lessons, ...actions].map((it) => [it.key, it]));
    const recent = recents.flatMap((k) => (byKey.has(k) ? [{ ...byKey.get(k)!, section: "recent" as const, key: `r:${k}` }] : []));
    const recentKeys = new Set(recents);
    return [...recent, ...lessons.filter((l) => !recentKeys.has(l.key)).slice(0, 30).map((l) => ({ ...l, section: "lessons" as const })), ...acts.filter((a) => !recentKeys.has(a.key))];
  }, [q, order, sessions, models, active, activeId, recents, onOpen, onNew, onSettings, onSchool, onSettingsSection, language]);

  const items = useMemo(() => tab === "all" ? all : all.filter(it => tabOf(it.key) === tab), [all, tab]);
  const cycle = (dir: 1 | -1) => { setTab(TABS[(TABS.findIndex(([id]) => id === tab) + dir + TABS.length) % TABS.length][0]); setIndex(0); };

  const run = (it: Item | undefined) => {
    if (!it) return;
    onClose();
    setRecents(pushRecent(it.key.replace(/^r:/, "")));
    it.run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isImeKey(e)) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") setKeyboardSelection(true);
    if (e.key === "ArrowDown") (e.preventDefault(), setIndex((i) => Math.max(0, Math.min(items.length - 1, i + 1))));
    else if (e.key === "ArrowUp") (e.preventDefault(), setIndex((i) => Math.max(0, i - 1)));
    else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && q === "" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) (e.preventDefault(), cycle(e.key === "ArrowRight" ? 1 : -1));
    else if (e.key === "Enter" && !isImeKey(e)) (e.preventDefault(), run(items[index]));
  };

  useEffect(() => {
    results.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index]);

  return <Modal label={t("Поиск")} onClose={onClose} top size="search" className="search-dialog-layout">
    <div className="palette-search-bar">
      <Field data-autofocus autoFocus type="search" role="combobox" aria-expanded="true" aria-controls="palette-list"
        aria-activedescendant={items[index] ? `pal-${items[index].key}` : undefined} aria-label={t("Поиск по занятиям")}
        value={q} onInput={e => { setQ(e.currentTarget.value); setIndex(0); setKeyboardSelection(false); }} onKeyDown={onKeyDown}
        placeholder={t("Занятие, действие, стиль, модель, настройка…")} className="search-field palette-search">
        <md-icon slot="leading-icon" aria-hidden="true">search</md-icon>
      </Field>
      <IconButton variant="ghost" aria-label={t("Закрыть поиск")} onClick={onClose}><md-icon aria-hidden="true">close</md-icon></IconButton>
    </div>
    <div role="tablist" aria-label={t("Разделы поиска")} className="palette-tabs">
      {TABS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} aria-controls="palette-list" tabIndex={tab === id ? 0 : -1} className="palette-tab" onClick={() => { setTab(id); setIndex(0); }}>{t(label)}</button>)}
    </div>
    <ul ref={results} id="palette-list" role="listbox" aria-label={t("Результаты поиска")} className="palette-results scroll-y">
      {items.length === 0 && <li className="px-4 py-8 text-center text-base text-ink-3">{t("Ничего не найдено по запросу «{0}»", [q])}</li>}
      {items.map((it, i) => <Fragment key={it.key}>
        {it.section && it.section !== items[i - 1]?.section && <li role="presentation" className="palette-section">{t(SECTION_TITLES[it.section])}</li>}
        <li id={`pal-${it.key}`} role="option" aria-selected={i === index} onClick={() => run(it)} onMouseMove={() => keyboardSelection && setKeyboardSelection(false)}
          className={`search-result ${keyboardSelection && i === index ? "keyboard-selected" : ""}`}>
          <span className="shrink-0 text-ink-2">{ICONS[it.icon]}</span>
          <span className="min-w-0 flex-1"><span className="block truncate text-md text-ink">{it.title}</span>
            {(it.snippet ?? it.meta) && <span className="mt-1 block truncate text-sm text-ink-3">{it.snippet ?? it.meta}</span>}
          </span>
          {it.hint ? <kbd className="palette-hint">{it.hint}</kbd> : <md-icon aria-hidden="true" className="text-ink-3">north_west</md-icon>}
        </li>
      </Fragment>)}
    </ul>
    <div className="palette-footer text-xs text-ink-3"><span className="palette-keys"><kbd>↑</kbd><kbd>↓</kbd>{t("Выбрать")}</span><span className="palette-keys"><kbd>↵</kbd>{t("Открыть")}</span><span className="palette-keys"><kbd>esc</kbd>{t("закрыть")}</span>{q === "" && <span className="palette-keys ml-auto"><kbd>←</kbd><kbd>→</kbd>{t("Разделы поиска")}</span>}</div>
  </Modal>;
}
