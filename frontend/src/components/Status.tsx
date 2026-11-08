import { Constellation } from "./Constellation";
import { t } from "../lib/i18n";
import { useEffect, useState } from "react";
import { isBusy, type Session } from "../lib/types";

function useElapsed(since: number, active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since, active]);
  return Math.max(0, Math.round((now - since) / 1000));
}

type Tone = "run" | "wait" | "calm" | "error";

const TONE: Record<Tone, string> = {
  run: "text-ink-2",
  wait: "text-warn-ui",
  calm: "text-ink-3",
  error: "text-danger-ui",
};

/**
 * The one status line above the composer. No dots: the state is the wording.
 * Material progress accompanies work. The line is always rendered, so the composer never jumps.
 */
export function AgentStatus({ session }: { session: Session }) {
  const { kind, label, since } = session.agent;
  const busy = isBusy(session.agent);
  const secs = useElapsed(since, busy);

  let text = "";
  let tone: Tone = "calm";
  let hint = "";
  if (busy) {
    text = t(label || "Работает");
    tone = "run";
    hint = t("Esc — остановить");
  } else if (kind === "waiting") {
    tone = "wait";
    text = t("Ждёт ваших ответов в тесте");
    hint = t("Esc — свернуть тест");
  } else if (kind === "stopped") text = t("Остановлено · ответ сохранён до этого места");
  else if (kind === "error") {
    tone = "error";
    text = t("{0} · занятие сохранено", [t(label || "Ошибка")]);
  }

  return (
    <div role="status" aria-live="polite" className="agent-status flex min-w-0 items-center gap-2 text-sm">
      {text && (
        <>
          {busy && <span className="agent-status-indicator shrink-0"><Constellation /></span>}
          <span className={`min-w-0 truncate ${TONE[tone]}`}>{text}</span>
          {busy && <span className="tabular-nums shrink-0 text-ink-3">· {secs} {t("с")}</span>}
          {hint && kind !== "waiting" && <span className="ml-auto shrink-0 text-xs text-ink-3">{hint}</span>}
        </>
      )}
    </div>
  );
}

