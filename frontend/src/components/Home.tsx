import { Chip, ChipSet, IconButton, Textarea } from "./ui/index";
import { t } from "../lib/i18n";
import { isImeKey } from "../lib/ime";
import { useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { describe } from "../lib/api";
import { chipsFromFiles } from "../lib/attachments";
import { useDictation } from "../lib/dictation";
import { newSession, openSession, send } from "../lib/engine";
import { useRemote } from "../lib/remote";
import { patchSession, useStore } from "../lib/store";
import { hasOpenQuestion, isBusy, type Attachment } from "../lib/types";
import { GraphyMark } from "./GraphyMark";
import { ComposerPanel, fitField } from "./ComposerPanel";
import { ModeSwitch } from "./ModeSwitch";
import { DEFAULT_CHOICE, setSessionMode, type ModeChoice } from "../lib/mode-api";
import { QualityMenu, DEFAULT_QUALITY, type Quality } from "./QualityMenu";
import { SendButton } from "./SendButton";
import { useMax } from "../lib/max";
import { fmtAgo, fmtBytes } from "./ui";

export function Home({ onOpen }: { onOpen: (id: string) => void }) {
  const sessions = useStore(s => s.sessions);
  const order = useStore(s => s.order);
  const ready = useRemote(r => r.ready);
  const [text, setText] = useState("");
  const [choice, setChoice] = useState<ModeChoice>(DEFAULT_CHOICE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [quality, setQuality] = useState<Quality>(DEFAULT_QUALITY);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [chips, setChips] = useState<Attachment[]>([]);
  const [note, setNote] = useState("");
  const settings = useRemote(r => r.settings);
  const max = useMax();
  const textRef = useRef(text);
  textRef.current = text;
  const dictation = useDictation(() => textRef.current, setText);
  useLayoutEffect(() => fitField(area.current), [text]);
  const resume = useMemo(() => order.map(id => sessions[id]).filter(s => s && (!s.finished || hasOpenQuestion(s)) && (s.said > 0 || s.blocks.length > 0))
    .sort((a, b) => Number(hasOpenQuestion(b)) - Number(hasOpenQuestion(a)) || b.updatedAt - a.updatedAt).slice(0, 3), [order, sessions]);

  const canSend = (!!text.trim() || chips.length > 0) && !busy;
  const pickFiles = async (files: FileList | File[]) => {
    const picked = await chipsFromFiles(files);
    setNote(picked.missing ? t("Не удалось загрузить вложение. Проверьте соединение и размер файла (до 20 МБ).") : "");
    if (picked.chips.length) setChips(c => [...c, ...picked.chips]);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) void pickFiles(e.dataTransfer.files);
  };
  const start = async () => {
    const base = text.trim();
    if (!canSend) return;
    setBusy(true);
    setError("");
    try {
      const id = await newSession(settings?.default_style ?? "structured_reference", { quality });
      if (choice.mode !== "explain") await setSessionMode(id, choice);
      patchSession(id, s => ({ ...s, chips }));
      setChips([]);
      await openSession(id);
      void send(id, base);
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !isImeKey(e) && !matchMedia("(pointer: coarse)").matches) { e.preventDefault(); void start(); }
  };
  return <div className="home-screen scroll-y h-full">
    <div className="home-grid" aria-hidden="true" />
    <div className="home-content mx-auto flex min-h-full flex-col justify-center">
      <div className="home-hero">
        <GraphyMark className="home-mark" size={36} />
        <h1 className="home-heading md-typescale-headline-large">{t(max.hub && max.user?.role === "teacher" ? "Что подготовим для урока?" : "Чему хотите научиться?")}</h1>
      </div>
      {!ready && !max.hub && <p role="status" className="md-typescale-body-medium m-0 mb-4 text-warn-ui">{t("Подключите модель в настройках, чтобы начать.")}</p>}
      <section aria-label={t("Новое занятие")}>
        <ComposerPanel variant="home"
          surface={{ onDragOver: e => e.preventDefault(), onDrop }}
          chips={chips.length > 0 && <ChipSet aria-label={t("Материалы занятия")} className="mb-2">
            {chips.map(c => <Chip key={c.id} label={`${c.name}${c.size ? ` · ${fmtBytes(c.size)}` : ""}`} removeLabel={t("Убрать вложение {0}", [c.name])} onRemove={() => setChips(all => all.filter(x => x.id !== c.id))}>
              <md-icon slot="icon" aria-hidden="true">{c.kind === "image" ? "image" : "draft"}</md-icon>
            </Chip>)}
          </ChipSet>}
          field={<Textarea ref={area} rows={2} data-home-goal aria-label={t("Напишите тему или вопрос")}
            placeholder={t(max.hub && max.user?.role === "teacher" ? "Например: тест по дробям для 5 класса" : "Например: объясни дроби простым языком")} value={text} onInput={e => setText(e.currentTarget.value)} onKeyDown={onKeyDown} className="chat-input home-input borderless-input w-full" />}
          notice={(note || dictation.error) && <p role="status" className="md-typescale-body-small m-0 mb-1 px-1 text-warn-ui">{note || dictation.error}</p>}
          attach={<>
            <IconButton variant="ghost" type="button" aria-label={t("Добавить материал (Ctrl+U)")} title={t("Добавить материал (Ctrl+U)")} onClick={() => fileInput.current?.click()}>
              <md-icon aria-hidden="true">add</md-icon>
            </IconButton>
            <input ref={fileInput} type="file" multiple hidden onChange={e => { void pickFiles(e.target.files ?? []); e.target.value = ""; }} />
          </>}
          model={<QualityMenu value={quality} onPick={setQuality} />}
          actions={<SendButton canSend={canSend} onSend={() => void start()} listening={dictation.listening} transcribing={dictation.transcribing} supported={dictation.supported} onDictate={dictation.toggle} />}
          mode={<ModeSwitch value={choice} onChange={setChoice} />} />
        {error && <p role="alert" className="md-typescale-body-medium m-0 mt-3 text-danger-ui">{error}</p>}
      </section>
      {resume.length > 0 && <section aria-labelledby="resume-title" className="home-resume">
        <h2 id="resume-title" className="home-resume-title md-typescale-label-large">{t("Продолжить")}</h2>
        <md-list aria-label={t("Продолжить")}>
          {resume.map(s => <md-list-item key={s.id} type="button" onClick={() => onOpen(s.id)}>
            <md-icon aria-hidden="true" slot="start">history</md-icon>
            <span slot="headline">{s.title}</span>
            <span slot="supporting-text" className="block truncate">{fmtAgo(s.updatedAt)}</span>
            <span slot="end" className="flex items-center gap-2 text-xs text-ink-3">
              <span className="max-[873.75px]:sr-only">{hasOpenQuestion(s) ? t("Ждёт ответов в тесте") : isBusy(s.agent) ? t("Идёт ответ") : ""}</span>
              {hasOpenQuestion(s) && <md-icon aria-hidden="true" className="text-warn-ui">pending</md-icon>}<md-icon aria-hidden="true">chevron_right</md-icon>
            </span>
          </md-list-item>)}
        </md-list>
      </section>}
    </div>
  </div>;
}
