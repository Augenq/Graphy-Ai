import { Button } from "./ui/index";
import { useState } from "react";
import { t } from "../lib/i18n";
import { describe } from "../lib/api";
import { Modal } from "./Modal";

interface Props {
  title: string;
  text: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

/** Deleting is permanent, so it always asks first; a refusal from the backend (a running lesson) stays on screen. */
export function DeleteDialog({ title, text, onConfirm, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async () => {
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(describe(e));
      setBusy(false);
    }
  };
  return <Modal label={title} onClose={onClose}>
    <div className="p-5">
      <h2 className="md-typescale-headline-small m-0">{title}</h2>
      <p className="md-typescale-body-medium mt-3 text-ink-2">{text}</p>
      {error && <p role="alert" className="md-typescale-body-medium m-0 mt-3 text-danger-ui">{error}</p>}
      <div className="mt-6 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>{t("Отмена")}</Button>
        <Button variant="primary" disabled={busy} onClick={() => void run()}>{t("Удалить")}</Button>
      </div>
    </div>
  </Modal>;
}
