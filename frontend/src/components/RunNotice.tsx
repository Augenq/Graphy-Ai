import { stop } from "../lib/engine";
import { t } from "../lib/i18n";
import { setStalled, useStalled, waitMore } from "../lib/run-errors";
import { useState } from "react";
import { Button } from "./ui/index";
import { StatusBadge } from "@maxhub/max-ui";

/** «Агент завис»: nothing has come from the model (or a tool) for a while. The learner stops or waits. */
export function RunNotice({ sessionId }: { sessionId: string }) {
  const stalled = useStalled(sessionId);
  const [error, setError] = useState<string | null>(null);
  if (!stalled) return null;
  const what = stalled.phase === "tool" ? "Инструмент долго не отвечает" : "Модель долго не отвечает";
  return (
    <div className="run-notice" role="alert" data-run-notice>
      <div className="run-notice-text">
        <strong className="run-notice-title"><StatusBadge status="warning" text={t(what)} /></strong>
        <span>{t("Уже {0} с без ответа. Подождать ещё или остановить?", [stalled.seconds])}</span>
        {error && <span className="run-notice-error">{error}</span>}
      </div>
      <div className="run-notice-actions">
        <Button variant="secondary" data-run-stop onClick={() => { setStalled(sessionId, null); stop(sessionId); }}>{t("Остановить")}</Button>
        <Button variant="primary" data-run-wait autoFocus onClick={() => void waitMore(sessionId).then(setError)}>{t("Подождать")}</Button>
      </div>
    </div>
  );
}
