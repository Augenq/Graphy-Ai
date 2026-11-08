import { useSyncExternalStore } from "react";
import { del, get, patch, post, put } from "./api";
import type { SessionSummary } from "./wire";

/** Everything the backend owns besides the lessons themselves: models, providers, its settings. */

export interface ModelInfo {
  id: string;
  provider: string;
  name: string;
  context: number;
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  thinking_levels: string[];
  metadata_estimated: boolean;
}

export interface ProviderInfo {
  name: string;
  kind: "api" | "local" | "oauth" | "custom";
  api: string;
  base_url: string;
  key_env: string;
  configured: boolean;
  key_source: "env" | "stored" | "";
  models: number;
}

export interface AgentSettings {
  anti_slop_enabled: boolean;
  default_style: import("./styles").ExplanationStyle;
  explanation_depth: import("./styles").ExplanationDepth;
  explanation_presentation: import("./styles").ExplanationPresentation;
  skills_enabled: boolean;
  auto_compact: boolean;
  block_images: boolean;
  default_model: string;
  default_thinking: string;
  web_provider: "searxng" | "duckduckgo" | "brave";
  web_key_set: boolean;
  /** the agent runs in a Docker container: it sees only its working folder */
  sandbox?: boolean;
  tools: string[];
  available_tools: string[];
}

export interface LoginProgress {
  flowId: string;
  state: "starting" | "running" | "waiting_input" | "done" | "cancelled" | "error";
  url?: string;
  userCode?: string;
  prompt?: string;
  message?: string;
}

export interface Remote {
  /** the first bootstrap finished */
  loaded: boolean;
  /** the event stream is connected */
  online: boolean;
  version: string;
  cwd: string;
  root: string;
  models: ModelInfo[];
  providers: ProviderInfo[];
  settings: AgentSettings | null;
  /** at least one model can be used */
  ready: boolean;
  login: LoginProgress | null;
}


let remote: Remote = {
  loaded: false,
  online: false,
  version: "",
  cwd: "",
  root: "",
  models: [],
  providers: [],
  settings: null,
  ready: false,
  login: null,
};
const listeners = new Set<() => void>();

export const getRemote = () => remote;

export function setRemote(patchValue: Partial<Remote>) {
  remote = { ...remote, ...patchValue };
  listeners.forEach((l) => l());
}

export const useRemote = <T,>(select: (r: Remote) => T): T =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(remote),
  );

interface Bootstrap {
  version: string;
  cwd: string;
  root: string;
  models: ModelInfo[];
  ready: boolean;
  settings: AgentSettings;
  providers: ProviderInfo[];
}

/** Loads (or reloads) the whole start-up picture. */
let catalogueRefreshed = false;

/** Once per launch the model list is re-read from the providers, so reasoning levels and prices follow what they advertise. */
function refreshCatalogue(providers: ProviderInfo[]) {
  if (catalogueRefreshed) return;
  catalogueRefreshed = true;
  const names = providers.filter((p) => p.configured).map((p) => p.name);
  void Promise.allSettled(names.map((provider) => post("/models/refresh", { provider }))).then(() => refreshProviders().catch(() => undefined));
}

export async function bootstrap() {
  const data = await get<Bootstrap>("/bootstrap");
  setRemote({
    loaded: true,
    version: data.version,
    cwd: data.cwd,
    root: data.root,
    models: data.models,
    providers: data.providers,
    settings: data.settings,
    ready: data.ready,
  });
  if (data.ready) refreshCatalogue(data.providers);
}

export async function listSessions(): Promise<SessionSummary[]> {
  const data = await get<{ sessions: (SessionSummary & { modified: number })[] }>("/sessions");
  return data.sessions;
}

let providersRun: Promise<void> | null = null;
let providersQueued: Promise<void> | null = null;

/** One request pair at a time, each bounded by a timeout. Callers arriving during a pass share one follow-up pass of their own
 *  (they never inherit the earlier pass's failure); a failed or timed-out pass frees the slot for the next caller. */
export function refreshProviders(): Promise<void> {
  if (providersRun) {
    providersQueued ??= providersRun.then(() => undefined, () => undefined).then(() => {
      providersQueued = null;
      return refreshProviders();
    });
    return providersQueued;
  }
  let pass: Promise<void> | undefined;
  pass = (async () => {
    try {
      const [providers, models] = await Promise.all([
        get<{ providers: ProviderInfo[] }>("/providers", AbortSignal.timeout(15000)),
        get<{ models: ModelInfo[] }>("/models", AbortSignal.timeout(15000)),
      ]);
      setRemote({ providers: providers.providers, models: models.models, ready: models.models.length > 0 });
    } finally {
      if (providersRun === pass) providersRun = null; // freed before the promise settles
    }
  })();
  providersRun = pass;
  return pass;
}

export async function connectProvider(name: string, fields: { key?: string; base_url?: string; api?: string }) {
  const result = await put<{ discovery: { ok: boolean; error: string } }>(`/providers/${encodeURIComponent(name)}`, fields);
  await refreshProviders();
  return result.discovery;
}

export async function disconnectProvider(name: string) {
  await del(`/providers/${encodeURIComponent(name)}`);
  await refreshProviders();
}

export async function updateAgentSettings(change: Partial<AgentSettings>) {
  const settings = await patch<AgentSettings>("/settings", change);
  setRemote({ settings });
  if ("default_model" in change) await refreshProviders();
}

export async function setWebKey(key: string) {
  setRemote({ settings: await put<AgentSettings>("/settings/web-key", { key }) });
}

export async function startCodexLogin(method: "browser" | "device") {
  const { flow_id } = await post<{ flow_id: string }>("/login/codex", { method });
  setRemote({ login: { flowId: flow_id, state: "starting" } });
}

export const answerLogin = (flowId: string, value: string) => post(`/login/${flowId}/input`, { value });

export async function cancelLogin(flowId: string) {
  await del(`/login/${flowId}`).catch(() => undefined);
  setRemote({ login: null });
}
