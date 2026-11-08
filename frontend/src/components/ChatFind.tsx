import { CaretDown, CaretUp, TextAa, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { clearPaint, findMatches, paint, reveal, setFindQuery } from "../lib/chat-find";
import { t } from "../lib/i18n";
import { Field, IconButton } from "./ui/index";

interface Props {
  /** the scrolling transcript */
  scroller: RefObject<HTMLDivElement | null>;
  /** the transcript's content: searched, and watched for changes */
  content: RefObject<HTMLDivElement | null>;
  /** lesson id: switching lessons closes the bar */
  lessonId: string;
}

/**
 * Ctrl+F in the transcript: user and agent text, folded rows included (they open themselves, see useFindForce).
 * Matches are painted with the CSS Custom Highlight API (no DOM rewriting); without it the current match is selected.
 * Esc closes the bar and nothing else: it is handled in the capture phase so a running agent is not stopped by it.
 */
export function ChatFind({ scroller, content, lessonId }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cs, setCs] = useState(false);
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const ranges = useRef<Range[]>([]);
  const idx = useRef(0);

  const close = useCallback(() => {
    setOpen(false);
    setFindQuery({ query: "", caseSensitive: false });
    clearPaint();
    ranges.current = [];
    const sel = getSelection();
    if (sel && !sel.isCollapsed && content.current?.contains(sel.anchorNode)) sel.removeAllRanges();
  }, [content]);

  useEffect(() => close, [lessonId, close]);

  // open on Ctrl/Cmd+F; Esc closes (and only closes) while the bar is open
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isF = e.code === "KeyF" || ["f", "а"].includes(e.key.toLowerCase()); // physical key: works on a Russian layout
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && isF && scroller.current?.offsetParent !== null) {
        if (document.querySelector("[data-ui-dialog], .pip-large")) return;
        e.preventDefault();
        setOpen(true);
        requestAnimationFrame(() => {
          input.current?.focus();
          input.current?.select();
        });
      } else if (open && e.key === "Escape" && !document.querySelector('.pip-large, [data-ui-dialog], [role="menu"], [role="listbox"], .ui-menu-content')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
        scroller.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close, scroller]);

  const run = useCallback(
    (keep: boolean) => {
      const root = content.current;
      if (!root || !open) return;
      const found = findMatches(root, { query, caseSensitive: cs });
      ranges.current = found;
      idx.current = found.length ? Math.min(keep ? idx.current : 0, found.length - 1) : 0;
      setCount(found.length);
      setIndex(idx.current);
      paint(found, idx.current);
      const r = found[idx.current];
      if (r && !keep && scroller.current) reveal(scroller.current, r);
    },
    [content, open, query, cs, scroller],
  );

  // a new query starts at the first match; folded rows open on the next frame, then the search runs again
  useEffect(() => {
    if (!open) return;
    setFindQuery({ query, caseSensitive: cs });
    run(false);
    const f = requestAnimationFrame(() => run(false));
    return () => cancelAnimationFrame(f);
  }, [open, query, cs, run]);

  // the transcript changes (streaming, a row opens): keep the position and refresh the matches
  useEffect(() => {
    const root = content.current;
    if (!open || !root || !query) return;
    // throttled with a maximum wait: the count keeps refreshing while the answer streams
    let timer = 0;
    let first = 0;
    const fire = () => {
      clearTimeout(timer);
      timer = first = 0;
      run(true);
    };
    const observer = new MutationObserver(() => {
      const now = performance.now();
      if (!first) first = now;
      clearTimeout(timer);
      timer = window.setTimeout(fire, Math.max(0, Math.min(80, 400 - (now - first))));
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [open, query, run, content]);

  const step = (d: 1 | -1) => {
    const n = ranges.current.length;
    if (!n) return;
    idx.current = (idx.current + d + n) % n;
    setIndex(idx.current);
    paint(ranges.current, idx.current);
    if (scroller.current) reveal(scroller.current, ranges.current[idx.current]);
  };

  if (!open) return null;
  const none = query.length > 0 && count === 0;
  return (
    <div className="chat-find" role="search" aria-label={t("Поиск по занятию")}>
      <Field
        ref={input}
        type="text"
        className="chat-find-field"
        innerClassNames={{ input: "chat-find-input" }}
        value={query}
        placeholder={t("Найти в занятии")}
        aria-label={t("Найти в занятии")}
        aria-invalid={none || undefined}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="chat-find-count" role="status" aria-live="polite" data-none={none ? "" : undefined}>
        {query ? (count ? t("{0} из {1}", [index + 1, count]) : t("Нет совпадений")) : ""}
      </span>
      <IconButton className="chat-find-btn" aria-label={t("Предыдущее совпадение")} title={t("Предыдущее (Shift+Enter)")} disabled={!count} onClick={() => step(-1)}>
        <CaretUp aria-hidden="true" className="size-4" />
      </IconButton>
      <IconButton className="chat-find-btn" aria-label={t("Следующее совпадение")} title={t("Следующее (Enter)")} disabled={!count} onClick={() => step(1)}>
        <CaretDown aria-hidden="true" className="size-4" />
      </IconButton>
      <IconButton className="chat-find-btn" aria-label={t("Учитывать регистр")} aria-pressed={cs} variant={cs ? "secondary" : "ghost"} title={t("Учитывать регистр")} onClick={() => setCs((v) => !v)}>
        <TextAa aria-hidden="true" className="size-4" />
      </IconButton>
      <IconButton className="chat-find-btn" aria-label={t("Закрыть поиск")} title={t("Закрыть (Esc)")} onClick={close}>
        <X aria-hidden="true" className="size-4" />
      </IconButton>
    </div>
  );
}
