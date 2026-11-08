import { useState } from "react";
import { Button } from "./ui/index";
import { AgentLoader, gateWasSeen, markGateSeen } from "./AgentLoader";
import { chooseRole, openExternal, useMax } from "../lib/max";
import { describe } from "../lib/api";

/** Shown before the workspace in the MAX mini-app: sign-in states and the one-time «Ученик / Учитель» choice. */
export function MaxGate() {
  const max = useMax();
  const [busy, setBusy] = useState<"student" | "teacher" | null>(null);
  const [error, setError] = useState("");

  if (max.status === "auth") {
    // Same centred layout as ConnectionGate, so the loader does not jump from the left edge of the column to the centre.
    const still = gateWasSeen();
    markGateSeen();
    return (
      <div className="graphy-workspace relative flex h-full w-full items-center justify-center overflow-hidden bg-paper font-sans text-ink">
        <div className={`agent-gate${still ? " agent-gate-still" : ""}`} role="status" aria-live="polite" aria-busy="true">
          <AgentLoader size={168} />
          <span className="graphy-wordmark agent-gate-brand">Graphy</span>
          <p className="agent-gate-status">Входим через MAX…</p>
        </div>
      </div>
    );
  }
  if (max.status === "needs-max") {
    return <Shell>
      <h1 className="max-gate-title">Откройте ссылку из чата с ботом</h1>
      <p className="max-gate-text">Напишите боту /start в MAX: он пришлёт кнопку «Открыть Graphy». Так мы узнаём, кто вы, и связываем ученика с учителем.</p>
      {max.bot && <Button variant="primary" type="button" onClick={() => openExternal(`https://max.ru/${max.bot}`)}>Написать боту</Button>}
    </Shell>;
  }
  const first = max.user?.first_name || "";
  const pick = async (role: "student" | "teacher") => {
    setBusy(role); setError("");
    try { await chooseRole(role); } catch (e) { setError(describe(e)); setBusy(null); }
  };
  const invited = /^j_/.test(max.start || "");
  return <Shell>
    <h1 className="max-gate-title">{first ? `Привет, ${first}!` : "Привет!"}</h1>
    <p className="max-gate-text">{invited ? "Вас пригласили в класс. Выберите, кто вы в Graphy — роль можно сменить в настройках." : "Выберите, как вы будете пользоваться Graphy. Роль можно сменить в настройках."}</p>
    <div className="max-role-cards" role="group" aria-label="Роль">
      <button type="button" className="max-role-card" data-role="student" data-primary={invited ? "" : undefined} disabled={!!busy} onClick={() => void pick("student")}>
        <span className="max-role-name">Ученик</span>
        <span className="max-role-desc">Учусь с ИИ-репетитором и присоединяюсь к классу по ссылке учителя.</span>
        {busy === "student" && <span className="max-role-busy"><AgentLoader size={40} label="Сохраняем" /></span>}
      </button>
      <button type="button" className="max-role-card" data-role="teacher" disabled={!!busy} onClick={() => void pick("teacher")}>
        <span className="max-role-name">Учитель</span>
        <span className="max-role-desc">Создаю классы и делюсь ссылкой-приглашением с учениками.</span>
        {busy === "teacher" && <span className="max-role-busy"><AgentLoader size={40} label="Сохраняем" /></span>}
      </button>
    </div>
    {error && <p role="alert" className="max-gate-error">{error}</p>}
  </Shell>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="max-gate graphy-workspace bg-paper text-ink font-sans"><div className="max-gate-inner"><span className="graphy-wordmark max-gate-brand">Graphy</span>{children}</div></div>;
}
