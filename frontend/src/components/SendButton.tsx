import { IconButton } from "./ui/index";
import { t } from "../lib/i18n";

/**
 * The two actions at the end of the input's toolbar. Voice is a quiet grey icon without a fill;
 * send is a ring with a dark arrow while there is nothing to send and fills (smoothly) once there is.
 */
export function SendButton({ canSend, onSend, listening, supported, onDictate, queued = false, transcribing = false }: {
  transcribing?: boolean;
  canSend: boolean;
  onSend: () => void;
  listening: boolean;
  supported: boolean;
  onDictate: () => void;
  /** a message sent now waits for the agent to finish */
  queued?: boolean;
}) {
  const voice = transcribing ? t("Распознаю речь…") : listening ? t("Остановить запись") : supported ? t("Голосовой ввод") : t("Голосовой ввод здесь недоступен");
  const send = queued ? t("Поставить в очередь") : t("Отправить");
  return <>
    <IconButton variant="ghost" type="button" className="voice-button" aria-label={voice} title={voice} aria-pressed={listening} disabled={(!supported && !listening) || transcribing}
      data-listening={listening ? "" : undefined} onClick={onDictate}>
      <md-icon aria-hidden="true">{transcribing ? "hourglass_top" : listening ? "stop" : "mic"}</md-icon>
    </IconButton>
    <IconButton variant="primary" type="button" className="send-button" aria-label={send} title={send} disabled={!canSend}
      data-ready={canSend ? "" : undefined} onClick={onSend}>
      <md-icon aria-hidden="true">arrow_upward</md-icon>
    </IconButton>
  </>;
}
