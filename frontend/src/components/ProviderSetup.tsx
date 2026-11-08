import { ModelIcon } from "./ModelIcon";
import { Button, Field as UIField, Progress } from "./ui/index";
import { t } from "../lib/i18n";
import { useState, type ReactNode } from "react";
import { Select } from "./Select";
import { describe } from "../lib/api";
import { answerLogin, cancelLogin, connectProvider, disconnectProvider, startCodexLogin, useRemote, type ProviderInfo } from "../lib/remote";

const KIND_ICON: Record<ProviderInfo["kind"], string> = { oauth: "cloud", api: "key", local: "memory", custom: "dns" };
const KIND_ORDER: ProviderInfo["kind"][] = ["oauth", "api", "local", "custom"];
const CUSTOM = "__custom";
const APIS = [
  { id: "chat", label: "OpenAI Chat Completions" },
  { id: "responses", label: "OpenAI Responses" },
  { id: "anthropic", label: "Anthropic Messages" },
  { id: "google", label: "Google Generative AI" },
];

function Field({ label, value, onInput, type = "text", placeholder }: { label: string; value: string; onInput: (v: string) => void; type?: "text" | "password"; placeholder?: string }) {
  return <UIField label={label} type={type} value={value} placeholder={placeholder} className="w-full" autoComplete="off" spellCheck={false}
    onInput={(e) => onInput(e.currentTarget.value)} />;
}

/** Browser or device login for ChatGPT / Codex: the agent runs the flow, the window shows its prompts. */
function CodexLogin() {
  const login = useRemote((r) => r.login);
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState("");
  const start = async (method: "browser" | "device") => {
    setError("");
    try {
      await startCodexLogin(method);
    } catch (e) {
      setError(describe(e));
    }
  };
  if (!login)
    return <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" type="button" onClick={() => void start("browser")}>{t("Войти через браузер")}</Button>
      <Button variant="secondary" type="button" onClick={() => void start("device")}>{t("Код устройства")}</Button>
      {error && <p role="alert" className="md-typescale-body-small m-0 w-full text-danger-ui">{error}</p>}
    </div>;
  return <div className="flex flex-col gap-3" role="status" aria-live="polite">
    {login.state === "error" ? <p role="alert" className="md-typescale-body-medium m-0 text-danger-ui">{login.message}</p> : <Progress indeterminate aria-label={t("Вход")} />}
    {login.url && <a href={login.url} target="_blank" rel="noreferrer" className="selectable md-typescale-body-medium break-all text-accent-ui">{login.url}</a>}
    {login.userCode && <p className="md-typescale-body-large m-0">{t("Код:")} <strong className="selectable">{login.userCode}</strong></p>}
    {login.state === "waiting_input" && <>
      <Field label={login.prompt ?? t("Адрес или код из браузера")} value={pasted} onInput={setPasted} />
      <div><Button variant="secondary" type="button" disabled={!pasted.trim()} onClick={() => void answerLogin(login.flowId, pasted.trim()).then(() => setPasted("")).catch((e) => setError(describe(e)))}>{t("Отправить")}</Button></div>
    </>}
    {error && <p role="alert" className="md-typescale-body-small m-0 text-danger-ui">{error}</p>}
    <div><Button variant="ghost" type="button" onClick={() => void cancelLogin(login.flowId)}>{login.state === "error" ? t("Закрыть") : t("Отменить вход")}</Button></div>
  </div>;
}

