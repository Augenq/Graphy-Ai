/** Client of the skills library API (backend/docs/protocol.md, «Skills library»). */
import { ApiError, del, get, post, put } from "./api";

export type SkillSource = "user" | "catalog" | "external";
export interface Skill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  source: SkillSource;
  path: string;
  enabled: boolean;
  hash: string;
  /** a catalog skill whose file no longer matches what was installed */
  modified: boolean;
  size: number;
  updated: number;
  editable: boolean;
  warnings: string[];
  catalog?: { id: string; installed_version: string; latest_version: string; update_available: boolean };
  content?: string;
}
export interface CatalogSkill {
  id: string;
  title: string;
  description: string;
  version: string;
  tags: string[];
  sha256: string;
  example: boolean;
  installed: boolean;
  installed_version: string;
  update_available: boolean;
  modified: boolean;
  /** a skill with this id exists that did not come from the catalog */
  conflict: boolean;
}

export const MAX_SKILL_BYTES = 48 * 1024;
const enc = encodeURIComponent;

type ProjectSkill = { name: string; description: string; path: string };
export const listProjectSkills = async (): Promise<{ skills: ProjectSkill[]; warnings: string[] }> => {
  try {
    return await get<{ skills: ProjectSkill[]; warnings: string[] }>("/skills/project");
  } catch (error) {
    // Older backends interpret "project" as a skill id. Keep them usable until restarted or upgraded.
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    const library = await listSkills();
    const isGraphySkill = (path: string) => /(?:^|\/)\.graphy\/skills\/[^/]+\/SKILL\.md$/.test(path.replaceAll("\\", "/"));
    return { skills: library.skills.filter(skill => isGraphySkill(skill.path)), warnings: [] };
  }
};
export const listSkills = () => get<{ skills: Skill[]; warnings: string[] }>("/skills/library");
export const readSkill = (id: string) => get<Skill>(`/skills/${enc(id)}`);
export const createSkill = (v: { name: string; description: string; body: string; tags?: string[] }) => post<Skill>("/skills", v);
export const importSkill = (v: { path?: string; content?: string; name?: string; description?: string }) => post<Skill>("/skills/import", v);
export const saveSkill = (id: string, content: string, expected_hash?: string) => put<Skill>(`/skills/${enc(id)}`, { content, expected_hash });
export const deleteSkill = (id: string) => del<{ deleted: boolean }>(`/skills/${enc(id)}`);
export const setSkillEnabled = (id: string, enabled: boolean) => put<Skill>(`/skills/${enc(id)}/enabled`, { enabled });
export const duplicateSkill = (id: string) => post<Skill>(`/skills/${enc(id)}/duplicate`);
export const listCatalog = () => get<{ skills: CatalogSkill[]; warnings: string[] }>("/skills/catalog");
export const installCatalogSkill = (id: string, force = false) => post<Skill>(`/skills/catalog/${enc(id)}/install`, force ? { force: true } : {});
/** Apply the skill to a lesson: the backend appends it to the transcript and starts the agent. */
export const useSkillInLesson = (sessionId: string, name: string, request = "") =>
  post<{ started: boolean }>(`/sessions/${enc(sessionId)}/skill`, { name, request });

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Mirrors the backend: what «Создать навык» will write to SKILL.md. */
export function buildSkillMd(name: string, description: string, tags: string[], body: string): string {
  const desc = description.split(/\s+/).filter(Boolean).join(" ");
  let out = `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n`;
  if (tags.length) out += `tags: ${tags.join(", ")}\n`;
  return `${out}---\n\n${body.replace(/^\n+|\n+$/g, "")}\n`;
}

export function parseTags(raw: string): string[] {
  return [...new Set(raw.split(",").map((x) => x.trim().toLowerCase()).filter((x) => x && x.length <= 24))].slice(0, 8);
}

/** Name and description from a SKILL.md, for the import preview. */
export function peekSkillMd(text: string): { name: string; description: string; ok: boolean } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.trimStart());
  const field = (key: string) => {
    const line = m?.[1].split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
    let v = line ? line.slice(key.length + 1).trim() : "";
    if (v.startsWith('"')) { try { v = JSON.parse(v) as string; } catch { /* keep raw */ } }
    return v.replace(/^'|'$/g, "");
  };
  const name = field("name");
  return { name, description: field("description"), ok: !!m && NAME_RE.test(name) };
}

/** Client-side hints that match the backend rules, so the dialog can say what is wrong before saving. */
export function skillProblems(name: string, description: string, body: string): string[] {
  const out: string[] = [];
  if (!NAME_RE.test(name)) out.push("name");
  if (!description.trim()) out.push("description");
  else if (description.length > 500) out.push("description-long");
  if (!body.trim()) out.push("body");
  if (new TextEncoder().encode(buildSkillMd(name, description, [], body)).length > MAX_SKILL_BYTES) out.push("size");
  return out;
}

async function entryText(entry: FileSystemEntry): Promise<string | null> {
  if (entry.isFile) {
    const file = await new Promise<File>((ok, no) => (entry as FileSystemFileEntry).file(ok, no));
    return file.size > MAX_SKILL_BYTES ? null : file.text();
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((ok, no) => reader.readEntries(ok, no));
    if (!batch.length) break;
    all.push(...batch);
  }
  const skill = all.find((e) => e.isFile && e.name === "SKILL.md");
  return skill ? entryText(skill) : null;
}

/** Text of a dropped SKILL.md file, or of the SKILL.md inside a dropped folder. */
export async function readDropped(dt: DataTransfer): Promise<string | null> {
  const item = [...dt.items].find((i) => i.kind === "file");
  const entry = item?.webkitGetAsEntry?.();
  if (entry) return entryText(entry);
  const file = dt.files[0];
  return file && file.size <= MAX_SKILL_BYTES ? file.text() : null;
}
