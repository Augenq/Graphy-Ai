import { t } from "../lib/i18n";

import { type CSSProperties, type ReactNode } from "react";
import { type Plan } from "../lib/types";

type Status = "done" | "cur" | "later";

/** Every item is a square: an empty one with a black outline, and a black one once it is done. The current item has no marker of its own. */
function Tick({ status }: { status: Status }) {
  if (status === "done")
    return (
      <span aria-hidden className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border-[1.5px] border-ink bg-ink text-paper">
        <md-icon aria-hidden="true" style={{ "--md-icon-size": "14px" } as CSSProperties}>check</md-icon>
      </span>
    );
  return <span aria-hidden className="mt-0.5 size-4 shrink-0 rounded-[4px] border-[1.5px] border-ink" />;
}

const STATUS_WORD: Record<Status, string> = { done: "выполнено", cur: "идёт", later: "впереди" };

function Item({ status, child, phase, children, meta }: { status: Status; live?: boolean; child?: boolean; phase?: boolean; children: ReactNode; meta?: ReactNode }) {
  return (
    <li aria-current={status === "cur" ? "step" : undefined} className={`flex min-h-7 items-start gap-2.5 py-1 text-base ${child ? "pl-6" : ""}`}>
      <Tick status={status} />
      <span
        className={`min-w-0 flex-1 ${phase ? "font-medium" : ""} ${
          status === "done" ? "font-medium text-ink-3 line-through decoration-rule-2 decoration-1" : status === "cur" ? "font-medium text-ink" : "text-ink-2"
        }`}
      >
        {children}
        <span className="sr-only"> — {t(STATUS_WORD[status])}</span>
      </span>
      {meta && <span className="shrink-0 pt-0.5 text-xs tabular-nums text-ink-3">{meta}</span>}
    </li>
  );
}

const statusOf = (i: number, cur: number): Status => (i < cur ? "done" : i === cur ? "cur" : "later");

/** Plan steps only (the block in the feed): every step stays visible, finished ones ticked. */
export function StepList({ plan }: { plan: Plan }) {
  return (
    <ul className="m-0 list-none p-0">
      {plan.steps.map((s, i) => (
        <Item key={s} status={statusOf(i, plan.current)}>{s}</Item>
      ))}
    </ul>
  );
}

/** Collapsible header for the feed block: «План · обучение  2 из 5 ⌄». */
export function CollapseChevron({ open }: { open: boolean }) {
  return <md-icon aria-hidden="true" className={`size-4 text-ink-3 transition-transform duration-150 ${open ? "" : "-rotate-90"}`} >expand_more</md-icon>;
}
