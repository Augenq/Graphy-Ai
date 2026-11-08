import { Button, Field } from "./ui/index";
import { useEffect, useRef, useState } from "react";
import { isImeKey } from "../lib/ime";
import { t } from "../lib/i18n";
import { describe } from "../lib/api";
import { Modal } from "./Modal";

interface Props {
  title: string;
  label: string;
  initial: string;
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}

/** A single name field; a refusal from the backend stays on screen under it. */
export function RenameDialog({ title, label, initial, onSave, onClose }: Props) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const value = name.replace(/\s+/g, " ").trim();
  const can = !!value && value !== initial.trim() && !busy;
  useEffect(() => {
    const timer = setTimeout(() => { field.current?.focus(); field.current?.select(); }, 220);
    return () => clearTimeout(timer);
  }, []);
  const run = async () => {
    if (!can) return;
    setBusy(true);
    setError("");
    try {
      await onSave(value);
      onClose();
    } catch (e) {
      setError(describe(e));
      setBusy(false);
    }
  };
  return <Modal label={title} onClose={onClose}>
    <div className="p-5">
      <h2 className="md-typescale-headline-small m-0">{title}</h2>
      <Field ref={field} label={label} value={name} maxLength={200} className="mt-4 w-full"
        onInput={e => setName(e.currentTarget.value)}
        onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter" && !isImeKey(e)) { e.preventDefault(); void run(); } }} />
      {error && <p role="alert" className="md-typescale-body-medium m-0 mt-3 text-danger-ui">{error}</p>}
      <div className="mt-6 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>{t("Отмена")}</Button>
        <Button variant="primary" disabled={!can} onClick={() => void run()}>{t("Сохранить")}</Button>
      </div>
    </div>
  </Modal>;
}
