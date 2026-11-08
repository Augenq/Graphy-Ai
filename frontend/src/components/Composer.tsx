import { prefersReducedMotion } from "../lib/motion-pref";
import { Button, Chip, ChipSet, IconButton, Textarea } from "./ui/index";
import { notify } from "../lib/toast";
import { isImeKey } from "../lib/ime";
import { t } from "../lib/i18n";
import { ComposerPanel, fitField } from "./ComposerPanel";
import { ModeSwitch } from "./ModeSwitch";
import { setSessionMode } from "../lib/mode-api";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { chipsFromFiles, fitLimits } from "../lib/attachments";
import { useDictation } from "../lib/dictation";
import { send, setLessonModel, stop } from "../lib/engine";
import { getState, patchBlock, patchSession } from "../lib/store";
import { useSettings } from "../lib/settings";
import { hasOpenQuestion, isBusy, type Attachment, type Session } from "../lib/types";
import { AgentStatus } from "./Status";
import { UsageChip } from "./UsageChip";
import { AttachMenu } from "./AttachMenu";
import { MessageQueue } from "./MessageQueue";
import { QualityMenu, DEFAULT_QUALITY, type Quality } from "./QualityMenu";
import { SendButton } from "./SendButton";
import { Tip } from "./Tip";
import { fmtBytes } from "./ui";

const MAX_HEIGHT = 200;

const COMMANDS = [
  { id: "quiz", label: "Квиз", hint: "Открыть квиз по теме", prefix: "Проверь, что я уже знаю: " },
  { id: "hint", label: "Подсказка", hint: "Один шаг, без готового ответа", prefix: "Дай подсказку: " },
  { id: "solve", label: "Полный разбор", hint: "Показать решение целиком", prefix: "Покажи полное решение: " },
];

type Suggest = { kind: "slash"; items: { key: string; label: string; hint: string }[]; query: string };

