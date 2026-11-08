import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowsIn, ArrowsOut, DownloadSimple, File as FileIcon, FileCsv, FileDoc, FileImage, FilePdf, FilePpt, FileText, FileXls, FileZip, X } from "@phosphor-icons/react";
import { t } from "../lib/i18n";
import { describe } from "../lib/api";
import { sanitizeHtml } from "../lib/sanitize";
import { closePresented, downloadFile, kindLabel, loadFile, openPresented, previewKind, type PresentedFile } from "../lib/presented";
import { notify } from "../lib/toast";
import { IconButton } from "./ui/index";
import { Markdown } from "./Markdown";
import { Tip } from "./Tip";
import { ShareFileButton } from "./school/TeacherShareButtons";

const ext = (f: PresentedFile) => f.name.split(".").pop()?.toLowerCase() ?? "";

function iconOf(f: PresentedFile) {
  const e = ext(f);
  if (e === "pdf") return FilePdf;
  if (["doc", "docx", "odt", "rtf"].includes(e)) return FileDoc;
  if (["xls", "xlsx", "ods"].includes(e)) return FileXls;
  if (["ppt", "pptx", "odp"].includes(e)) return FilePpt;
  if (["csv", "tsv"].includes(e)) return FileCsv;
  if (f.mime.startsWith("image/")) return FileImage;
  if (e === "zip") return FileZip;
  if (f.mime.startsWith("text/") || f.mime === "application/json") return FileText;
  return FileIcon;
}

/** «Документ · PDF»: the noun for the type of file, then its format. */
function kindLine(f: PresentedFile): string {
  const e = ext(f);
  const noun = f.mime.startsWith("image/") ? t("Изображение") : ["xls", "xlsx", "ods", "csv", "tsv"].includes(e) ? t("Таблица") : ["ppt", "pptx", "odp"].includes(e) ? t("Презентация") : ["zip"].includes(e) ? t("Архив") : t("Документ");
  return `${noun} · ${kindLabel(f)}`;
}

/** The card in the transcript: click to open the file beside the chat again after it was closed. */
export function FileCard({ sessionId, file, active }: { sessionId: string; file: PresentedFile; active: boolean }) {
  const Icon = iconOf(file);
  return (<>
    <button type="button" className="pf-card" data-pf-card aria-pressed={active} aria-label={t("Открыть файл «{0}»", [file.title])} onClick={() => openPresented(sessionId, file.id)}>
      <span className="pf-card-icon" aria-hidden="true"><Icon size={20} weight="regular" /></span>
      <span className="pf-card-text">
        <span className="pf-card-title">{file.title}</span>
        <span className="pf-card-kind">{kindLine(file)}</span>
      </span>
    </button>
  </>);
}

/* ------------------------------------------------------------------ previews */

type Loaded<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; value: T };

/** Loads something derived from the file's bytes; a newer file or an unmount drops the old answer. */
function useLoaded<T>(file: PresentedFile, make: (blob: Blob) => Promise<T>): Loaded<T> {
  const [result, setResult] = useState<Loaded<T>>({ state: "loading" });
  useEffect(() => {
    let live = true;
    setResult({ state: "loading" });
    loadFile(file).then(make).then(
      (value) => live && setResult({ state: "ready", value }),
      (e) => live && setResult({ state: "error", message: describe(e) }),
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.fileId]);
  return result;
}

function useObjectUrl(blob: Blob | null) {
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : ""), [blob]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return url;
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="pf-notice" role="status">{children}</div>;
}

function NoPreview({ file }: { file: PresentedFile }) {
  const Icon = iconOf(file);
  return (
    <div className="pf-nopreview">
      <Icon size={40} weight="light" aria-hidden="true" />
      <strong>{file.title}</strong>
      <span>{t("Для этого типа файла нет предпросмотра. Скачайте его, чтобы открыть.")}</span>
      <button type="button" className="pf-download-btn" onClick={() => void downloadFile(file).catch((e) => notify(describe(e)))}><DownloadSimple aria-hidden="true" size={16} />{t("Скачать")}</button>
    </div>
  );
}