function KeyForm({ provider }: { provider: ProviderInfo | null }) {
  const local = provider?.kind === "local";
  const custom = provider === null;
  const [name, setName] = useState("");
  const [api, setApi] = useState("chat");
  const [url, setUrl] = useState(custom || local ? (provider?.base_url ?? "") : "");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const target = custom ? name.trim() : provider.name;
  const save = async () => {
    setBusy(true);
    setResult(null);
    try {
      const fields: { key?: string; base_url?: string; api?: string } = {};
      if (key || !local) fields.key = key;
      if (url.trim()) fields.base_url = url.trim();
      if (custom) fields.api = api;
      const found = await connectProvider(target, fields);
      setKey("");
      setResult(found.ok ? { ok: true, text: t("Подключено. Список моделей загружен.") } : { ok: false, text: t("Данные сохранены, но список моделей получить не удалось: {0}", [found.error]) });
    } catch (e) {
      setResult({ ok: false, text: describe(e) });
    } finally {
      setBusy(false);
    }
  };
  const valid = custom ? name.trim() && url.trim() : local || key.trim();
  return <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (valid && !busy) void save(); }}>
    {custom && <Field label={t("Имя провайдера")} value={name} onInput={setName} placeholder="local" />}
    {custom && <div className="flex flex-col gap-1">
      <span className="text-xs text-ink-3">{t("Протокол")}</span>
      <Select block width={280} label={t("Протокол")} value={api} onChange={setApi} options={APIS.map((a) => ({ id: a.id, label: a.label }))} />
    </div>}
    {(custom || local) && <Field label={t("Адрес API")} value={url} onInput={setUrl} placeholder="http://localhost:8080/v1" />}
    <Field label={local || custom ? t("Ключ API (необязательно)") : t("Ключ API")} type="password" value={key} onInput={setKey}
      placeholder={provider?.key_source === "env" ? t("Взят из переменной {0}", [provider.key_env]) : provider?.key_source === "stored" ? t("Сохранён · введите новый, чтобы заменить") : ""} />
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" type="submit" disabled={!valid || busy}>{provider?.configured ? t("Сохранить") : t("Подключить")}</Button>
      {provider?.configured && provider.key_source === "stored" && <Button variant="ghost" type="button" onClick={() => void disconnectProvider(provider.name)}>{t("Удалить ключ")}</Button>}
    </div>
    {busy && <Progress indeterminate aria-label={t("Подключение")} />}
    {result && <p role={result.ok ? "status" : "alert"} className={`md-typescale-body-small m-0 ${result.ok ? "text-ink-2" : "text-warn-ui"}`}>{result.text}</p>}
  </form>;
}

/** Providers the agent can use: pick one, enter what it needs, see at once whether models were found. */
export function ProviderSetup() {
  const providers = useRemote((r) => r.providers);
  const [open, setOpen] = useState<string | null>(null);
  const sorted = [...providers].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || Number(b.configured) - Number(a.configured));
  const row = (id: string, icon: string, title: string, note: ReactNode, form: ReactNode, connected = false) => (
    <div key={id} className="rounded-control border border-outline">
      <button type="button" data-material-disclosure aria-expanded={open === id} onClick={() => setOpen(open === id ? null : id)}
        className="relative flex min-h-12 w-full cursor-default items-center gap-3 rounded-control border-0 bg-transparent px-3 text-left"><md-ripple /><md-focus-ring />
        {id === CUSTOM ? <md-icon aria-hidden="true" className="text-ink-2">{icon}</md-icon> : <ModelIcon provider={id} />}
        <span className="min-w-0 flex-1"><span className="md-typescale-title-small block">{title}</span><span className="md-typescale-body-small block truncate text-ink-3">{note}</span></span>
        {connected && <md-icon aria-label={t("Подключено")} className="text-accent-ui">check_circle</md-icon>}
        <md-icon aria-hidden="true">{open === id ? "expand_less" : "expand_more"}</md-icon>
      </button>
      {open === id && <div className="px-3 pb-3 pt-1">{form}</div>}
    </div>
  );
  return <div className="flex flex-col gap-2">
    {sorted.map((p) => row(p.name, KIND_ICON[p.kind], p.name,
      p.configured ? (p.key_source === "env" ? t("Ключ из переменной {0}", [p.key_env]) : t("Подключено")) : p.kind === "oauth" ? t("Вход через браузер или код устройства") : p.kind === "local" ? t("Локальный сервер: данные не покидают компьютер") : t("Нужен ключ API"),
      p.kind === "oauth" ? <CodexLogin /> : <KeyForm provider={p} />, p.configured))}
    {row(CUSTOM, "add", t("Другой совместимый сервер"), t("Свой адрес и протокол"), <KeyForm provider={null} />)}
  </div>;
}
