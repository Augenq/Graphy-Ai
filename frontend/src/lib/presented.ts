/** Files the agent presents to the learner (the present_file tool): the card in the chat, the panel beside it. */
import { useSyncExternalStore } from "react";
import { connectionInfo, ApiError } from "./api";
import { getState, subscribeStore } from "./store";

export interface PresentedFile {
  /** the id of the transcript block (the tool call) */
  id: string;
  /** the id of the stored snapshot on the backend */
  fileId: string;
  name: string;
  title: string;
  mime: string;
  size: number;
}

export type PreviewKind = "pdf" | "image" | "markdown" | "text" | "html" | "none";

const ext = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

export function previewKind(f: Pick<PresentedFile, "mime" | "name">): PreviewKind {
  if (f.mime === "application/pdf") return "pdf";
  if (f.mime.startsWith("image/")) return "image";
  if (f.mime === "text/markdown") return "markdown";
  if (f.mime === "text/html") return "html";
  if (f.mime.startsWith("text/") || f.mime === "application/json") return "text";
  return ext(f.name) === "md" ? "markdown" : "none";
}

/** «PDF», «Документ Word»: the type word shown under the title of the card and in the panel header. */
export function kindLabel(f: Pick<PresentedFile, "mime" | "name">): string {
  const e = ext(f.name);
  const known: Record<string, string> = {
    pdf: "PDF", docx: "DOCX", xlsx: "XLSX", pptx: "PPTX", md: "MD", markdown: "MD", txt: "TXT", csv: "CSV", json: "JSON", html: "HTML", odt: "ODT", zip: "ZIP",
    png: "PNG", jpg: "JPG", jpeg: "JPG", gif: "GIF", webp: "WEBP", svg: "SVG",
  };
  return known[e] ?? (e ? e.toUpperCase().slice(0, 5) : "FILE");
}

/** The result of a successful present_file call; anything malformed draws nothing. */
export function presentedFromResult(callId: string, content: string): PresentedFile | null {
  try {
    const d = JSON.parse(content) as { ok?: unknown; file?: Record<string, unknown> };
    const f = d.file;
    if (d.ok !== true || !f || typeof f.id !== "string" || typeof f.name !== "string") return null;
    const title = typeof f.title === "string" && f.title.trim() ? f.title.trim() : f.name;
    return { id: callId, fileId: f.id, name: f.name, title, mime: typeof f.mime === "string" ? f.mime : "application/octet-stream", size: typeof f.size === "number" ? f.size : 0 };
  } catch {
    return null;
  }
}

export function fileSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ bytes */

const blobs = new Map<string, Promise<Blob>>();

/** The bytes of a presented file, fetched once with the bearer token (an <iframe src> could not send it). */
export function loadFile(f: Pick<PresentedFile, "fileId" | "mime">): Promise<Blob> {
  let p = blobs.get(f.fileId);
  if (!p) {
    p = (async () => {
      let response: Response;
      try {
        response = await fetch(`${connectionInfo().url}/api/v1/presented/${encodeURIComponent(f.fileId)}`, { headers: { Authorization: `Bearer ${connectionInfo().token}` } });
      } catch {
        throw new ApiError(0, "network", "Нет связи с бэкендом");
      }
      if (!response.ok) throw new ApiError(response.status, "http_error", response.status === 404 ? "Файл больше недоступен" : `Ошибка ${response.status}`);
      return new Blob([await response.arrayBuffer()], { type: f.mime });
    })();
    blobs.set(f.fileId, p);
    p.catch(() => blobs.delete(f.fileId));
  }
  return p;
}

export async function downloadFile(f: PresentedFile): Promise<void> {
  const url = URL.createObjectURL(await loadFile(f));
  const a = Object.assign(document.createElement("a"), { href: url, download: f.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------- which file is open */

/** Per lesson: the block shown in the panel, or null when the learner closed it. */
let open: Record<string, string | null> = {};
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openPresented(sessionId: string, blockId: string) {
  open = { ...open, [sessionId]: blockId };
  emit();
}
export function closePresented(sessionId: string) {
  if (open[sessionId] == null) return;
  open = { ...open, [sessionId]: null };
  emit();
}
export const resetPresented = () => { open = {}; emit(); };

/** The file open in this lesson's panel, if its block still exists. */
export function useOpenFile(sessionId: string): PresentedFile | null {
  const id = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => open[sessionId] ?? null);
  const blocks = useSyncExternalStore(subscribeStore, () => getState().sessions[sessionId]?.blocks);
  const block = id ? blocks?.find((b) => b.id === id) : undefined;
  return block?.kind === "file" ? block.file : null;
}
