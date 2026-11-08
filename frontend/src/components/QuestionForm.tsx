import { Button, Field, IconButton, Textarea } from "./ui/index";
import { t } from "../lib/i18n";
import { isImeKey } from "../lib/ime";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cancelQuestions, saveDraft, submitQuestions } from "../lib/engine";
import { patchBlock, useSession } from "../lib/store";
import { ShareQuizButton } from "./school/TeacherShareButtons";
import {
  answerState,
  blankAnswer,
  type AnswerDraft,
  type AnswerState,
  type Block,
  type Question,
} from "../lib/types";
import { Markdown } from "./Markdown";
import { btnGhost, btnOutline, btnPrimary, fmtTime, sm } from "./ui";

type QBlock = Extract<Block, { kind: "question" }>;

const plain = (s: string) =>
  s
    .replace(/\\begin\{[a-z]*matrix\}[\s\S]*?\\end\{[a-z]*matrix\}/g, t("[матрица]"))
    .replace(/\\times/g, "×")
    .replace(/\\cdot/g, "·")
    .replace(/\\det/g, "det")
    .replace(/\$\$?/g, "")
    .replace(/\\[a-zA-Z]+/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();

function summarize(q: Question, a: AnswerDraft | undefined): string {
  const st = answerState(q, a);
  if (st === "dont_know") return t("Не знаю");
  if (st === "skipped") return t("Пропущено");
  if (st === "empty" || !a) return t("Не заполнено");
  if (q.type === "free_text") return a.text.trim();
  if (a.useCustom) return t("Свой ответ: {0}", [a.custom.trim()]);
  return a.choices.map((i) => q.options?.[i] ?? "").join("\n\n");
}

const STATE_LABEL: Record<AnswerState, string> = {
  answered: "есть ответ",
  dont_know: "не знаю",
  skipped: "пропущен",
  empty: "не заполнен",
};

/** An option row (>= 44 px) between hairlines: a digit key on the left, a wash when chosen. The key fills with ink. */
function Choice({
  kind,
  name,
  checked,
  onChange,
  index,
  children,
}: {
  kind: "radio" | "checkbox";
  name: string;
  checked: boolean;
  onChange: () => void;
  index: number;
  children: ReactNode;
}) {
  const labelId = useId();
  return (
    <label className={`flex min-h-11 items-center gap-3 rounded-control px-3 py-2 ${checked ? "bg-wash" : "hover:bg-wash/60"}`}>
      {kind === "radio" ? <md-radio name={name} checked={checked} aria-labelledby={labelId} onchange={onChange} /> : <md-checkbox checked={checked} aria-labelledby={labelId} onchange={onChange} />}
      <div id={labelId} className="min-w-0 flex-1 text-content text-ink">{children}</div>
      <span aria-hidden className="text-xs text-ink-3">{index}</span>
    </label>
  );
}

/** The question form; in a teacher's quiz chat the questions can also be saved and sent to a class. */
export function QuestionForm({ sessionId, block }: { sessionId: string; block: QBlock }) {
  const quiz = useSession(sessionId)?.mode === "quiz";
  return <>
    <QuestionFormBody sessionId={sessionId} block={block} />
    {quiz && block.state !== "cancelled" && <ShareQuizButton sessionId={sessionId} batchId={block.id} title={block.title} questions={block.questions} />}
  </>;
}

function QuestionFormBody({ sessionId, block }: { sessionId: string; block: QBlock }) {
  const titleId = useId();
  const root = useRef<HTMLElement>(null);
  const heading = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [nav, setNav] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const patch = (fn: (b: QBlock) => QBlock) => patchBlock(sessionId, block.id, (b) => (b.kind === "question" ? fn(b) : b));

  // the draft is written shortly after typing stops, on step change and on collapse
  const saveSoon = () => {
    setSaving(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      // «сохранено» is shown only once the agent has written the draft to disk
      void saveDraft(sessionId, block.id).then((saved) => {
        if (saved) patch((b) => ({ ...b, savedAt: Date.now() }));
        setSaving(false);
      });
    }, 500);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  // after a step change by the user, focus moves to the new question heading
  useEffect(() => {
    if (nav > 0) heading.current?.focus();
  }, [nav]);

  const setAnswer = (qid: string, change: Partial<AnswerDraft>) => {
    patch((b) => ({
      ...b,
      warn: undefined,
      answers: { ...b.answers, [qid]: { ...(b.answers[qid] ?? blankAnswer()), ...change } },
    }));
    saveSoon();
  };

  const go = (step: number, view: QBlock["view"] = "step") => {
    patch((b) => ({ ...b, step: Math.max(0, Math.min(b.questions.length - 1, step)), view }));
    clearTimeout(timer.current);
    setSaving(false);
    void saveDraft(sessionId, block.id).then((saved) => saved && patch((b) => ({ ...b, savedAt: Date.now() })));
    setNav((n) => n + 1);
  };

  const n = block.questions.length;
  const states = block.questions.map((q) => answerState(q, block.answers[q.id]));
  const filled = states.filter((s) => s !== "empty").length;

  /* ---- non-open states ---- */

  const refRow = "rise flex min-h-12 items-center gap-2.5 rounded-sheet border border-solid border-outline px-3.5 text-base";
  if (block.state === "submitted") {
    return (
      <section aria-label={t("Заданные вопросы")} className={refRow}>
        <md-icon aria-hidden className="shrink-0 text-ink-2" >check</md-icon>
        <span className="min-w-0 truncate font-medium text-ink">{t("Заданные вопросы")}</span>
      </section>
    );
  }
  if (block.state === "cancelled") {
    return (
      <section aria-label={block.title} className="flex items-center gap-2 px-1 text-sm text-ink-3">
        <md-icon aria-hidden="true" className="" >close</md-icon>
        {block.title} {t("— отменён")}
      </section>
    );
  }
  if (block.state === "collapsed") {
    return (
      <section aria-label={block.title} className={`${refRow} !border-warn-ui/50`}>
        <md-icon aria-hidden className="shrink-0 text-warn-ui" >help</md-icon>
        <span className="font-medium text-warn-ui">{t("Тест ждёт ответов")}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-ink-3">
          {block.title} · {filled} {t("из")} {n}
        </span>
        <Button variant="secondary" type="button" className={`${btnOutline} ${sm}`} onClick={() => patch((b) => ({ ...b, state: "open" }))}>
          {t("Открыть")}
        </Button>
      </section>
    );
  }

  /* ---- open ---- */

  const q = block.questions[block.step];
  const a = block.answers[q.id] ?? blankAnswer();
  const name = `${block.id}-${q.id}`;

  const collapse = () => {
    patch((b) => ({ ...b, state: "collapsed" }));
    clearTimeout(timer.current);
    setSaving(false);
    void saveDraft(sessionId, block.id).then((saved) => saved && patch((b) => ({ ...b, savedAt: Date.now() })));
  };

  const submit = () => {
    const firstEmpty = states.findIndex((s) => s === "empty");
    if (firstEmpty >= 0) {
      patch((b) => ({
        ...b,
        step: firstEmpty,
        view: "step",
        warn: t("Вопрос {0} не заполнен: ответьте, пропустите или нажмите «Не знаю».", [firstEmpty + 1]),
      }));
      setNav((x) => x + 1);
      return;
    }
    void submitQuestions(sessionId, block.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (isImeKey(e)) { if (e.key === "Escape") (e.preventDefault(), e.stopPropagation()); return; }
    const t = (e.nativeEvent.composedPath()[0] ?? e.target) as HTMLElement;
    const isText = t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && t.type === "text");
    if (e.altKey && e.key === "ArrowLeft") return e.preventDefault(), go(block.step - 1);
    if (e.altKey && e.key === "ArrowRight") return e.preventDefault(), block.step === n - 1 ? go(block.step, "review") : go(block.step + 1);
    if (e.altKey && (e.key === "x" || e.key === "X")) return e.preventDefault(), setConfirmCancel(true);
    if (e.key === "Escape") return e.preventDefault(), confirmCancel ? setConfirmCancel(false) : collapse();
    if (block.view !== "step") return;

    const edge = (end: boolean) =>
      !isText ||
      ((t as HTMLTextAreaElement).selectionStart === (t as HTMLTextAreaElement).selectionEnd &&
        (t as HTMLTextAreaElement).selectionStart === (end ? (t as HTMLTextAreaElement).value.length : 0));
    if (e.key === "ArrowLeft" && !e.altKey && !e.ctrlKey && edge(false)) {
      e.preventDefault();
      go(block.step - 1);
    } else if (e.key === "ArrowRight" && !e.altKey && !e.ctrlKey && edge(true)) {
      e.preventDefault();
      block.step === n - 1 ? go(block.step, "review") : go(block.step + 1);
    }
    // checkboxes do not move focus with arrows natively
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && t instanceof HTMLInputElement && t.type === "checkbox") {
      e.preventDefault();
      const boxes = [...(root.current?.querySelectorAll<HTMLInputElement>('md-checkbox') ?? [])];
      const host = e.nativeEvent.composedPath().find(el => el instanceof HTMLElement && el.localName === "md-checkbox");
      const i = boxes.indexOf(host as HTMLInputElement) + (e.key === "ArrowDown" ? 1 : -1);
      boxes[(i + boxes.length) % boxes.length]?.focus();
    }
    // digits pick an option when focus is not in a text field
    if (!isText && /^[1-8]$/.test(e.key) && q.options && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const i = Number(e.key) - 1;
      if (i < q.options.length) {
        e.preventDefault();
        toggle(i);
      } else if (i === q.options.length) {
        e.preventDefault();
        setAnswer(q.id, { mark: null, useCustom: true, choices: [] });
      }
    }
  };

  const toggle = (i: number) => {
    if (q.type === "multiple_choice") {
      const has = a.choices.includes(i);
      setAnswer(q.id, { mark: null, useCustom: false, choices: has ? a.choices.filter((x) => x !== i) : [...a.choices, i].sort() });
    } else setAnswer(q.id, { mark: null, useCustom: false, choices: [i] });
  };

  const mark = (m: "dont_know" | "skipped") => {
    setAnswer(q.id, { mark: a.mark === m ? null : m });
    if (a.mark !== m) {
      if (block.step === n - 1) go(block.step, "review");
      else go(block.step + 1);
    }
  };

  const prefix = q.options?.length ?? 0;
  return (
    <section ref={root} role="group" aria-labelledby={titleId} onKeyDown={onKeyDown} className="rise question-form">
      <div className="overflow-hidden rounded-sheet border border-outline bg-sheet">
        <header className="flex h-11 items-center gap-3 border-b border-rule pl-4 pr-2">
          <h3 id={titleId} className="m-0 min-w-0 truncate text-base font-medium text-ink">
            {block.title}
          </h3>
          <span className="hidden min-w-0 flex-1 truncate text-sm text-ink-3 min-[900px]:block" aria-live="polite">
            {saving ? t("сохраняется…") : block.savedAt ? t("сохранено") : ""}
          </span>
          <span className="flex-1 min-[900px]:hidden" />
          <Button variant="ghost" type="button" className={`${btnGhost} ${sm} shrink-0`} onClick={collapse} aria-label={t("Свернуть тест (Esc)")}>
            {t("Свернуть")}
            <md-icon slot="icon" aria-hidden="true" className="" >expand_more</md-icon>
          </Button>
        </header>

        <div className="px-4 pb-2 pt-4">
          <div role="group" aria-label={t("Вопросы теста")} className="question-steps mb-4 flex flex-wrap gap-2">
            {block.questions.map((qq, i) => <IconButton variant="secondary" key={qq.id}
              className={`question-step ${block.view === "step" && i === block.step ? "is-current" : ""}`}
              data-answer-state={states[i]}
              aria-label={t("Вопрос {0}: {1}", [i + 1, t(STATE_LABEL[states[i]])])}
              aria-current={block.view === "step" && i === block.step ? "step" : undefined}
              onClick={() => go(i)}>
              <span aria-hidden="true">{i + 1}</span>
            </IconButton>)}
          </div>

          {block.warn && (
            <p role="alert" className="m-0 mb-3 rounded-control bg-warn-wash px-3 py-2 text-sm text-warn-ui">
              {/^Вопрос \d+ не заполнен:/.test(block.warn)
                ? t("Вопрос {0} не заполнен: ответьте, пропустите или нажмите «Не знаю».", [block.warn.match(/\d+/)?.[0]])
                : block.warn}
            </p>
          )}

          {block.view === "review" ? (
            <div>
              <div role="heading" aria-level={4} ref={heading} tabIndex={-1} className="m-0 mb-2 text-lg font-medium text-ink outline-none">
                {t("Обзор · заполнено")} {filled} {t("из")} {n}
              </div>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {block.questions.map((qq, i) => (
                  <li key={qq.id} className="flex items-start gap-3 rounded-control border border-outline px-3 py-2.5">
                    <span className="w-4 shrink-0 pt-0.5 text-sm tabular-nums text-ink-3">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <Markdown text={qq.prompt} className="md-ui text-sm text-ink-3" />
                      <Markdown text={summarize(qq, block.answers[qq.id])} className={`md-ui mt-1 text-base ${states[i] === "empty" ? "text-warn-ui" : "text-ink"}`} />
                    </div>
                    <Button variant="secondary" type="button" className={`${btnOutline} ${sm}`} onClick={() => go(i)}>
                      {t("Изменить")}
                    </Button>
                  </li>
                ))}
              </ul>
              <p className="m-0 mt-3 text-sm text-ink-3">
                {t("Только «Отправить ответы» передаёт их агенту. После отправки ответы нельзя изменить — уточнение можно написать сообщением.")}
              </p>
            </div>
          ) : (
            <div>
              <div className="mb-1 text-sm text-ink-3">
                {t("Вопрос")} {block.step + 1} {t("из")} {n}
              </div>
              <div role="heading" aria-level={4} ref={heading} tabIndex={-1} className="m-0 mb-4 text-lg font-medium outline-none">
                <Markdown rich text={q.prompt} className="md-ui" />
              </div>

              {q.type === "free_text" ? (
                <Textarea
                  aria-label={t("Ваш ответ")}
                  rows={4}
                  value={a.text}
                  disabled={a.mark !== null}
                  placeholder={t("Ответьте своими словами")}
                  onInput={(e) => setAnswer(q.id, { text: e.currentTarget.value, mark: null })}
                  className="material-field"
                />
              ) : (
                <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                  <legend className="sr-only">{plain(q.prompt)}</legend>
                  {q.options?.map((o, i) => (
                    <Choice
                      key={o}
                      kind={q.type === "multiple_choice" ? "checkbox" : "radio"}
                      name={name}
                      index={i + 1}
                      checked={a.mark === null && !a.useCustom && a.choices.includes(i)}
                      onChange={() => toggle(i)}
                    >
                      <Markdown rich text={o} className="md-ui" />
                    </Choice>
                  ))}
                  <Choice
                    kind={q.type === "multiple_choice" ? "checkbox" : "radio"}
                    name={name}
                    index={prefix + 1}
                    checked={a.mark === null && a.useCustom}
                    onChange={() => setAnswer(q.id, { mark: null, useCustom: true, choices: [] })}
                  >
                    {a.useCustom && a.mark === null ? (
                      <Field
                        type="text"
                        autoFocus
                        aria-label={t("Свой ответ")}
                        placeholder={t("Свой ответ…")}
                        value={a.custom}
                        onInput={(e) => setAnswer(q.id, { custom: e.currentTarget.value })}
                        className="material-field"
                      />
                    ) : (
                      <span className="text-ink-2">{t("Свой ответ…")}</span>
                    )}
                  </Choice>
                </fieldset>
              )}

              <div className="mt-3.5">
                <label className="mb-1 block text-sm text-ink-3" htmlFor={`${name}-why`}>
                  {t("Ход рассуждений · необязательно")}
                </label>
                <Textarea
                  id={`${name}-why`}
                  rows={1}
                  value={a.reasoning}
                  placeholder={t("Как вы пришли к ответу?")}
                  onInput={(e) => setAnswer(q.id, { reasoning: e.currentTarget.value })}
                  className="material-field"
                />
              </div>

              {(a.mark === "dont_know" || a.mark === "skipped") && (
                <p className="m-0 mt-2 text-sm text-ink-3">
                  {a.mark === "dont_know" ? t("Отмечено «Не знаю» — это пробел в знаниях, не ошибка.") : t("Вопрос пропущен.")} {t("Чтобы ответить, выберите вариант или введите текст.")}
                </p>
              )}
            </div>
          )}
        </div>

        <footer className="question-actions flex items-center gap-2 px-4 py-3">
          {block.view === "review" ? (
            <>
              <Button variant="secondary" type="button" className={btnOutline} onClick={() => go(n - 1)}>
                <md-icon slot="icon" aria-hidden="true" className="" >arrow_back</md-icon>{t("К вопросам")}
              </Button>
              <span className="flex-1" />
              <Button variant="primary" type="button" className={btnPrimary} onClick={submit}>
                {t("Отправить ответы")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" type="button" aria-pressed={a.mark === "dont_know"} className={`${btnOutline} ${a.mark === "dont_know" ? "!bg-ink/12" : ""}`} onClick={() => mark("dont_know")}>
                {t("Не знаю")}
              </Button>
              <Button variant="secondary" type="button" aria-pressed={a.mark === "skipped"} className={`${btnOutline} ${a.mark === "skipped" ? "!bg-ink/12" : ""}`} onClick={() => mark("skipped")}>
                {t("Пропустить")}
              </Button>
              <span className="flex-1" />
              <Button variant="secondary" type="button" className={btnOutline} disabled={block.step === 0} onClick={() => go(block.step - 1)}>
                <md-icon slot="icon" aria-hidden="true" className="" >arrow_back</md-icon>
                {t("Назад")}
              </Button>
              <Button variant="primary" type="button" className={btnPrimary} onClick={() => (block.step === n - 1 ? go(block.step, "review") : go(block.step + 1))}>
                {block.step === n - 1 ? t("Обзор") : t("Далее")}
                <md-icon slot="icon" aria-hidden="true" className="" >arrow_forward</md-icon>
              </Button>
            </>
          )}
        </footer>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-end gap-x-4 gap-y-1 px-1 text-xs text-ink-3">
        {confirmCancel ? (
          <>
            <span role="alert" className="text-ink">
              {t("Отменить тест? Неотправленные ответы не оцениваются.")}
            </span>
            <Button variant="secondary" type="button" className={`${btnOutline} ${sm}`} onClick={() => cancelQuestions(sessionId, block.id)}>
              {t("Отменить тест")}
            </Button>
            <Button variant="ghost" type="button" className={`${btnGhost} ${sm}`} onClick={() => setConfirmCancel(false)}>
              {t("Вернуться")}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" type="button" className="material-button" onClick={() => setConfirmCancel(true)}>
              {t("Отменить тест (Alt+X)")}
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
