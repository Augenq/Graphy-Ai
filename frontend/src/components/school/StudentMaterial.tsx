import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DownloadSimple } from "@phosphor-icons/react";
import { t } from "../../lib/i18n";
import { describe } from "../../lib/api";
import { sanitizeHtml } from "../../lib/sanitize";
import { previewKind } from "../../lib/presented";
import { materialBlob, school, type MaterialBody } from "../../lib/school";
import { Markdown } from "../Markdown";
import { parseDelimited } from "../PresentedFile";

type Loaded<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; value: T };

const ext = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

function useObjectUrl(blob: Blob | null) {
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : ""), [blob]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return url;
}

function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className="ss-doc-scroll"><article className={`pf-page${wide ? " is-wide" : ""}`}>{children}</article></div>;
}

function Grid({ rows }: { rows: string[][] }) {
  const shown = rows.slice(0, 500);
  const cols = shown.reduce((n, r) => Math.max(n, r.length), 0);
  return <>
    <table className="pf-table"><tbody>{shown.map((r, i) => <tr key={i}>{Array.from({ length: cols }, (_, j) => (i === 0 ? <th key={j} scope="col">{r[j] ?? ""}</th> : <td key={j}>{r[j] ?? ""}</td>))}</tr>)}</tbody></table>
    {rows.length > 500 && <p className="pf-more">{t("Показаны первые {0} строк из {1}. Остальное — в скачанном файле.", [500, rows.length])}</p>}
  </>;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** What the file turns into on screen: a page of rendered HTML, a table, text, or a frame. */
type View =
  | { k: "frame-pdf" } | { k: "image" } | { k: "html"; html: string } | { k: "md"; text: string } | { k: "text"; text: string }
  | { k: "docx"; html: string } | { k: "grid"; sheets: { name: string; rows: string[][] }[] } | { k: "none" };

async function toView(blob: Blob, m: MaterialBody): Promise<View> {
  const kind = previewKind(m);
  const e = ext(m.name);
  if (e === "docx") {
    const mammoth = (await import("mammoth/mammoth.browser")).default;
    return { k: "docx", html: sanitizeHtml((await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() })).value) };
  }
  if (e === "xlsx") {
    const read = (await import("read-excel-file/browser")).default as unknown as (f: Blob) => Promise<unknown>;
    const out = await read(blob);
    const toRows = (data: unknown[][]) => data.map((r) => r.map((c) => (c == null ? "" : c instanceof Date ? c.toLocaleDateString() : String(c))));
    if (Array.isArray(out) && out.length && Array.isArray((out[0] as { data?: unknown }).data)) return { k: "grid", sheets: (out as { sheet: string; data: unknown[][] }[]).map((s) => ({ name: s.sheet, rows: toRows(s.data) })) };
    return { k: "grid", sheets: [{ name: "", rows: toRows(out as unknown[][]) }] };
  }
  if (e === "csv" || e === "tsv" || m.mime === "text/csv" || m.mime === "text/tab-separated-values") return { k: "grid", sheets: [{ name: "", rows: parseDelimited(await blob.text(), e === "tsv" ? "\t" : ",") }] };
  if (kind === "pdf") return { k: "frame-pdf" };
  if (kind === "image") return { k: "image" };
  if (kind === "markdown") return { k: "md", text: await blob.text() };
  if (kind === "html") return { k: "html", html: await blob.text() };
  if (kind === "text") return { k: "text", text: await blob.text() };
  return { k: "none" };
}

/** A material of the School tab rendered like a presented file (same document styles), fetched from the hub. */
const noExt = (n: string) => n.replace(/\.[^.]+$/, "");

export function StudentMaterial({ id, title }: { id: string; title: string }) {
  const [res, setRes] = useState<Loaded<{ m: MaterialBody; blob: Blob; view: View }>>({ state: "loading" });
  const [tab, setTab] = useState(0);
  useEffect(() => {
    let live = true;
    setRes({ state: "loading" });
    school.material(id).then(async (m) => {
      const blob = materialBlob(m);
      return { m, blob, view: await toView(blob, m) };
    }).then((value) => live && setRes({ state: "ready", value }), (e) => live && setRes({ state: "error", message: describe(e) }));
    return () => { live = false; };
  }, [id]);
  const blob = res.state === "ready" ? res.value.blob : null;
  const url = useObjectUrl(blob);
  if (res.state === "loading") return <div className="pf-notice" role="status">{t("Открываю файл…")}</div>;
  if (res.state === "error") return <div className="pf-notice" role="alert">{t("Не удалось показать файл: {0}", [res.message])}</div>;
  const { m, view } = res.value;
  const save = <button type="button" className="pf-download-btn" onClick={() => download(res.value.blob, m.name)}><DownloadSimple aria-hidden="true" size={16} />{t("Скачать")}</button>;
  let body: ReactNode;
  switch (view.k) {
    case "frame-pdf": body = <iframe className="pf-pdf ss-frame" title={title} src={`${url}#toolbar=0&navpanes=0&zoom=page-fit`} />; break;
    case "image": body = <div className="ss-doc-scroll"><img className="pf-img" src={url} alt={title} /></div>; break;
    case "html": body = <iframe className="pf-html ss-frame" title={title} sandbox="" srcDoc={`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"><base target="_blank">${view.html}`} />; break;
    case "md": body = <Page><Markdown text={view.text} className="pf-md" /></Page>; break;
    case "text": body = <Page><pre className="pf-pre selectable">{view.text}</pre></Page>; break;
    case "docx": body = <Page><div className="pf-doc selectable" dangerouslySetInnerHTML={{ __html: view.html }} /></Page>; break;
    case "grid": {
      const cur = view.sheets[Math.min(tab, view.sheets.length - 1)];
      body = <Page wide>
        {view.sheets.length > 1 && <div className="pf-tabs" role="tablist">{view.sheets.map((s, i) => <button key={i} type="button" role="tab" aria-selected={i === tab} onClick={() => setTab(i)}>{s.name || i + 1}</button>)}</div>}
        {cur && cur.rows.length ? <Grid rows={cur.rows} /> : <p className="pf-more">{t("Лист пуст")}</p>}
      </Page>;
      break;
    }
    default: body = <div className="pf-nopreview"><strong>{noExt(m.name)}</strong><span>{t("Для этого типа файла нет предпросмотра. Скачайте его, чтобы открыть.")}</span></div>;
  }
  return <section className="ss-viewer" data-ss-material aria-label={t("Файл «{0}»", [title])}>
    <div className="ss-viewer-bar"><span className="ss-viewer-name" title={noExt(m.name)}>{noExt(m.name)}</span>{view.k !== "none" && save}</div>
    <div className="ss-viewer-body pf-body">{body}</div>
  </section>;
}
