import { Button } from "./ui/index";
import { CaretRight } from "@phosphor-icons/react";
import { Disclosure } from "./Disclosure";
import { CopyButton } from "./CopyButton";
import { locale, t, useLanguage } from "../lib/i18n";
import { relativeTime } from "../lib/relative-time";
import type { Source } from "../lib/sources";
import { useFindForce } from "../lib/chat-find";

import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { noticeAction } from "../lib/engine";
import {
  RESULT_LABELS,
  type Block,
  type Plan,
  type ToolName,
} from "../lib/types";
import { CollapseChevron, StepList } from "./Checklist";
import { Markdown } from "./Markdown";
import { btnGhost, btnOutline } from "./ui";

type Of<K extends Block["kind"]> = Extract<Block, { kind: K }>;

/* ------------------------------------------------------------------ user */

export function UserMessage({ block }: { block: Of<"user"> }) {
  const [open, setOpen] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setOverflow(el.scrollHeight > el.clientHeight + 1);
  }, [block.text, open]);

  return (
    <div className="flex flex-col items-end gap-2">
      {block.attachments.length > 0 && (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-2">
          {block.attachments.map((a) => (
            <span key={a.id} className="flex h-7 items-center gap-1.5 rounded-control border border-outline px-2 text-sm text-ink-2">
              <md-icon aria-hidden="true" className="" >attach_file</md-icon>
              {a.name}
            </span>
          ))}
        </div>
      )}
      <div className="selectable max-w-[80%] rounded-sheet bg-bubble px-3 py-2">
        <p ref={ref} className={`m-0 whitespace-pre-wrap text-content text-ink ${open ? "" : "line-clamp-12"}`}>
          {block.text}
        </p>
        {(overflow || open) && (
          <Button variant="ghost"
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="material-button"
          >
            {open ? t("Свернуть") : t("Развернуть")}
          </Button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- assistant */

/** `copy` is set only on the last text of a turn (the agent may write several between tool calls): it holds the whole turn. */
export function AssistantText({ block, last, copy, sources }: { block: Of<"text">; last: boolean; copy?: string; sources?: Source[] }) {
  return (
    <div className="group/msg">
      <Markdown text={block.text} streaming={block.streaming} />
      {!block.streaming && copy && sources && sources.length > 0 && <Sources sources={sources} />}
      {!block.streaming && copy && (
        <div className="msg-actions" data-last={last || undefined}>
          <CopyButton text={copy} label={t("Копировать")} variant="action" />
          {block.at ? <MsgTime at={block.at} /> : null}
        </div>
      )}
    </div>
  );
}

/** One shared clock for every time label: a single interval, started with the first label and stopped with the last. */
let clock = 0;
const clockListeners = new Set<() => void>();
let now = 0;
function subscribeClock(l: () => void) {
  clockListeners.add(l);
  if (!clock) clock = window.setInterval(() => { now = Date.now(); clockListeners.forEach((x) => x()); }, 30_000);
  return () => {
    clockListeners.delete(l);
    if (!clockListeners.size) { window.clearInterval(clock); clock = 0; }
  };
}
const clockNow = () => now;

/** «только что» -> «1 мин» -> «3 ч»: the label refreshes while the lesson stays open. */
function MsgTime({ at }: { at: number }) {
  useLanguage();
  useSyncExternalStore(subscribeClock, clockNow);
  return <time className="msg-time" dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString(locale())}>{relativeTime(at)}</time>;
}

/** Links the tools returned for this answer, folded under it. */
function Sources({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="msg-sources">
      <button type="button" className="msg-sources-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        <span>{t("Найденные источники")}</span><span className="msg-sources-count">{sources.length}</span>
        <CaretRight aria-hidden="true" className="msg-sources-chev" />
      </button>
      <div id={id}>
        <Disclosure open={open}>
          <ol className="msg-sources-list">
            {sources.map((s, i) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noopener noreferrer"><span className="msg-sources-n">{i + 1}</span><span className="msg-sources-title">{s.title}</span></a>
              </li>
            ))}
          </ol>
        </Disclosure>
      </div>
    </div>
  );
}

/* ------------------------------------------------- reasoning and tool lines
   Cursor style: one muted text line per action, no icon, no card. «Verb subject · result».
   While it runs the text shimmers; the chevron shows on hover; details open as a quiet block. */

type RowTone = "default" | "run" | "fail" | "ask";

function Line({
  verb,
  subject,
  result,
  tone = "default",
  open: openProp,
  onToggle,
  reveal,
  icon,
  children,
}: {
  icon?: string;
  verb: ReactNode;
  subject?: ReactNode;
  result?: ReactNode;
  tone?: RowTone;
  open?: boolean;
  onToggle?: () => void;
  /** the find bar matches text inside this row: show it even though it is folded */
  reveal?: boolean;
  children?: ReactNode;
}) {
  const [own, setOwn] = useState(tone === "fail");
  const can = !!children;
  const open = (openProp ?? own) || (!!reveal && can);
  return (
    <div className="rise">
      <button
        type="button"
        className="trace"
        data-tone={tone}
        disabled={!can}
        aria-expanded={can ? open : undefined}
        onClick={() => (onToggle ? onToggle() : setOwn((v) => !v))}
      >
        {icon && <md-icon aria-hidden="true" className="trace-icon">{icon}</md-icon>}
        <span className={`trace-verb ${tone === "run" ? "shimmer-text" : ""}`}>{verb}</span>
        {subject && <span className="trace-subject">{subject}</span>}
        {result && <span className="trace-result">{result}</span>}
        {can && <CaretRight aria-hidden="true" className="trace-chev" />}
      </button>
      {can && <Disclosure open={open}>{children}</Disclosure>}
    </div>
  );
}

const VERBS: Record<ToolName, { ing: string; done: string; fail: string }> = {
  read: { ing: "Читает", done: "Прочитал", fail: "Не удалось прочитать" },
  bash: { ing: "Выполняет", done: "Выполнил", fail: "Не удалось выполнить" },
  web_search: { ing: "Ищет в сети", done: "Нашёл", fail: "Не удалось найти" },
  web_read: { ing: "Открывает", done: "Открыл", fail: "Не удалось открыть" },
  researcher: { ing: "Запущен исследователь", done: "Исследователь", fail: "Исследователь не справился" },
  skill: { ing: "Загружает навык", done: "Загрузил навык", fail: "Не удалось загрузить навык" },
};

/** What a running tool is called while it runs («Читает»). */
export const runningVerb = (tool: ToolName) => VERBS[tool].ing;

const quoted = (b: Of<"action">) => ((b.tool === "web_search" || b.tool === "researcher") && b.detail ? `«${b.detail}»` : b.detail);
const RESEARCHER_ICON = "travel_explore";
/** the newest progress line the researcher reported («Ищу: …», «Открываю: …») */
const lastLine = (output?: string) => (output ?? "").split("\n").map((l) => l.trim()).filter(Boolean).pop();
const secs = (ms: number) => (ms < 100 ? undefined : t("{0} с", [(ms / 1000).toFixed(1)]));

/** Reasoning opens while it streams and folds away when it is complete; the learner's own toggle wins. */
export function ReasoningRow({ block }: { block: Of<"reasoning"> }) {
  const [chosen, setChosen] = useState<boolean | undefined>(undefined);
  const open = chosen ?? block.streaming;
  const body = useRef<HTMLDivElement>(null);
  const reveal = useFindForce(block.text);

  // the newest words stay in view while the box is open and growing
  useLayoutEffect(() => {
    const el = body.current;
    if (el && block.streaming) el.scrollTop = el.scrollHeight;
  }, [block.text, block.streaming]);

  return (
    <Line
      verb={block.streaming ? t("Рассуждает…") : t("Рассуждал")}
      result={block.streaming || block.seconds < 1 ? undefined : t("{0} с", [block.seconds])}
      tone={block.streaming ? "run" : "default"}
      open={open}
      onToggle={() => setChosen(!open)}
      reveal={reveal}
    >
      {block.text && (
        <div ref={body} className="trace-body is-prose selectable">
          {block.text.trim().split(/\n{2,}/).map((p, i) => (
            <p key={i}>{p.trim()}</p>
          ))}
        </div>
      )}
    </Line>
  );
}

function ActionDetails({ block }: { block: Of<"action"> }) {
  const failed = block.state === "error";
  return (
    <div className="trace-body selectable">
      {block.tool === "bash" ? (
        <div className="whitespace-pre-wrap break-all">
          <span className="select-none">$ </span>
          <span className="text-ink">{block.detail}</span>
        </div>
      ) : (
        <div className="break-all">{block.detail ?? block.tool}</div>
      )}
      {block.output && <div className={`mt-1 whitespace-pre-wrap break-words ${failed ? "text-warn-ui" : ""}`}>{t(block.output)}</div>}
    </div>
  );
}

export function ActionRow({ block }: { block: Of<"action"> }) {
  const v = VERBS[block.tool];
  const reveal = useFindForce(block.detail, block.output);
  const interrupted = block.state === "error" && block.output === "Прервано";
  const icon = block.tool === "researcher" ? RESEARCHER_ICON : undefined;
  if (block.state === "running") {
    const step = block.tool === "researcher" ? lastLine(block.output) : undefined;
    return (
      <>
        <Line tone="run" icon={icon} verb={t(v.ing)} subject={quoted(block)} />
        {step && <div className="trace-progress" role="status">{step}</div>}
      </>
    );
  }
  if (block.state === "done") {
    const result = [block.result ? t(block.result) : undefined, secs(block.ms)].filter(Boolean).join(" · ");
    return (
      <Line icon={icon} verb={t(v.done)} subject={quoted(block)} result={result ? `· ${result}` : undefined} reveal={reveal}>
        <ActionDetails block={block} />
      </Line>
    );
  }
  if (interrupted) return <Line verb={t("Прервано")} subject={quoted(block)} />;
  return (
    <Line tone="fail" icon={icon} verb={t(v.fail)} subject={quoted(block)} result={secs(block.ms) && `· ${secs(block.ms)}`} reveal={reveal}>
      <ActionDetails block={block} />
    </Line>
  );
}

/* ------------------------------------------------------------------ plan */

/** The plan as a checklist on a white block: the single exception to «no cards in the feed».
 *  Each block is a snapshot: when steps get finished the plan is drawn again below with them ticked. */
export function PlanBlock({ block }: { block: Of<"plan"> }) {
  const [open, setOpen] = useState(true);
  const plan: Plan = { goal: block.goal, steps: block.steps, current: block.current ?? 0 };
  return (
    <section aria-label={t("План занятия")} className="rise rounded-sheet border border-outline bg-plan px-3 pb-2 pt-1">
      <button data-material-disclosure
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="-mx-2 flex h-7 w-[calc(100%+16px)] cursor-default items-center gap-2 rounded-control border-0 bg-transparent px-2 text-left text-sm font-medium text-ink-2 transition-colors duration-100 hover:bg-ink/5"
      ><md-ripple /><md-focus-ring />
        <md-icon aria-hidden="true" className="" >checklist</md-icon>
        <span>{t("План")}</span>
        <span className="ml-auto font-normal tabular-nums text-ink-3">
          {plan.current} {t("из")} {plan.steps.length}
        </span>
        <CollapseChevron open={open} />
      </button>
      {open && (
        <>
          <p className="m-0 mb-1.5 text-sm text-ink-3">{plan.goal}</p>
          <StepList plan={plan} />
        </>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- object */

/** A result in the feed: expands in place when its text is known, otherwise it is a plain line (no dead button). */
export function ObjectRef({ block, object }: { block: Of<"object">; object?: { markdown: string } }) {
  const [open, setOpen] = useState(false);
  const label = t(RESULT_LABELS[block.objectKind]).toLowerCase();
  if (!object?.markdown) {
    return (
      <div className="rise flex h-10 w-full items-center gap-2 rounded-sheet border border-solid border-outline px-3 text-base text-ink">
        <md-icon aria-hidden className="shrink-0 text-ink-2" >description</md-icon>
        <span className="min-w-0 truncate font-medium">{block.title}</span>
        <span className="shrink-0 text-sm text-ink-3">{label}</span>
      </div>
    );
  }
  return (
    <div className="rise rounded-sheet border border-solid border-outline">
      <button data-material-disclosure
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 w-full cursor-default items-center gap-2 rounded-sheet border-0 bg-transparent px-3 text-left text-base text-ink transition-colors duration-100 hover:bg-ink/5"
      ><md-ripple /><md-focus-ring />
        <md-icon aria-hidden className="shrink-0 text-ink-2" >description</md-icon>
        <span className="min-w-0 truncate font-medium">{block.title}</span>
        <span className="shrink-0 text-sm text-ink-3">{label}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 font-medium">
          {open ? t("Свернуть") : t("Показать")}
          <CaretRight aria-hidden="true" className={`size-3.5 transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
        </span>
      </button>
      {open && <div className="border-0 border-t border-solid border-outline px-3 py-3"><Markdown text={object.markdown} /></div>}
    </div>
  );
}

/* ---------------------------------------------------------------- notice */

/** Cause → what was saved → actions, on the spot. Amber for what can be fixed, red only for what cannot. */
const NOTICE_EDGE = { info: "border-rule-2", warn: "border-warn-ui", error: "border-danger-ui" } as const;

export function NoticeCard({ sessionId, block, onChooseModel }: { sessionId: string; block: Of<"notice">; onChooseModel: () => void }) {
  return (
    <div role={block.severity === "info" ? "status" : "alert"} className={`rise border-0 border-l-2 border-solid py-1 pl-3.5 ${NOTICE_EDGE[block.severity]}`}>
      <h4 className="m-0 text-base font-medium text-ink">{t(block.title)}</h4>
      {block.detail && <p className="selectable m-0 mt-0.5 text-base text-ink-2">{t(block.detail)}</p>}
      {block.saved && <p className="m-0 mt-0.5 text-base text-ink-3">{t(block.saved)}</p>}
      {block.actions.length > 0 && (
        <div className="-ml-2.5 mt-2.5 flex flex-wrap gap-1">
          {block.actions.map((a, i) => (
            <Button variant="secondary" key={a.id} type="button" className={i === 0 ? `${btnOutline} ml-2.5` : btnGhost} onClick={() => {
              if (a.id === "choose_model") onChooseModel();
              else void noticeAction(sessionId, block.id, a.id);
            }}>
              {t(a.label)}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