function Frame({ blob, file }: { blob: Blob; file: PresentedFile }) {
  const url = useObjectUrl(blob);
  // Hide the built-in PDF toolbar and thumbnail pane; keep the page fitted to
  // the preview viewport instead of opening at the browser's default zoom.
  return <iframe className="pf-pdf" title={file.title} src={`${url}#toolbar=0&navpanes=0&zoom=page-fit`} />;
}

function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className="pf-scroll"><article className={`pf-page${wide ? " is-wide" : ""}`}>{children}</article></div>;
}

/** CSV / TSV: quoted fields, doubled quotes and line breaks inside quotes. */
export function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const MAX_ROWS = 500;
function Grid({ rows }: { rows: string[][] }) {
  const shown = rows.slice(0, MAX_ROWS);
  const cols = shown.reduce((n, r) => Math.max(n, r.length), 0);
  return (
    <>
      <table className="pf-table">
        <tbody>
          {shown.map((r, i) => <tr key={i}>{Array.from({ length: cols }, (_, j) => (i === 0 ? <th key={j} scope="col">{r[j] ?? ""}</th> : <td key={j}>{r[j] ?? ""}</td>))}</tr>)}
        </tbody>
      </table>
      {rows.length > MAX_ROWS && <p className="pf-more">{t("Показаны первые {0} строк из {1}. Остальное — в скачанном файле.", [MAX_ROWS, rows.length])}</p>}
    </>
  );
}

function Preview({ file }: { file: PresentedFile }) {
  const kind = previewKind(file);
  const e = ext(file);
  const sheet = e === "xlsx";
  const docx = e === "docx";
  const delimited = e === "csv" || e === "tsv" || file.mime === "text/csv" || file.mime === "text/tab-separated-values";
  const raw = useLoaded<Blob>(file, async (b) => b);
  const asText = useLoaded<string>(file, async (b) => (["markdown", "text", "html"].includes(kind) && !sheet && !docx ? b.text() : ""));
  const asDocx = useLoaded<string>(file, async (b) => {
    if (!docx) return "";
    const mammoth = (await import("mammoth/mammoth.browser")).default;
    return sanitizeHtml((await mammoth.convertToHtml({ arrayBuffer: await b.arrayBuffer() })).value);
  });
  const asSheet = useLoaded<{ name: string; rows: string[][] }[]>(file, async (b) => {
    if (!sheet) return [];
    const read = (await import("read-excel-file/browser")).default as unknown as (f: Blob) => Promise<unknown>;
    const out = (await read(b)) as unknown;
    const toRows = (data: unknown[][]) => data.map((r) => r.map((c) => (c == null ? "" : c instanceof Date ? c.toLocaleDateString() : String(c))));
    if (Array.isArray(out) && out.length && Array.isArray((out[0] as { data?: unknown }).data)) return (out as { sheet: string; data: unknown[][] }[]).map((s) => ({ name: s.sheet, rows: toRows(s.data) }));
    return [{ name: "", rows: toRows(out as unknown[][]) }];
  });
  const [tab, setTab] = useState(0);
  const probe = docx ? asDocx : sheet ? asSheet : raw;
  if (probe.state === "loading") return <Notice>{t("Открываю файл…")}</Notice>;
  if (probe.state === "error") return <Notice>{probe.message.startsWith("Файл") || probe.message.startsWith("Нет связи") ? t(probe.message) : t("Не удалось показать файл: {0}", [probe.message])}</Notice>;
  if (docx && asDocx.state === "ready") return <Page><div className="pf-doc selectable" dangerouslySetInnerHTML={{ __html: asDocx.value }} /></Page>;
  if (sheet && asSheet.state === "ready") {
    const sheets = asSheet.value;
    const cur = sheets[Math.min(tab, sheets.length - 1)];
    return (
      <Page wide>
        {sheets.length > 1 && <div className="pf-tabs" role="tablist">{sheets.map((s, i) => <button key={i} type="button" role="tab" aria-selected={i === tab} onClick={() => setTab(i)}>{s.name || i + 1}</button>)}</div>}
        {cur && cur.rows.length ? <Grid rows={cur.rows} /> : <p className="pf-more">{t("Лист пуст")}</p>}
      </Page>
    );
  }
  if (raw.state !== "ready") return null;
  const blob = raw.value;
  if (kind === "pdf") return <Frame blob={blob} file={file} />;
  if (kind === "image") return <ImagePreview blob={blob} file={file} />;
  if (asText.state === "loading") return <Notice>{t("Открываю файл…")}</Notice>;
  if (asText.state === "error") return <Notice>{asText.message}</Notice>;
  const text = asText.state === "ready" ? asText.value : "";
  if (delimited && kind === "text") return <Page wide><Grid rows={parseDelimited(text, e === "tsv" ? "\t" : ",")} /></Page>;
  if (kind === "markdown") return <Page><Markdown text={text} className="pf-md" /></Page>;
  if (kind === "html") return <HtmlPreview html={text} title={file.title} />;
  if (kind === "text") return <Page><pre className="pf-pre selectable">{text}</pre></Page>;
  return <NoPreview file={file} />;
}

