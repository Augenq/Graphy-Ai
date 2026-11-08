import { prefersReducedMotion } from "../lib/motion-pref";
import { ArrowDown } from "@phosphor-icons/react";
import { t } from "../lib/i18n";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getState, saveScroll } from "../lib/store";
import { isBusy, type Block, type Session } from "../lib/types";
import {
  ActionRow as ActionRowRaw,
  AssistantText as AssistantTextRaw,
  NoticeCard as NoticeCardRaw,
  ObjectRef as ObjectRefRaw,
  PlanBlock as PlanBlockRaw,
  ReasoningRow as ReasoningRowRaw,
  UserMessage as UserMessageRaw,
} from "./Blocks";
import { ChatFind } from "./ChatFind";
import { ToolGroup as ToolGroupRaw } from "./ToolGroup";
import { QuestionForm as QuestionFormRaw } from "./QuestionForm";
import { RunNotice } from "./RunNotice";
import { WidgetBlock as WidgetBlockRaw } from "./Widget";
import { FileCard as FileCardRaw } from "./PresentedFile";
import { useOpenFile } from "../lib/presented";
import { sourcesOf, type Source } from "../lib/sources";
import { silentActivity } from "../lib/activity";

// Rows only re-render when their own block changes: a streaming flush replaces one block and leaves the others alone.
const UserMessage = memo(UserMessageRaw);
/** the sources array is rebuilt on every pass: compare its links, not its identity */
const AssistantText = memo(AssistantTextRaw, (a, b) => a.block === b.block && a.last === b.last && a.copy === b.copy
  && (a.sources === b.sources || (!!a.sources && !!b.sources && a.sources.length === b.sources.length && a.sources.every((x, i) => x.url === b.sources![i]!.url && x.title === b.sources![i]!.title))));
const ReasoningRow = memo(ReasoningRowRaw);
const ActionRow = memo(ActionRowRaw);
const PlanBlock = memo(PlanBlockRaw);
const ObjectRef = memo(ObjectRefRaw);
const NoticeCard = memo(NoticeCardRaw);
const QuestionForm = memo(QuestionFormRaw);
const WidgetBlock = memo(WidgetBlockRaw);
const FileCard = memo(FileCardRaw);
/** toItems builds a new array of the same blocks on every pass: compare the blocks, not the array */
const ToolGroup = memo(ToolGroupRaw, (a, b) => a.blocks.length === b.blocks.length && a.blocks.every((x, i) => x === b.blocks[i]));

type Action = Extract<Block, { kind: "action" }>;
type Item = { key: string; kind: "group"; blocks: Action[] } | { key: string; kind: "block"; block: Block };

/** Consecutive tool calls fold into one group line; everything else renders as itself. */
function toItems(blocks: Block[]): Item[] {
  const out: Item[] = [];
  // Block ids are wire ids (REST paths, patches) and a provider may reuse one: only the React/DOM key is made unique.
  const seen = new Set<string>();
  const keyOf = (id: string) => { let k = id; for (let n = 2; seen.has(k); n++) k = `${id}~${n}`; seen.add(k); return k; };
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (b.kind === "action" && prev && prev.kind === "block" && prev.block.kind === "action") {
      out[out.length - 1] = { key: prev.key, kind: "group", blocks: [prev.block, b] };
    } else if (b.kind === "action" && prev && prev.kind === "group") {
      prev.blocks.push(b);
    } else out.push({ key: keyOf(b.id), kind: "block", block: b });
  }
  return out;
}

const META = new Set(["reasoning", "action", "group"]);
const kindOf = (i: Item) => (i.kind === "group" ? "group" : i.block.kind);

/** Rhythm (4px grid): 24 between turns, 16 between blocks (12 between an answer and its step rows), 2 inside a run of step rows. */
function gap(prev: Item | undefined, cur: Item) {
  if (!prev) return "";
  if (kindOf(cur) === "user") return "mt-6";
  if (META.has(kindOf(prev)) && META.has(kindOf(cur))) return "mt-0.5";
  if (kindOf(prev) === "text" && META.has(kindOf(cur)) || META.has(kindOf(prev)) && kindOf(cur) === "text") return "mt-3";
  return "mt-4";
}

