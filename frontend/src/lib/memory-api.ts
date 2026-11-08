/** Client of the strategy-memory API (backend/docs/protocol.md, «Strategy memory»). */
import { useCallback, useEffect, useState } from "react";
import { describe, get, patch, post, put, del } from "./api";

export const FORMS = ["analogy", "worked_example", "formal", "visual", "socratic", "plain"] as const;
export type Form = (typeof FORMS)[number];

export const FORM_LABELS: Record<string, string> = {
  analogy: "Аналогия",
  worked_example: "Разбор на примере",
  formal: "Формальное объяснение",
  visual: "Наглядная схема",
  socratic: "Наводящие вопросы",
  plain: "Обычное объяснение",
};

export interface Profile {
  preferred_style: string | null;
  preferred_form: string | null;
  hint_start: "early" | "late" | null;
  step_size: "smaller" | "bigger" | null;
  evidence: Record<string, string>;
}
export interface StrategyVersion {
  version: number;
  profile: Profile;
  reason: string;
  created: number;
  kind: "auto" | "rollback" | "initial";
}
export interface Observation {
  id: string;
  text: string;
  tag: string;
  status: "active" | "edited";
  form: string;
  form_label: string;
  topic: string;
  outcome: "independent" | "with_hints" | "gap";
  style: string;
  time: number;
  /** false once the learner changed it: edited observations no longer feed the profile */
  included: boolean;
  source: { session: string; course_id: string; message: string; assessment: string };
}
export interface MemoryOverview {
  settings: { adaptive: boolean };
  strategy: StrategyVersion;
  versions: StrategyVersion[];
  observations: Observation[];
  rules: { min_samples: number; half_life_days: number };
}

export const loadMemory = () => get<MemoryOverview>("/memory");
export const rescanMemory = () => post<{ added: number; sessions: number }>("/memory/rescan");
export const setMemorySettings = (s: Partial<MemoryOverview["settings"]>) => put<MemoryOverview["settings"]>("/memory/settings", s);
export const rollbackMemory = (version: number) => post<StrategyVersion>("/memory/rollback", { version });
export const editObservation = (id: string, body: { text?: string; tag?: string }) => patch<{ ok: boolean }>(`/memory/observations/${encodeURIComponent(id)}`, body);
export const deleteObservation = (id: string) => del<{ deleted: boolean }>(`/memory/observations/${encodeURIComponent(id)}`);

export function describeProfile(p: Profile): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  if (p.preferred_form) rows.push({ label: "Что помогает объяснять", value: FORM_LABELS[p.preferred_form] ?? p.preferred_form });
  if (p.preferred_style) rows.push({ label: "Стиль", value: p.preferred_style === "socratic" ? "Сократический" : "Структурный" });
  if (p.hint_start) rows.push({ label: "Первая подсказка", value: p.hint_start === "early" ? "пораньше" : "попозже" });
  if (p.step_size) rows.push({ label: "Размер шага", value: p.step_size === "smaller" ? "помельче" : "покрупнее" });
  return rows;
}

/** The overview plus a way to reload it after every change. */
export function useMemory() {
  const [data, setData] = useState<MemoryOverview | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    try {
      setData(await loadMemory());
      setError("");
    } catch (e) {
      setError(describe(e));
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload, setError };
}
