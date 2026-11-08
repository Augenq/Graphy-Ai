import { useCallback, useEffect, useState } from "react";
import { Button, Field } from "./ui/index";
import { describe } from "../lib/api";
import { chooseRole, hub, openExternal, shareInvite, useMax, type HubClass } from "../lib/max";
import { notify } from "../lib/toast";

/** Settings → «Профиль»: the MAX account (avatar, name), the role, and the teacher link (student) or the invite link (teacher). */
export function MaxProfile() {
  const max = useMax();
  const u = max.user;
  if (!u) return null;
  const initials = (u.first_name[0] || "") + (u.last_name[0] || "");
  const changeRole = async () => {
    const next = u.role === "teacher" ? "student" : "teacher";
    try { await chooseRole(next); notify(next === "teacher" ? "Вы в режиме учителя" : "Вы в режиме ученика", { kind: "success" }); } catch (e) { notify(describe(e), { kind: "error" }); }
  };
  return <div className="max-profile" data-max-profile>
    <div className="max-profile-head">
      {u.photo_url ? <img className="max-avatar" src={u.photo_url} alt="" referrerPolicy="no-referrer" /> : <span className="max-avatar max-avatar-fallback" aria-hidden="true">{initials || "?"}</span>}
      <div className="min-w-0">
        <div className="max-profile-name">{u.name}</div>
        <div className="max-profile-sub">{u.username ? `@${u.username} · ` : ""}MAX id {u.id}</div>
        <div className="max-profile-role" data-role={u.role ?? ""}>{u.role === "teacher" ? "Учитель" : "Ученик"}</div>
      </div>
    </div>
    <div className="max-profile-actions">
      <Button variant="secondary" type="button" onClick={() => void changeRole()}>{u.role === "teacher" ? "Стать учеником" : "Стать учителем"}</Button>
    </div>
    {u.role === "student" ? <StudentLinks /> : <TeacherLinks />}
  </div>;
}

function StudentLinks() {
  const [classes, setClasses] = useState<HubClass[] | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => hub<{ classes: HubClass[] }>("GET", "/hub/student/classes").then((r) => setClasses(r.classes), () => setClasses([])), []);
  useEffect(() => { void load(); }, [load]);
  const join = async () => {
    const value = code.trim().replace(/^.*startapp=/, "").replace(/^j_/, "");
    if (!value) return;
    setBusy(true);
    try { await hub("POST", "/hub/join", { code: value }); setCode(""); await load(); notify("Вы присоединились к классу", { kind: "success" }); } catch (e) { notify(describe(e), { kind: "error" }); } finally { setBusy(false); }
  };
  const leave = async (c: HubClass) => { try { await hub("POST", `/hub/classes/${c.code}/leave`); await load(); } catch (e) { notify(describe(e), { kind: "error" }); } };
  return <section className="max-block">
    <h3 className="max-block-title">Мой учитель</h3>
    {classes === null ? null : classes.length === 0 ? <p className="max-muted">Вы пока не привязаны к учителю. Откройте ссылку-приглашение от учителя или вставьте её код ниже.</p> :
      <ul className="max-list">{classes.map((c) => <li key={c.code} className="max-list-row">
        <div className="min-w-0"><div className="max-row-title">{c.teacher?.name ?? "Учитель"} · {c.title}</div></div>
        <Button variant="ghost" type="button" onClick={() => void leave(c)}>Выйти</Button>
      </li>)}</ul>}
    <div className="max-join">
      <Field label="Код или ссылка приглашения" value={code} onChange={(e) => setCode(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") void join(); }} />
      <Button variant="primary" type="button" disabled={busy || !code.trim()} onClick={() => void join()}>Присоединиться</Button>
    </div>
  </section>;
}

function TeacherLinks() {
  return <section className="max-block"><h3 className="max-block-title">Классы</h3><p className="max-muted">Классы и ссылки-приглашения находятся в разделе «Преподавателю → Классы». <Button variant="ghost" type="button" onClick={() => { location.hash = ""; }}>Закрыть настройки</Button></p></section>;
}
export { openExternal, shareInvite };
