import { useEffect } from "react";
import { t } from "../lib/i18n";
import { notify } from "../lib/toast";
import { describe } from "../lib/api";
import { refreshRole, setTeacherMode, useTeacherMode } from "../lib/teaching-api";
import { Switch } from "./ui-new/Switch";

/** Settings row «Режим преподавателя»: a local switch, not an account. It only reveals the teacher screens. */
export function TeacherModeRow() {
  const on = useTeacherMode();
  useEffect(() => { void refreshRole(); }, []);
  const label = t("Режим преподавателя");
  return <div className="settings-row flex items-center justify-between gap-6 border-b border-rule py-4 last:border-b-0" data-teacher-mode-row>
    <div className="min-w-0">
      <div className="text-base text-ink">{label}</div>
      <div className="mt-0.5 text-sm text-ink-3">{t("Открывает раздел «Классы». Учётных записей нет: это только настройка на этом компьютере.")}</div>
    </div>
    <div className="shrink-0"><Switch label={label} checked={on} onChange={(v) => { void setTeacherMode(v).catch((e) => notify(describe(e), { kind: "error" })); }} /></div>
  </div>;
}
