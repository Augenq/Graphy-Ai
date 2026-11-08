import { useEffect, useRef, useState, type ReactNode } from "react";
import { CaretDown, File as FileIcon, FolderSimple, Image as ImageIcon, BookOpen } from "@phosphor-icons/react";
import { t } from "../lib/i18n";
import { useOpenFile } from "../lib/presented";
import { type Attachment, type Session } from "../lib/types";
import { FileViewer } from "./PresentedFile";

type PanelMode = "rail" | "file";

interface Props {
  session: Session;
  /** the chat area is too narrow for a column beside it */
  narrow?: boolean;
}

type StepStatus = "done" | "cur" | "later";

function PlanGraph({ session }: { session: Session }) {
  const plan = session.plan;
  if (!plan || plan.steps.length === 0) return null;
  const statusOf = (i: number): StepStatus => (i < plan.current ? "done" : i === plan.current ? "cur" : "later");
  return (
    <section className="plan-graph" aria-label={t("План")}>
      <div className="plan-graph-head">
        <span className="plan-graph-title">{t("План")}</span>
        <span className="plan-graph-meta">{Math.min(plan.current, plan.steps.length)} / {plan.steps.length}</span>
      </div>
      {plan.goal ? <p className="plan-graph-goal">{plan.goal}</p> : null}
      <ol className="plan-graph-flow">
        {plan.steps.map((step, i) => {
          const st = statusOf(i);
          const last = i === plan.steps.length - 1;
          return (
            <li key={`${i}-${step}`} className="plan-graph-node" data-status={st} aria-current={st === "cur" ? "step" : undefined}>
              <div className="plan-graph-track" aria-hidden="true">
                <span className="plan-graph-dot" />
                {!last && <span className="plan-graph-line" />}
              </div>
              <div className="plan-graph-block">
                <span className="plan-graph-index">{i + 1}</span>
                <span className="plan-graph-text">{step}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Card({ id, title, meta, children, defaultOpen = true }: { id: string; title: string; meta?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rail-card" data-rail-card={id}>
      <button type="button" className="rail-card-title" aria-expanded={open} aria-controls={`rail-${id}`} onClick={() => setOpen((v) => !v)}>
        <span>{title}</span>
        <CaretDown aria-hidden="true" className={`rail-chevron ${open ? "" : "is-closed"}`} />
        {meta != null && <span className="rail-card-meta">{meta}</span>}
      </button>
      <div id={`rail-${id}`} className="rail-card-body" hidden={!open}>{children}</div>
    </section>
  );
}



function PlanCard({ session }: { session: Session }) {
  return <PlanGraph session={session} />;
}

const sizeOf = (n?: number) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const iconFor = (k: Attachment["kind"]) => (k === "image" ? ImageIcon : k === "folder" ? FolderSimple : k === "course" ? BookOpen : FileIcon);

function MaterialsCard({ session }: { session: Session }) {
  const [all, setAll] = useState(false);
  const seen = new Set<string>();
  const files = session.blocks.flatMap((b) => (b.kind === "user" ? b.attachments : [])).filter((f) => !seen.has(f.id) && !!seen.add(f.id));
  const shown = all ? files : files.slice(0, 4);
  if (files.length === 0) return null;
  return (
    <Card id="materials" title={t("Материалы")} meta={files.length ? files.length : undefined}>
      <ul className="rail-rows">
          {shown.map((f) => {
            const Icon = iconFor(f.kind);
            return (
              <li key={f.id} className="rail-row">
                <Icon aria-hidden="true" className="rail-row-icon" />
                <span className="rail-row-name" title={f.name}>{f.name}</span>
                <span className="rail-row-val">{sizeOf(f.size)}</span>
              </li>
            );
          })}
      </ul>
      {files.length > 4 && <button type="button" className="rail-more" onClick={() => setAll((v) => !v)}>{all ? t("Свернуть") : t("Показать ещё")}</button>}
    </Card>
  );
}

/**
 * The right column of the chat: a rail of compact cards (only those with content), or, while a file the agent
 * presented is open, the file viewer in its place. Closing the viewer brings the rail back.
 */
export function Panel({ session, narrow }: Props) {
  const lessonId = session.id;
  const loaded = session.loaded;
  const file = useOpenFile(session.id);
  const hasPlan = !!session.plan?.steps.length;
  const hasFiles = session.blocks.some((b) => b.kind === "user" && b.attachments.length > 0);
  const target: PanelMode | null = file ? "file" : !hasPlan && (narrow || !hasFiles) ? null : "rail";
  // keep the last content mounted while the column slides out
  const [shown, setShown] = useState<PanelMode | null>(target);
  const [phase, setPhase] = useState<"idle" | "enter" | "exit">("idle");
  const prev = useRef(target);
  const seen = useRef<string | null>(null);
  // width easing between rail and file switches on only once the lesson has settled, so loading never slides
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    if (!loaded) return;
    const id = window.setTimeout(() => setArmed(true), 400);
    return () => window.clearTimeout(id);
  }, [loaded, lessonId]);
  useEffect(() => {
    const was = prev.current;
    prev.current = target;
    // opening a lesson is not a user toggle: show the final state without sliding
    if (!loaded || seen.current !== lessonId) {
      seen.current = loaded ? lessonId : null;
      setShown(target);
      setPhase("idle");
      return;
    }
    if (target) {
      setShown(target);
      setPhase(was ? "idle" : "enter");
    } else if (was) {
      setPhase("exit");
      const id = window.setTimeout(() => (setShown(null), setPhase("idle")), 260);
      return () => window.clearTimeout(id);
    }
  }, [target, loaded, lessonId]);
  const mode = target ?? shown;
  // the viewer mounts once the column has finished widening, otherwise its first render stalls the slide
  const [body, setBody] = useState<PanelMode | null>(mode);
  useEffect(() => {
    if (mode === "file" && body === "rail" && armed) {
      const id = window.setTimeout(() => setBody("file"), 360);
      return () => window.clearTimeout(id);
    }
    if (mode && body !== mode) setBody(mode);
  }, [mode, body, armed]);
  // the last file stays mounted while the column slides out
  const lastFile = useRef(file);
  if (file) lastFile.current = file;
  if (!mode) return null;
  const content = body ?? mode;
  const cls = `lesson-panel${armed ? " is-armed" : ""}${phase === "enter" ? " is-enter" : phase === "exit" ? " is-exit" : ""}`;
  if (content === "file" && lastFile.current) {
    return (
      <aside data-lesson-panel data-mode={mode} aria-label={t("Панель занятия")} className={cls}>
        <FileViewer sessionId={session.id} file={lastFile.current} />
      </aside>
    );
  }
  return (
    <aside data-lesson-panel data-mode={mode} aria-label={t("Панель занятия")} className={cls}>
      <div className="rail scroll-y">
        <PlanCard session={session} />
        <MaterialsCard session={session} />
      </div>
    </aside>
  );
}
