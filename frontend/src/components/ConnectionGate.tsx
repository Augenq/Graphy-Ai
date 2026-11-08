import { useEffect, useState } from "react";
import { Button } from "./ui/index";
import { AgentLoader } from "./AgentLoader";
import { t } from "../lib/i18n";
import { retryBackend, useBackend } from "../lib/backend";
import { useRemote } from "../lib/remote";

/** Shown until the agent answers: starting, failed to start, or not configured (plain browser). */
export function ConnectionGate({ fadeOut = false }: { fadeOut?: boolean }) {
  const backend = useBackend();
  const loaded = useRemote((r) => r.loaded);
  const [phase, setPhase] = useState(0);
  const waiting = backend.state === "connecting" || (backend.state === "ready" && !loaded);
  const failed = backend.state === "error" || backend.state === "missing";

  useEffect(() => {
    if (!waiting) return;
    setPhase(0);
    const timers = [1500, 4500, 9000].map((ms, i) => setTimeout(() => setPhase(i + 1), ms));
    return () => timers.forEach(clearTimeout);
  }, [waiting, backend.state, loaded]);

  const lines = [
    backend.message ? t(backend.message) : t("Запускаю агента…"),
    t("Собираю знания и инструменты…"),
    t("Готовлю рабочее пространство…"),
    t("Почти готово…"),
  ];

  return (
    <div className={`graphy-workspace relative flex h-full w-full items-center justify-center overflow-hidden bg-paper font-sans text-ink${fadeOut ? " agent-gate-out" : ""}`}>
      <div className="agent-gate" role="status" aria-live="polite" aria-busy={waiting && !fadeOut}>
        <AgentLoader size={168} />
        <span className="graphy-wordmark agent-gate-brand">Graphy</span>
        {waiting && !fadeOut && (
          <p className="agent-gate-status" key={phase}>{lines[Math.min(phase, lines.length - 1)]}</p>
        )}
        {failed && !fadeOut && (
          <div className="agent-gate-fail">
            <h1 className="agent-gate-title">{t("Агент не запущен")}</h1>
            <p className="selectable agent-gate-detail">{backend.message ? t(backend.message) : ""}</p>
            <Button variant="primary" type="button" onClick={retryBackend}>
              {t("Повторить")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** A thin notice at the top while the event stream is down and being re-established. */
export function OfflineBanner() {
  const online = useRemote((r) => r.online);
  if (online) return null;
  return (
    <div role="status" className="absolute inset-x-0 top-0 z-50 flex h-7 items-center justify-center gap-2 bg-warn-ui text-sm text-paper">
      <md-icon aria-hidden="true">sync_problem</md-icon>
      {t("Связь с агентом потеряна · переподключение…")}
    </div>
  );
}
