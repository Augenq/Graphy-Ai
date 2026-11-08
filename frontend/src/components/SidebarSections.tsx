import { Check, CaretDown, CaretRight, PushPin } from "@phosphor-icons/react";
import { memo, useEffect, useRef, useState, type FocusEvent } from "react";
import { DotsThree } from "@phosphor-icons/react";
import { Menu } from "./Menu";
import { IconButton } from "./ui/index";
import { t } from "../lib/i18n";
import { setDone, togglePinned, useLessonMarks, type LessonGroup } from "../lib/lesson-state";
import { hasOpenQuestion, isBusy, type Session } from "../lib/types";
import { Constellation } from "./Constellation";
import { fmtAgo } from "./ui";

/** A truncated title is shown in full next to its row while the row has keyboard focus (CSS reads data-cut; a mouse has the title tooltip). */
export function markCut(e: FocusEvent<HTMLElement>) {
  const head = e.currentTarget.querySelector<HTMLElement>('[slot="headline"]');
  e.currentTarget.toggleAttribute("data-cut", !!head && head.scrollWidth > head.clientWidth);
}

/** Pinning moves the row to another group and remounts it: put the focus back on the same row's pin button once it is rendered again. */
function keepFocus(id: string) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>(`md-list-item[data-lesson-id="${CSS.escape(id)}"]`);
    (row?.querySelector<HTMLElement>(".sidebar-pin") ?? row)?.focus({ preventScroll: true });
  }));
}

/** What a sidebar row needs from a lesson: primitives only, so the list re-renders when one of them changes and not on every stream flush. */
export interface Row { id: string; title: string; updatedAt: number; finished: boolean; busy: boolean; waiting: boolean; openQuestion: boolean }
export const rowOf = (s: Session): Row => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, finished: s.finished, busy: isBusy(s.agent), waiting: s.agent.kind === "waiting", openQuestion: hasOpenQuestion(s) });
export const rowEqual = (a: Row, b: Row) => a.id === b.id && a.title === b.title && a.updatedAt === b.updatedAt && a.finished === b.finished && a.busy === b.busy && a.waiting === b.waiting && a.openQuestion === b.openQuestion;
export const rowsEqual = (a: Row[], b: Row[]) => a.length === b.length && a.every((r, i) => rowEqual(r, b[i]));
export const rowActive = (r: Row) => r.busy || r.openQuestion || r.waiting;
export function rowGroup(r: Row, marks: ReturnType<typeof useLessonMarks>): LessonGroup {
  if (marks.pinned.includes(r.id)) return "pinned";
  if ((marks.done[r.id] ?? r.finished) && !rowActive(r)) return "finished";
  return rowActive(r) ? "active" : "recent";
}

/** State icon of a lesson row: waiting for a test, working, finished, or just «unread». */
function RowState({ r, unread, done }: { r: Row; unread: boolean; done: boolean }) {
  if (r.openQuestion) return <md-icon role="img" aria-label={t("Ждёт ответов в тесте")} className="text-warn-ui">pending</md-icon>;
  if (r.busy) return <span role="img" aria-label={t("Идёт ответ")}><Constellation /></span>;
  if (unread) return <span role="img" aria-label={t("Есть непрочитанный ответ")} className="unread-dot" />;
  if (done) return <Check role="img" aria-label={t("Завершено")} className="size-4" />;
  return <span aria-hidden="true" className="read-dot" />;
}

/** The «…» button of a row: rename and delete (lessons also pin and mark finished). The row itself stays a button, so a click here must not open it.
 *  The menu machinery mounts on first use: a pointer over the button, or its activation by click / Enter / Space. Tabbing onto the button only focuses it,
 *  so focus is never moved; on activation the freshly mounted trigger takes the focus back before it opens the menu. */
