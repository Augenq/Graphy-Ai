import { prefersReducedMotion } from "../lib/motion-pref";
import { CopyButton } from "./CopyButton";
import { t } from "../lib/i18n";

import { isValidElement, memo, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { normalizeMath, repairStreaming } from "../lib/math";
import { splitStable } from "../lib/mdChunks";
import { rehypeReveal } from "../lib/rehypeReveal";
import { ChartBlock, HtmlBlock, RichImage, SvgBlock } from "./RichBlocks";

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [[rehypeKatex, { throwOnError: false, strict: "ignore" }]] as never;

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
  return "";
}

/** Extra renderers for model-written questions: charts, sanitized svg/html, images that are never fetched. */
const richComponents: Components = {
  pre({ children }) {
    const el = isValidElement(children) ? (children as ReactElement<{ className?: string; children?: ReactNode }>) : null;
    const lang = /language-(\w+)/.exec(el?.props.className ?? "")?.[1];
    const code = textOf(el?.props.children ?? children).replace(/\n$/, "");
    if (lang === "chart") return <ChartBlock source={code} />;
    if (lang === "svg") return <SvgBlock source={code} />;
    if (lang === "html") return <HtmlBlock source={code} />;
    return <CodePre>{children}</CodePre>;
  },
  img: ({ src, alt }) => <RichImage src={typeof src === "string" ? src : undefined} alt={alt} />,
};

function CodePre({ children }: { children?: ReactNode }) {
    const el = isValidElement(children) ? (children as ReactElement<{ className?: string; children?: ReactNode }>) : null;
    const lang = /language-(\w+)/.exec(el?.props.className ?? "")?.[1] ?? t("код");
    const code = textOf(el?.props.children ?? children).replace(/\n$/, "");
    return (
      <div className="my-4 overflow-hidden rounded-control border border-rule">
        <div className="chrome flex items-center justify-between bg-wash px-3 py-1 font-sans text-xs text-ink-3">
          <span>{lang}</span>
          <CopyButton text={code} label={t("Копировать код")} variant="action" />
        </div>
        <pre className="scroll-x">{children}</pre>
      </div>
    );
}

const components: Components = {
  pre: ({ children }) => <CodePre>{children}</CodePre>,
  table({ children }) {
    return (
      <div className="scroll-x my-4">
        <table>{children}</table>
      </div>
    );
  },
  a({ href, children }) {
    // sandbox:/file:/workspace paths (links to presented files) cannot be opened from here: the file is a card beside the chat
    if (href && !/^(https?:|mailto:|#)/i.test(href.trim())) return <span className="md-dead-link">{children}</span>;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
};

interface Props {
  text: string;
  streaming?: boolean;
  className?: string;
  /** charts, svg and html blocks (agent questions) */
  rich?: boolean;
}

const richAll: Components = { ...components, ...richComponents };
const NO_REVEAL: number[] = [];

/** One stable piece of the answer. Memoized by value: a finished chunk is never parsed (or run through KaTeX) again. */
const Chunk = memo(function Chunk({ src, rich, reveal }: { src: string; rich?: boolean; reveal: number[] }) {
  const plugins = reveal.length ? ([[rehypeReveal, { starts: reveal }], ...rehypePlugins] as never) : rehypePlugins;
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={plugins} components={rich ? richAll : components}>
      {src}
    </ReactMarkdown>
  );
});

/** While streaming, the text reaches the markdown parser at most every `ms`; the last tokens are never held back. */
function useThrottled(text: string, on: boolean, ms: number): string {
  const [shown, setShown] = useState(text);
  const latest = useRef(text);
  const last = useRef(0);
  const timer = useRef<number>(0);
  latest.current = text;
  useEffect(() => {
    if (!on || text === shown || timer.current) return;
    const wait = ms - (performance.now() - last.current);
    const run = () => {
      timer.current = 0;
      last.current = performance.now();
      setShown(latest.current);
    };
    if (wait <= 0) run();
    else timer.current = window.setTimeout(run, wait);
  }, [text, on, shown, ms]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return on ? shown : text;
}

const reduced = prefersReducedMotion;

export const Markdown = memo(function Markdown({ text, streaming, className = "", rich }: Props) {
  const live = useThrottled(text, !!streaming, 100);
  // a message that was streaming in this view stays split into chunks (the DOM does not change when it ends)
  const chunked = useRef(false);
  if (streaming) chunked.current = true;
  // per chunk: how much of it was rendered before, and where each flush of new text began (for the fade-in)
  const seen = useRef<{ len: number; starts: number[] }[]>([]);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; }, []);
  const noReveal = useRef(false);
  if (noReveal.current === false && reduced()) noReveal.current = true;

  const pieces = chunked.current ? splitStable(live) : [live];
  const lastIdx = pieces.length - 1;
  const rendered = pieces.map((raw, i) => {
    // only the open tail can contain unfinished syntax; every earlier chunk is complete
    const src = normalizeMath(streaming && i === lastIdx ? repairStreaming(raw) : raw);
    let rec = seen.current[i];
    if (!rec) rec = seen.current[i] = { len: src.length, starts: streaming && mounted.current ? [0] : [] };
    else if (src.length < rec.len) {
      // repaired text shrank (an unfinished formula was cut): forget flush starts beyond it, so nothing is wrapped twice
      rec.len = src.length;
      rec.starts = rec.starts.filter((x) => x < src.length);
    } else if (streaming && src.length > rec.len) {
      if (!rec.starts.length || rec.len > rec.starts[rec.starts.length - 1]) rec.starts = [...rec.starts, rec.len];
      rec.len = src.length;
    }
    return { src, starts: noReveal.current ? NO_REVEAL : rec.starts };
  });
  seen.current.length = pieces.length;

  return (
    <div className={`md selectable ${className}`}>
      {rendered.map((r, i) => (
        <Chunk key={i} src={r.src} rich={rich} reveal={r.starts} />
      ))}
    </div>
  );
});