export function Composer({ session }: { session: Session }) {
  const settings = useSettings();
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuOff, setMenuOff] = useState(false);
  const [drag, setDrag] = useState(false);
  const [command, setCommand] = useState<(typeof COMMANDS)[number] | null>(null);

  const id = session.id;
  const text = session.draft;
  const busy = isBusy(session.agent);
  const locked = hasOpenQuestion(session);
  const canSend = (text.trim().length > 0 || session.chips.length > 0 || !!command) && !locked;

  const setDraft = (draft: string) => patchSession(id, (s) => ({ ...s, draft }));
  const draftRef = useRef(text);
  draftRef.current = text;
  const dictation = useDictation(() => draftRef.current, setDraft);
  useEffect(() => { if (dictation.error) notify(dictation.error, { kind: "warn" }); }, [dictation.error]);
  const addChips = (chips: Attachment[]) => patchSession(id, (s) => ({ ...s, chips: [...s.chips, ...chips] }));
  const removeChip = (cid: string) => patchSession(id, (s) => ({ ...s, chips: s.chips.filter((c) => c.id !== cid) }));

  const resize = () => fitField(area.current, MAX_HEIGHT);
  useEffect(() => {
    resize();
  }, [text, id, locked]);

  // Keep wrapped drafts fitted while the adjacent panel changes the editor width.
  useEffect(() => {
    const field = area.current;
    if (!field) return;
    let previousWidth = -1;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === previousWidth) return;
      previousWidth = entry.contentRect.width;
      resize();
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [id, locked]);

  // a new lesson or a restored draft: put the caret in the field unless a form is waiting
  useEffect(() => {
    // Wait until the native textarea is committed before restoring desktop focus.
    let cancelled = false;
    if (!locked && !matchMedia("(pointer: coarse)").matches) queueMicrotask(() => { if (!cancelled) area.current?.focus(); });
    return () => { cancelled = true; };
  }, [id, locked]);

  const menu: Suggest | null = useMemo(() => {
    if (menuOff || locked) return null;
    const slash = /^\/(\S*)$/.exec(text);
    if (slash) {
      const q = slash[1].toLowerCase();
      const items = COMMANDS.filter((c) => t(c.label).toLowerCase().startsWith(q)).map((c) => ({ key: c.id, label: `/${t(c.label)}`, hint: t(c.hint) }));
      return items.length ? { kind: "slash", items, query: q } : null;
    }
    return null;
  }, [text, menuOff, locked, settings.language]);

  useEffect(() => setMenuIndex(0), [menu?.kind, menu?.query]);
  useEffect(() => setMenuOff(false), [text]);

  const choose = (key: string) => {
    if (!menu) return;
    setCommand(COMMANDS.find((c) => c.id === key) ?? null);
    setDraft("");
    area.current?.focus();
  };

  const submit = (followup = false) => {
    if (!canSend) return;
    const value = command ? `${t(command.prefix)}${text}`.trim() : text;
    setCommand(null);
    void send(id, value, { followup });
    requestAnimationFrame(resize);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeKey(e)) { if (e.key === "Escape") (e.preventDefault(), e.stopPropagation()); return; }
    if (menu) {
      if (e.key === "ArrowDown") return e.preventDefault(), setMenuIndex((i) => (i + 1) % menu.items.length);
      if (e.key === "ArrowUp") return e.preventDefault(), setMenuIndex((i) => (i - 1 + menu.items.length) % menu.items.length);
      if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), choose(menu.items[menuIndex].key);
      if (e.key === "Escape") return e.preventDefault(), setMenuOff(true);
    }
    if (e.key === "Escape" && busy) return e.preventDefault(), stop(id);
    if (e.key === "Backspace" && command && !text) return setCommand(null);
    if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) {
      e.preventDefault();
      submit(e.altKey);
    }
  };

  const pickFiles = async (files: FileList | File[]) => {
    const { chips, missing } = await chipsFromFiles(files);
    const { accepted, notes } = fitLimits(getState().sessions[id]?.chips ?? [], chips);
    const note = [missing ? t("Не удалось загрузить вложение. Проверьте соединение и размер файла (до 20 МБ).") : "", ...notes].filter(Boolean).join(" · ");
    if (note) notify(note, { kind: "warn" });
    if (accepted.length) addChips(accepted);
  };

  // files dragged over the window light up the composer; a drop anywhere in the lesson attaches them
  const dropRef = useRef<(files: FileList) => void>(() => {});
  dropRef.current = (files) => void pickFiles(files);
  useEffect(() => {
    if (locked) return;
    let depth = 0;
    const hasFiles = (e: globalThis.DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    const enter = (e: globalThis.DragEvent) => { if (hasFiles(e)) { depth += 1; setDrag(true); } };
    const over = (e: globalThis.DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const leave = (e: globalThis.DragEvent) => { if (hasFiles(e) && --depth <= 0) { depth = 0; setDrag(false); } };
    const drop = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDrag(false);
      if (e.dataTransfer!.files.length) dropRef.current(e.dataTransfer!.files);
    };
    window.addEventListener("dragenter", enter); window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave); window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragenter", enter); window.removeEventListener("dragover", over); window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop); };
  }, [locked, id]);

  // Ctrl+U attaches a file from anywhere in the lesson
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "u") {
        e.preventDefault();
        fileInput.current?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (locked) return <div className="composer-waiting" data-composer-waiting>
    <AgentStatus session={session} />
    <Button variant="ghost" onClick={() => {
      const block = session.blocks.find(b => b.kind === "question" && (b.state === "open" || b.state === "collapsed"));
      if (!block || block.kind !== "question") return;
      if (block.state === "collapsed") patchBlock(id, block.id, b => b.kind === "question" ? { ...b, state: "open" } : b);
      requestAnimationFrame(() => document.getElementById(`blk-${block.id}`)?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" }));
    }}>{t("К тесту")}</Button>
  </div>;

  const suggestions = menu && (
    <div role="listbox" aria-label={menu.kind === "slash" ? t("Команды") : t("Материалы из чатов")} className="fade-in absolute inset-x-0 bottom-full z-20 mb-2 rounded-sheet border border-outline bg-sheet p-1.5">
      {menu.items.map((it, i) => (
        <div
          key={it.key}
          role="option"
          aria-selected={i === menuIndex}
          onMouseEnter={() => setMenuIndex(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            choose(it.key);
          }}
          className={`flex h-8 cursor-default items-center gap-3 rounded-control px-2.5 text-base ${i === menuIndex ? "bg-wash" : ""}`}
        >
          <span className="font-medium text-ink">{it.label}</span>
          <span className="text-sm text-ink-3">{it.hint}</span>
        </div>
      ))}
    </div>
  );

  return (
    <div className="lesson-composer relative mx-auto w-[min(var(--col-max),100%)] shrink-0 px-5 pb-3 max-[1373.75px]:px-4">
      <ComposerPanel variant="lesson"
        above={<MessageQueue session={session} />}
        surface={{ "data-drop": drag || undefined, className: `group/composer relative ${drag ? "outline outline-2 outline-accent-ui" : ""} ${locked ? "opacity-70" : ""}` }}
        overlay={<>
          {drag && <div className="attach-drop" aria-hidden="true"><md-icon>upload_file</md-icon>{t("Отпустите, чтобы прикрепить")}</div>}
          {suggestions}
        </>}
        chips={(session.chips.length > 0 || command) && <ChipSet aria-label={t("Материалы занятия")} className="mb-3">
          {command && <Chip label={`/${t(command.label)}`} removeLabel={t("Убрать команду {0}", [t(command.label)])} onRemove={() => setCommand(null)} />}
          {session.chips.map(c => <Chip key={c.id} label={`${c.name}${c.size ? ` · ${fmtBytes(c.size)}` : ""}`} removeLabel={t("Убрать вложение {0}", [c.name])} onRemove={() => removeChip(c.id)}>
            <md-icon slot="icon" aria-hidden="true">{c.kind === "image" ? "image" : c.kind === "folder" ? "folder" : c.kind === "course" ? "attach_file" : "draft"}</md-icon>
          </Chip>)}
        </ChipSet>}
        field={<Textarea
          ref={area}
          rows={1}
          value={text}
          disabled={locked}
          data-composer aria-label={t("Сообщение")}
          placeholder={locked ? t("Ответьте в тесте выше или отмените его") : busy ? t("Агент отвечает — можно написать следующее сообщение") : t("Ответьте или спросите…")}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              void pickFiles(e.clipboardData.files);
            }
          }}
          className="chat-input borderless-input"
        />}
        attach={<>
          <AttachMenu session={session} onFiles={() => fileInput.current?.click()} onChips={addChips} onNote={(note: string) => { if (note) notify(note, { kind: "warn" }); }} />
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => (void pickFiles(e.target.files ?? []), (e.target.value = ""))} />
        </>}
        model={<QualityMenu value={(session as any).quality ?? DEFAULT_QUALITY} onPick={(q: Quality) => void setLessonModel(id, session.model ?? "", session.thinking, q)} side="top" />}
        actions={<>
          {busy && (
            <Tip label={t("Остановить")} hint="Esc">
              <IconButton variant="primary" type="button" aria-label={t("Остановить")} data-primary className="stop-button" onClick={() => stop(id)}>
                <md-icon aria-hidden="true" className="fill-current" >stop</md-icon>
              </IconButton>
            </Tip>
          )}
          {(!busy || canSend) && (
            <SendButton canSend={canSend} queued={busy} onSend={() => submit()} listening={dictation.listening} transcribing={dictation.transcribing} supported={dictation.supported} onDictate={dictation.toggle} />
          )}
        </>}
        mode={<ModeSwitch value={{ mode: session.mode ?? "explain", kind: session.quizKind ?? "check", minutes: 0 }} onChange={choice => void setSessionMode(id, choice).catch(() => {})} />}
        meta={<>
          <div className="min-w-0 flex-1"><AgentStatus session={session} /></div>
          <UsageChip session={session} />
        </>} />
    </div>
  );
}