function RowMenu({ r, pinned, done, onRename, onDelete }: { r: Row; pinned: boolean; done: boolean; onRename: (id: string, title: string) => void; onDelete: (id: string, title: string) => void }) {
  const [armed, setArmed] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const openAfterMount = useRef(false);
  useEffect(() => {
    if (armed && openAfterMount.current) {
      openAfterMount.current = false;
      const trigger = box.current?.querySelector<HTMLElement>("button");
      trigger?.focus({ preventScroll: true });
      trigger?.click();
    }
  }, [armed]);
  const label = t("Действия с занятием «{0}»", [r.title]);
  const guard = { onClick: (e: React.MouseEvent) => e.stopPropagation(), onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); } };
  // the menu lives inside the row: neither its clicks nor Enter/Space on its items may reach the row
  if (!armed) {
    return <span ref={box} className="row-menu" {...guard} onPointerEnter={() => setArmed(true)}>
      <IconButton variant="ghost" className="sidebar-delete" aria-label={label} aria-haspopup="menu" aria-expanded={false}
        onClick={(e: React.MouseEvent) => { e.stopPropagation(); openAfterMount.current = true; setArmed(true); }}><DotsThree aria-hidden="true" weight="bold" className="size-4" /></IconButton>
    </span>;
  }
  return <span ref={box} className="row-menu" {...guard}><Menu label={label} width={200} align="end"
    items={[{ id: "pin", label: pinned ? t("Открепить") : t("Закрепить"), icon: <md-icon aria-hidden="true">{pinned ? "keep_off" : "keep"}</md-icon> },
      { id: "done", label: done ? t("Вернуть в работу") : t("Отметить завершённым"), icon: <md-icon aria-hidden="true">{done ? "undo" : "task_alt"}</md-icon> },
      { id: "rename", label: t("Переименовать"), icon: <md-icon aria-hidden="true">edit</md-icon> },
      { id: "delete", label: t("Удалить"), icon: <md-icon aria-hidden="true">delete</md-icon> }]}
    onSelect={id => id === "rename" ? onRename(r.id, r.title) : id === "delete" ? onDelete(r.id, r.title) : id === "pin" ? togglePinned(r.id) : setDone(r.id, !done)}
    trigger={({ onClick, ...p }) => <IconButton variant="ghost" {...p} className="sidebar-delete" aria-label={label}
      onClick={(e: React.MouseEvent) => { e.stopPropagation(); onClick(); }}><DotsThree aria-hidden="true" weight="bold" className="size-4" /></IconButton>} /></span>;
}

interface RowProps {
  r: Row;
  current: boolean;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string, title: string) => void;
}

/** One lesson in the sidebar: title, state, age and the «…» menu. Memoized: only a change in its own lesson (or the marks) renders it again. */
export const LessonRow = memo(function LessonRow({ r, current, onOpen, onRename, onDelete }: RowProps) {
  const marks = useLessonMarks();
  const unread = marks.unread.includes(r.id) && !current;
  const pinned = marks.pinned.includes(r.id);
  const done = marks.done[r.id] ?? r.finished;
  return (
    <md-list-item type="button" title={r.title} data-lesson-id={r.id} onFocus={markCut} data-unread={unread ? "" : undefined} aria-current={current ? "page" : undefined} onClick={() => onOpen(r.id)}>
      <span slot="headline" className={`block truncate text-base ${unread ? "font-medium text-ink" : ""}`}>
        {pinned && <PushPin aria-hidden="true" weight="fill" className="mr-1 inline size-3 align-[-1px] text-ink-3" />}
        {r.title}
      </span>
      <span slot="end" className="sidebar-session-meta">
        <RowState r={r} unread={unread} done={done} />
        <span>{fmtAgo(r.updatedAt)}</span>
        <span className="row-pin" onClick={e => e.stopPropagation()} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); }}>
          <IconButton variant="ghost" className="sidebar-pin" aria-pressed={pinned} aria-label={t("Закрепить")} onClick={(e: React.MouseEvent) => { e.stopPropagation(); togglePinned(r.id); keepFocus(r.id); }}>
            <PushPin aria-hidden="true" weight={pinned ? "fill" : "regular"} className="size-3.5" />
          </IconButton>
        </span>
        <RowMenu r={r} pinned={pinned} done={done} onRename={onRename} onDelete={onDelete} />
      </span>
    </md-list-item>
  );
}, (a, b) => rowEqual(a.r, b.r) && a.current === b.current && a.onOpen === b.onOpen && a.onRename === b.onRename && a.onDelete === b.onDelete);

interface SectionProps {
  id: "pinned" | "active" | "finished";
  title: string;
  items: Row[];
  activeId: string | null;
  view: string;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string, title: string) => void;
  /** the section can be folded (Finished starts folded) */
  foldable?: boolean;
  startFolded?: boolean;
}

/** A flat group of chats: Pinned, Active (working or waiting for you), Finished. */
export function StateSection({ id, title, items, activeId, view, onOpen, onRename, onDelete, foldable, startFolded }: SectionProps) {
  const [folded, setFolded] = useState(!!startFolded);
  if (!items.length) return null;
  const head = (
    <h2 className="md-typescale-label-large m-0 px-3 pb-1 pt-2 text-ink-3">{title}</h2>
  );
  return (
    <div role="group" aria-label={title} data-state-section={id}>
      {foldable ? (
        <button type="button" className="state-section-head" aria-expanded={!folded} onClick={() => setFolded((v) => !v)}>
          {folded ? <CaretRight aria-hidden="true" className="size-3" /> : <CaretDown aria-hidden="true" className="size-3" />}
          <span>{title}</span>
          <span className="state-section-count">{items.length}</span>
        </button>
      ) : head}
      {!folded && (
        <md-list>
          {items.map((r) => (
            <LessonRow key={r.id} r={r} current={view === "lesson" && r.id === activeId} onOpen={onOpen} onRename={onRename} onDelete={onDelete} />
          ))}
        </md-list>
      )}
    </div>
  );
}
