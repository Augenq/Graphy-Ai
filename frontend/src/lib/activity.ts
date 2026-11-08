import { isBusy, type Session } from "./types";

/**
 * What the agent is doing right now that nothing in the transcript shows yet.
 *
 * The transcript already carries its own live rows: a streaming reasoning block says «Рассуждает…», a running
 * tool row says what it runs, streaming text is the answer itself. Everything else while a turn is open is a
 * silent gap (the model is thinking before its first token, a tool without a row is working, a tool result is
 * being read), and this names it from the runtime state: `session.agent`, which lib/sync.ts derives from events.
 * Returns null when a visible row already covers the moment, or when no turn is open: nothing shimmers then.
 */
export function silentActivity(s: Session): { label: string } | null {
  if (!isBusy(s.agent)) return null;
  for (let i = s.blocks.length - 1; i >= 0; i--) {
    const b = s.blocks[i];
    if (b.kind === "user") break; // the turn starts at the last message of the learner
    if ((b.kind === "text" || b.kind === "reasoning") && b.streaming) return null;
    if (b.kind === "action" && b.state === "running") return null;
  }
  // «writing» without a streaming block is a text that just ended: the agent is deciding what comes next
  const label = s.agent.kind === "writing" ? "" : s.agent.label;
  return { label: label || "Думает" };
}
