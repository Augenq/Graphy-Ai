import { IconButton } from "./ui/index";
import { t } from "../lib/i18n";
import { SidebarSimple, MagnifyingGlass, Gear, NotePencil, GraduationCap } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { del, sessionPath } from "../lib/api";
import { renameLesson } from "../lib/engine";
import { removeSession, useStoreStable } from "../lib/store";
import { useLessonMarks } from "../lib/lesson-state";
import { GraphyMark } from "./GraphyMark";
import { LessonRow, StateSection, type Row, rowGroup, rowOf, rowsEqual } from "./SidebarSections";
import { Tip } from "./Tip";
import { DeleteDialog } from "./DeleteDialog";
import { RenameDialog } from "./RenameDialog";
import { useMax } from "../lib/max";
/** Recent chats split by age. «This week» = from 6 days before today's local midnight up to yesterday (the last 7 calendar days including today). Rows arrive newest first. */
function recencyGroups(rows: Row[], now: Date): { label: string; rows: Row[] }[] {
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  const today = new Date(y, m, d).getTime(), yesterday = new Date(y, m, d - 1).getTime(), week = new Date(y, m, d - 6).getTime();
  const labels = [t("Сегодня"), t("Вчера"), t("На этой неделе"), t("Раньше")];
  const buckets: Row[][] = [[], [], [], []];
  for (const r of rows) buckets[r.updatedAt >= today ? 0 : r.updatedAt >= yesterday ? 1 : r.updatedAt >= week ? 2 : 3].push(r);
  return buckets.flatMap((b, i) => b.length ? [{ label: labels[i], rows: b }] : []);
}
interface Props {
  view: "home" | "lesson" | "study" | "school"; activeId: string | null;
  onNew: () => void; onSearch: () => void; onSchool?: () => void;
  onOpen: (id: string) => void; onSettings: () => void; onToggle: () => void;
}
export function Sidebar({ view, activeId, onNew, onSearch, onSchool, onOpen, onSettings, onToggle }: Props) {
  // only the fields a row shows: a stream flush in the open lesson changes none of them (see useStoreStable)
  const started = useStoreStable(st => st.order.map(id => st.sessions[id]).filter(x => x && (x.said > 0 || x.blocks.length > 0)).map(rowOf).sort((a, b) => b.updatedAt - a.updatedAt), rowsEqual);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [doomed, setDoomed] = useState<{ id: string; title: string } | null>(null);
  const max = useMax();
  const schoolOn = max.hub && (max.user?.role === "teacher" || max.user?.role === "student");
  const marks = useLessonMarks();
  const byGroup = (g: ReturnType<typeof rowGroup>) => started.filter(r => rowGroup(r, marks) === g);
  const recent = byGroup("recent");
  const [, setDay] = useState(() => new Date().getDate());
  useEffect(() => { // regroup at local midnight and when the tab comes back to the front
    const tick = () => setDay(new Date().getDate());
    const next = new Date(); next.setHours(24, 0, 1, 0);
    const timer = setTimeout(tick, next.getTime() - Date.now());
    document.addEventListener("visibilitychange", tick);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", tick); };
  }, [new Date().getDate()]); // eslint-disable-line react-hooks/exhaustive-deps
  const recentGroups = recencyGroups(recent, new Date());
  const onRename = useCallback((id: string, title: string) => setRenaming({ id, title }), []);
  const onDelete = useCallback((id: string, title: string) => setDoomed({ id, title }), []);
  const section = { activeId, view, onOpen, onRename, onDelete };
  return <nav data-sidebar aria-label={t("Мои чаты")} className="flex h-full w-full flex-col bg-rail px-2">
    <div className="drag chrome sidebar-brand flex h-12 shrink-0 items-center gap-3" style={{ paddingLeft: 12 }}>
      <span className="sidebar-logo"><GraphyMark size={22} /><span className="graphy-wordmark text-3xl leading-8">Graphy</span></span>
      <span className="flex-1" />
      <Tip label={t("Скрыть боковую панель")} hint="Ctrl \\"><IconButton variant="ghost" data-no-ripple aria-label={t("Скрыть боковую панель")} onClick={onToggle}><SidebarSimple aria-hidden="true" className="size-4" /></IconButton></Tip>
    </div>
    <button type="button" className="new-lesson" onClick={onNew} aria-current={view === "home" ? "page" : undefined} aria-keyshortcuts="Control+N">
      <NotePencil aria-hidden="true" className="new-lesson-icon" /><span className="new-lesson-label">{t("Новое занятие")}</span><kbd>Ctrl N</kbd>
    </button>
    <md-list className="sidebar-actions shrink-0">
      <md-list-item type="button" onClick={onSearch}><span slot="start"><MagnifyingGlass aria-hidden="true" className="size-4" /></span><span slot="headline">{t("Поиск")}</span><kbd slot="end" className="text-xs text-ink-3">Ctrl K</kbd></md-list-item>
      {schoolOn && onSchool && <md-list-item type="button" data-school-nav onClick={onSchool} aria-current={view === "school" ? "page" : undefined}><span slot="start"><GraduationCap aria-hidden="true" className="size-4" /></span><span slot="headline">{t("Школа")}</span></md-list-item>}
    </md-list>
    <md-divider />
    <div className="my-chats-head"><h2 className="sidebar-recent-title md-typescale-label-large m-0 px-3 pb-1 text-ink-3">{t("Мои чаты")}</h2></div>
    <div className="scroll-y min-h-0 flex-1">
      <StateSection id="pinned" title={t("Закреплённые")} items={byGroup("pinned")} {...section} />
      <StateSection id="active" title={t("Идёт")} items={byGroup("active")} {...section} />
      <div className="sidebar-recent">
        {recentGroups.map(g => <div key={g.label} role="group" aria-label={g.label} data-recency={g.label}>
          <h3 className="recency-head">{g.label}</h3>
          <md-list>{g.rows.map(r => <LessonRow key={r.id} r={r} current={view === "lesson" && r.id === activeId} onOpen={onOpen} onRename={onRename} onDelete={onDelete} />)}</md-list>
        </div>)}
        {started.length === 0 && <p className="m-0 px-4 py-2 text-sm text-ink-3">{t("Пока нет занятий")}</p>}
      </div>
      <StateSection id="finished" title={t("Завершённые")} items={byGroup("finished")} foldable startFolded {...section} />
    </div>
    <md-divider />
    <md-list className="sidebar-actions shrink-0 py-2"><md-list-item type="button" onClick={onSettings}><span slot="start"><Gear aria-hidden="true" className="size-4" /></span><span slot="headline">{t("Настройки")}</span><kbd slot="end" className="text-xs text-ink-3">Ctrl ,</kbd></md-list-item></md-list>
    {renaming && <RenameDialog
      title={t("Переименовать занятие")}
      label={t("Название занятия")}
      initial={renaming.title}
      onSave={async name => { await renameLesson(renaming.id, name, true); }}
      onClose={() => setRenaming(null)}
    />}
    {doomed && <DeleteDialog
      title={t("Удалить занятие?")}
      text={t("Занятие «{0}» будет удалено с этого компьютера. Это нельзя отменить.", [doomed.title])}
      onConfirm={async () => { await del(sessionPath(doomed.id)); removeSession(doomed.id); }}
      onClose={() => setDoomed(null)}
    />}
  </nav>;
}
