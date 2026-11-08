import { CellSimple } from "@maxhub/max-ui";
import { useMemo, useRef, useState } from "react";
import { ATTACH_LIMITS, chipFromFolder, chipFromSketch, fitLimits } from "../lib/attachments";
import { t } from "../lib/i18n";
import { useRemote } from "../lib/remote";
import { getState } from "../lib/store";
import type { Attachment, Session } from "../lib/types";
import { Menu } from "./Menu";
import { Modal } from "./Modal";
import { SketchDialog } from "./SketchDialog";
import { fmtBytes, iconBtn } from "./ui";
import { IconButton } from "./ui/index";

const icon = (name: string) => <md-icon aria-hidden="true">{name}</md-icon>;

/** Files already used in other lessons (the app has no separate material store). */
export function pastMaterials(session: Session): Attachment[] {
  const seen = new Set(session.chips.map((c) => c.path));
  const found: Attachment[] = [];
  for (const other of Object.values(getState().sessions)) {
    if (other.id === session.id) continue;
    for (const b of other.blocks) {
      if (b.kind !== "user") continue;
      for (const a of b.attachments ?? []) {
        if (!a.path || seen.has(a.path)) continue;
        seen.add(a.path);
        found.push({ ...a, id: `m-${found.length}-${a.id}` });
      }
    }
  }
  return found;
}

/** The "+" button: one menu for files, folders, earlier materials and a sketch. */
export function AttachMenu({ session, onFiles, onChips, onNote }: {
  session: Session;
  /** opens the file picker owned by the composer (also Ctrl+U) */
  onFiles: () => void;
  onChips: (chips: Attachment[]) => void;
  onNote: (note: string) => void;
}) {
  const folderInput = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<"sketch" | "materials" | null>(null);
  const model = useRemote((r) => r.models.find((m) => m.id === session.model));
  const vision = model ? model.vision : true;
  const sketchOff = !vision ? t("Модель не принимает изображения") : t("Схема или макет уйдёт как картинка");
  const materials = useMemo(() => (dialog === "materials" ? pastMaterials(session) : []), [dialog, session]);

  const add = (chips: Attachment[]) => {
    const { accepted, notes } = fitLimits(session.chips, chips);
    onNote(notes.join(" · "));
    if (accepted.length) onChips(accepted);
  };

  return <>
    <Menu
      label={t("Добавить")}
      side="top"
      width={340}
      rich
      title={t("До {0} изображений, {1} документов и {2} папок в сообщении", [ATTACH_LIMITS.images, ATTACH_LIMITS.files, ATTACH_LIMITS.folders])}
      items={[
        { id: "file", icon: icon("attach_file"), label: t("Файл или фото…"), hint: "\u200B" + t("Ctrl U · картинки до 5 МБ") },
        { id: "folder", icon: icon("folder_open"), label: t("Папка…"), hint: t("Список файлов, без содержимого") },
        { id: "materials", icon: icon("library_books"), label: t("Материалы из чатов…"), hint: t("Файлы из других ваших чатов") },
        { id: "sketch", icon: icon("draw"), label: t("Набросок…"), hint: sketchOff, disabled: !vision },
      ]}
      onSelect={(k) => {
        if (k === "file") onFiles();
        if (k === "folder") folderInput.current?.click();
        if (k === "materials") setDialog("materials");
        if (k === "sketch") setDialog("sketch");
      }}
      trigger={(p) => (
        <IconButton variant="ghost" type="button" {...p} aria-label={t("Добавить материал (Ctrl+U)")} className={iconBtn} data-attach>
          <md-icon aria-hidden="true">add</md-icon>
        </IconButton>
      )}
    />
    <input ref={folderInput} type="file" hidden multiple {...{ webkitdirectory: "" }} data-folder-input
      onChange={(e) => {
        const files = [...(e.target.files ?? [])];
        e.target.value = "";
        const chip = chipFromFolder(files);
        if (chip) add([chip]);
        else onNote(t("В папке нет файлов для списка."));
      }} />

    {dialog === "sketch" && <SketchDialog onClose={() => setDialog(null)} onDone={(png) => {
      setDialog(null);
      void chipFromSketch(png).then((chip) => (chip ? add([chip]) : onNote(t("Не удалось загрузить вложение. Проверьте соединение и размер файла (до 20 МБ)."))));
    }} />}

    {dialog === "materials" && <Modal label={t("Материалы из чатов")} onClose={() => setDialog(null)} className="materials-dialog">
      <h2 className="m-0 mb-1 text-lg font-medium text-ink">{t("Материалы из чатов")}</h2>
      <p className="m-0 mb-3 text-sm text-ink-3">{t("Файлы, которые вы уже прикладывали в других чатах.")}</p>
      {materials.length === 0 && <p className="text-base text-ink-3" data-materials-empty>{t("Пока нет файлов: прикрепите файл в любом чате, и он появится здесь.")}</p>}
      <ul className="materials-list" role="list">
        {materials.map((m) => <li key={m.id}>
          <CellSimple as="button" height="compact" className="materials-row" before={<md-icon aria-hidden="true">{m.kind === "image" ? "image" : "draft"}</md-icon>}
            title={m.name} subtitle={m.size ? fmtBytes(m.size) : undefined}
            onClick={() => { add([{ ...m, id: `c-${Math.random().toString(36).slice(2, 9)}` }]); setDialog(null); }} />
        </li>)}
      </ul>
    </Modal>}
  </>;
}