function ImagePreview({ blob, file }: { blob: Blob; file: PresentedFile }) {
  const url = useObjectUrl(blob);
  return <div className="pf-scroll"><img className="pf-img" src={url} alt={file.title} /></div>;
}

/** An HTML document runs in a frame with every sandbox permission off: no scripts, no forms, no network. */
function HtmlPreview({ html, title }: { html: string; title: string }) {
  const doc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"><base target="_blank">${html}`;
  return <iframe className="pf-html" title={title} sandbox="" srcDoc={doc} />;
}

/* -------------------------------------------------------------------- panel */

function Header({ sessionId, file, full, onFull }: { sessionId: string; file: PresentedFile; full: boolean; onFull: () => void }) {
  const [busy, setBusy] = useState(false);
  const download = () => {
    setBusy(true);
    downloadFile(file).catch((e) => notify(describe(e))).finally(() => setBusy(false));
  };
  return (
    <header className="pf-head">
      <h2 className="pf-title" title={file.name}><span className="pf-title-name">{file.title}</span><span className="pf-title-kind"> · {kindLabel(file)}</span></h2>
      <div className="pf-actions">
        <ShareFileButton file={file} compact />
        <Tip label={t("Скачать")}>
          <IconButton variant="ghost" data-pf-download aria-label={t("Скачать файл «{0}»", [file.name])} disabled={busy} onClick={download}><DownloadSimple aria-hidden="true" size={18} /></IconButton>
        </Tip>
        <Tip label={full ? t("Выйти из полноэкранного режима") : t("Развернуть на весь экран")}>
          <IconButton variant="ghost" data-pf-full aria-pressed={full} aria-label={full ? t("Выйти из полноэкранного режима") : t("Развернуть на весь экран")} onClick={onFull}>{full ? <ArrowsIn aria-hidden="true" size={18} /> : <ArrowsOut aria-hidden="true" size={18} />}</IconButton>
        </Tip>
        <Tip label={t("Закрыть")}>
          <IconButton variant="ghost" data-pf-close aria-label={t("Закрыть файл")} onClick={() => closePresented(sessionId)}><X aria-hidden="true" size={18} /></IconButton>
        </Tip>
      </div>
    </header>
  );
}

/** The presented file beside the chat: header with download / full screen / close, the document below. */
export function FileViewer({ sessionId, file }: { sessionId: string; file: PresentedFile }) {
  const [full, setFull] = useState(false);
  useEffect(() => setFull(false), [file.fileId]);
  useEffect(() => {
    if (!full) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector("[data-ui-dialog]")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setFull(false);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [full]);
  const body = (
    <section className={`pf-viewer${full ? " is-full" : ""}`} data-pf-viewer aria-label={t("Файл «{0}»", [file.title])} role={full ? "dialog" : undefined} aria-modal={full || undefined}>
      <Header sessionId={sessionId} file={file} full={full} onFull={() => setFull((v) => !v)} />
      <div className="pf-body"><Preview file={file} /></div>
    </section>
  );
  return full ? createPortal(<div className="pf-overlay" data-pf-overlay>{body}</div>, document.body) : body;
}