interface Props {
  session: Session;
  onChooseModel: () => void;
}

/** The transcript: sticks to the bottom while output arrives, remembers its position per lesson. */
export function Thread({ session, onChooseModel }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const id = session.id;
  const openFile = useOpenFile(id);

  const toBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto" });
  }, []);

  // Following a growing answer: catch up over 7 frames (about 100ms) instead of jumping.
  // MEASURED in Cursor: the per-frame steps 1,2,7,4,1,2,1 px (18 px total), here as weights of the gap.
  // TUNED, NOT MEASURED: scaling the weights to the actual gap, the 240px cutoff for an instant jump, re-planning when the gap is left.
  const ramp = useRef(0);
  const rampAt = useRef(-1); // scrollTop the ramp itself set last: scroll events at that position are not the learner's
  const stopRamp = useCallback(() => {
    cancelAnimationFrame(ramp.current);
    ramp.current = 0;
  }, []);
  const follow = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const gap = () => el.scrollHeight - el.clientHeight - el.scrollTop;
    if (prefersReducedMotion() || gap() > 240) {
      stopRamp();
      toBottom();
      return;
    }
    if (ramp.current) return; // already catching up; the next plan reads the new height
    const WEIGHTS = [1, 2, 7, 4, 1, 2, 1].map((n) => n / 18);
    rampAt.current = el.scrollTop;
    let frame = 0;
    let total = gap();
    const step = () => {
      ramp.current = 0;
      // the learner scrolled by hand since the last frame: do not fight it
      if (!stick.current || Math.abs(el.scrollTop - rampAt.current) > 1.5) return;
      if (frame >= WEIGHTS.length) {
        frame = 0;
        total = gap();
      }
      const left = gap();
      if (left <= 0.5) return;
      el.scrollTop += Math.max(1, Math.min(left, Math.round(total * WEIGHTS[frame])));
      frame++;
      rampAt.current = el.scrollTop;
      ramp.current = requestAnimationFrame(step);
    };
    ramp.current = requestAnimationFrame(step);
  }, [toBottom, stopRamp]);

  // opening a lesson restores where the learner was (bottom if there is no saved position)
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const saved = getState().scroll[id];
    const waiting = getState().sessions[id]?.blocks.find((b) => b.kind === "question" && b.state === "open");
    if (saved !== undefined) el.scrollTop = saved;
    else if (waiting) {
      // a test is waiting: show it from its first line, not from its footer
      const target = document.getElementById(`blk-${waiting.id}`);
      if (target) el.scrollTop = Math.max(0, target.offsetTop - 16);
    } else toBottom();
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = near;
    setAway(!stick.current);
  }, [id, toBottom]);

  // any growth (stream, form step, expanded row) keeps the bottom in view when the learner is there
  useEffect(() => {
    const c = content.current;
    if (!c) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) follow();
    });
    ro.observe(c);
    return () => {
      ro.disconnect();
      stopRamp();
    };
  }, [follow, stopRamp]);

  const raf = useRef(0);
  const jumping = useRef(false);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    // the smooth scroll of the jump button passes through positions that are not near yet: keep following
    if (jumping.current && !near) return;
    if (ramp.current && Math.abs(el.scrollTop - rampAt.current) <= 1.5) return;
    jumping.current = false;
    stick.current = near;
    setAway(!near);
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => saveScroll(id, el.scrollTop));
  };

  // sending a message always returns to the newest output
  const lastUser = [...session.blocks].reverse().find((b) => b.kind === "user")?.id;
  useEffect(() => {
    if (lastUser && session.blocks[session.blocks.length - 1]?.kind === "user") {
      stick.current = true;
      toBottom(true);
    }
  }, [lastUser, toBottom]);

  const lastText = [...session.blocks].reverse().find((b) => b.kind === "text")?.id;
  const items = useMemo(() => toItems(session.blocks), [session.blocks]);
  const silent = silentActivity(session);
  // one copy button per answer: under its last text, copying every text of the turn (from one user message to the next)
  const turnCopy = useMemo(() => {
    const out = new Map<string, { copy: string; sources: Source[] }>();
    let texts: Extract<Block, { kind: "text" }>[] = [];
    let tools: Extract<Block, { kind: "action" }>[] = [];
    const close = () => {
      const end = texts[texts.length - 1];
      const joined = texts.map((b) => b.text).filter(Boolean).join("\n\n");
      if (end && joined && !texts.some((b) => b.streaming)) out.set(end.id, { copy: joined, sources: sourcesOf(tools) });
      texts = [];
      tools = [];
    };
    for (const b of session.blocks) {
      if (b.kind === "user") close();
      else if (b.kind === "text") texts.push(b);
      else if (b.kind === "action") tools.push(b);
    }
    close();
    return out;
  }, [session.blocks]);

  // What is already in a lesson when it opens appears at once; only what arrives afterwards animates.
  const opened = useRef<{ key: string; keys: Set<string> }>({ key: "", keys: new Set() });
  const openKey = `${id}:${session.loaded}`;
  if (opened.current.key !== openKey) opened.current = { key: openKey, keys: new Set(items.map((i) => i.key)) };

  return (
    <div className="thread-region relative min-h-0 flex-1">
      <ChatFind scroller={scroller} content={content} lessonId={id} />
      <div
        ref={scroller}
        onScroll={onScroll}
        onWheel={(e) => { jumping.current = false; if (e.deltaY < 0) stopRamp(); }}
        onTouchMove={() => { jumping.current = false; stopRamp(); }}
        onPointerDown={stopRamp}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-busy={isBusy(session.agent)}
        aria-label={t("Ход занятия")}
        tabIndex={-1}
        className="scroll-y thread-fade h-full outline-none"
      >
        <div ref={content} className="mx-auto flex min-h-full w-[min(var(--col-max),100%)] flex-col px-6 pb-14 pt-6 max-[1373.75px]:px-4">
          {items.map((it, i) => (
              <div key={it.key} id={`blk-${it.key}`} data-instant={opened.current.keys.has(it.key) ? "" : undefined} className={gap(items[i - 1], it)}>
                {it.kind === "group" ? (
                  <ToolGroup blocks={it.blocks} />
                ) : (
                  <>
                    {it.block.kind === "user" && <UserMessage block={it.block} />}
                    {it.block.kind === "text" && <AssistantText block={it.block} last={it.block.id === lastText} copy={turnCopy.get(it.block.id)?.copy} sources={turnCopy.get(it.block.id)?.sources} />}
                    {it.block.kind === "reasoning" && <ReasoningRow block={it.block} />}
                    {it.block.kind === "action" && <ActionRow block={it.block} />}
                    {it.block.kind === "widget" && <WidgetBlock sessionId={id} block={it.block} />}
                    {it.block.kind === "file" && <FileCard sessionId={id} file={it.block.file} active={openFile?.id === it.block.id} />}
                    {it.block.kind === "plan" && <PlanBlock block={it.block} />}
                    {it.block.kind === "object" && <ObjectRef block={it.block} object={session.objects.find((o) => o.id === (it.block as { objectId: string }).objectId)} />}
                    {it.block.kind === "question" && <QuestionForm sessionId={id} block={it.block} />}
                    {it.block.kind === "notice" && <NoticeCard sessionId={id} block={it.block} onChooseModel={onChooseModel} />}
                  </>
                )}
              </div>
            ))}
          {silent && <div className={gap(items[items.length - 1], { key: "live", kind: "group", blocks: [] })}><div className="trace live-row" aria-hidden="true"><span className="trace-verb shimmer-text">{t(silent.label)}</span></div></div>}
        </div>
      </div>
      <RunNotice sessionId={id} />
      <button
        type="button"
        aria-label={t("К новому")}
        aria-hidden={!away}
        tabIndex={away ? 0 : -1}
        onClick={() => {
          stick.current = true;
          jumping.current = true;
          toBottom(true);
        }}
        className={`jump-to-latest${away ? " is-away" : ""}`}
      >
        <ArrowDown aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}
