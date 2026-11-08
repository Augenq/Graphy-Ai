import { useRef, type KeyboardEvent } from "react";
import { t, plural } from "../lib/i18n";
import { queueLocked, queueOperation, type QueueOp } from "../lib/queue";
import type { Session } from "../lib/types";
import { Counter } from "@maxhub/max-ui";
import { Button, IconButton } from "./ui/index";
import { restoreQueue } from "../lib/engine";

/** Messages waiting for the agent, listed inside the composer above the text field. */
export function MessageQueue({ session }: { session: Session }) {
  const list = useRef<HTMLOListElement>(null);
  const queue = session.queue;
  if (!queue.length) return null;
  const id = session.id;
  const locked = queueLocked(id, queue);
  const after = queue.filter((m) => m.followup).length;
  const now = queue.length - after;

  const run = (op: QueueOp, focusRow?: number) => {
    void queueOperation(id, op).then(() => {
      if (focusRow !== undefined) requestAnimationFrame(() => list.current?.querySelectorAll<HTMLElement>("[data-queue-row]")[focusRow]?.focus());
    });
  };
  const onKey = (e: KeyboardEvent<HTMLElement>, i: number) => {
    if (e.target !== e.currentTarget) return;
    if (!locked && e.altKey && e.key === "ArrowUp") return e.preventDefault(), run({ kind: "move", index: i, by: -1 }, Math.max(0, i - 1));
    if (!locked && e.altKey && e.key === "ArrowDown") return e.preventDefault(), run({ kind: "move", index: i, by: 1 }, Math.min(queue.length - 1, i + 1));
    if (!locked && (e.key === "Delete" || e.key === "Backspace")) return e.preventDefault(), run({ kind: "remove", index: i });
    if (e.key === "ArrowDown") return e.preventDefault(), list.current?.querySelectorAll<HTMLElement>("[data-queue-row]")[i + 1]?.focus();
    if (e.key === "ArrowUp") return e.preventDefault(), list.current?.querySelectorAll<HTMLElement>("[data-queue-row]")[i - 1]?.focus();
  };

  return <section className="mq" aria-label={t("Очередь сообщений")} data-message-queue>
    <div className="mq-head" role="status">
      <Counter value={queue.length} variant="mute" rounded aria-hidden="true" className="mq-count" />{" "}
      <span className="mq-title" aria-label={plural(queue.length, "{0} сообщение в очереди", "{0} сообщения в очереди", "{0} сообщений в очереди").replace("{0}", String(queue.length))}>{plural(queue.length, "{0} сообщение в очереди", "{0} сообщения в очереди", "{0} сообщений в очереди").replace("{0}", "").trim()}</span>
      {now > 0 && after > 0 && <span className="mq-split">{t("сразу: {0} · после ответа: {1}", [now, after])}</span>}
      <span className="flex-1" />
      <Button variant="ghost" type="button" onClick={() => void restoreQueue(id)}>{t("Вернуть всё в редактор")}</Button>
    </div>
    {locked && <p className="mq-note">{t("В очереди есть сообщение с вложениями: порядок не меняется, его можно только вернуть в редактор.")}</p>}
    <ol ref={list} className="mq-list">
      {queue.map((m, i) => {
        return <li key={`${i}:${m.text}`} className="mq-row" data-queue-row tabIndex={0} data-followup={m.followup} onKeyDown={(e) => onKey(e, i)}
          aria-label={t("{0} из {1}: {2}", [i + 1, queue.length, m.text.slice(0, 120)])} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Delete">
          <span className="mq-kind">{m.followup ? t("после ответа") : t("сразу")}</span>
          <span className="mq-text" title={m.text}>{m.text}</span>
          <span className="mq-actions">
            {!locked && m.followup && <IconButton variant="ghost" type="button" aria-label={t("Отправить сейчас")} title={t("Отправить сейчас")} onClick={() => run({ kind: "steer", index: i })}><md-icon aria-hidden="true">bolt</md-icon></IconButton>}
            {!locked && <IconButton variant="ghost" type="button" aria-label={t("Править в редакторе")} title={t("Править в редакторе")} onClick={() => run({ kind: "edit", index: i })}><md-icon aria-hidden="true">edit</md-icon></IconButton>}
            {!locked && <>
              <IconButton variant="ghost" type="button" disabled={i === 0} aria-label={t("Выше")} title={t("Выше")} onClick={() => run({ kind: "move", index: i, by: -1 })}><md-icon aria-hidden="true">arrow_upward</md-icon></IconButton>
              <IconButton variant="ghost" type="button" disabled={i === queue.length - 1} aria-label={t("Ниже")} title={t("Ниже")} onClick={() => run({ kind: "move", index: i, by: 1 })}><md-icon aria-hidden="true">arrow_downward</md-icon></IconButton>
            </>}
            {!locked && <IconButton variant="ghost" type="button" aria-label={t("Убрать из очереди")} title={t("Убрать из очереди")} onClick={() => run({ kind: "remove", index: i })}><md-icon aria-hidden="true">close</md-icon></IconButton>}
          </span>
        </li>;
      })}
    </ol>
  </section>;
}
