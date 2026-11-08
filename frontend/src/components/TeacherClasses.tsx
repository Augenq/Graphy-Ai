import { useCallback, useEffect, useState } from "react";
import { Button, Field } from "./ui/index";
import { describe } from "../lib/api";
import { hub, shareInvite, type HubClass } from "../lib/max";
import { notify } from "../lib/toast";

/** «Классы»: create a class, share the invite link and see its members. */
export function TeacherClasses() {
  const [classes, setClasses] = useState<HubClass[] | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setClasses((await hub<{ classes: HubClass[] }>("GET", "/hub/classes")).classes); } catch (e) { notify(describe(e), { kind: "error" }); setClasses([]); }
  }, []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 30_000); return () => clearInterval(t); }, [load]);

  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try { await hub("POST", "/hub/classes", { title }); setTitle(""); await load(); } catch (e) { notify(describe(e), { kind: "error" }); } finally { setBusy(false); }
  };
  const copy = (text: string) => { void navigator.clipboard?.writeText(text).then(() => notify("Ссылка скопирована", { kind: "success" }), () => notify(text)); };
  const remove = async (c: HubClass) => { try { await hub("DELETE", `/hub/classes/${c.code}`); await load(); } catch (e) { notify(describe(e), { kind: "error" }); } };
  const kick = async (c: HubClass, sid: string) => { try { await hub("DELETE", `/hub/classes/${c.code}/students/${sid}`); await load(); } catch (e) { notify(describe(e), { kind: "error" }); } };

  return <div className="class-view max-classes" data-teacher-classes>
    <div className="max-join">
      <Field label="Новый класс" value={title} onChange={(e) => setTitle(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") void create(); }} />
      <Button variant="primary" type="button" disabled={busy || !title.trim()} onClick={() => void create()}>Создать класс</Button>
    </div>
    {classes?.length === 0 && <div className="teach-empty" data-empty><h2 className="teach-empty-title">Классов пока нет</h2><p className="teach-empty-text">Создайте класс и отправьте ученикам ссылку-приглашение. Когда они присоединятся, список появится здесь.</p></div>}
    {classes?.map((c) => <section key={c.code} className="max-class-card" data-class={c.code}>
      <header className="max-class-head">
        <h2 className="max-class-title">{c.title}</h2>
        <div className="max-class-actions">
          <Button variant="primary" type="button" onClick={() => shareInvite(c)}>Поделиться ссылкой</Button>
          <Button variant="secondary" type="button" onClick={() => copy(c.invite)}>Копировать</Button>
          <Button variant="ghost" type="button" onClick={() => void remove(c)}>Удалить</Button>
        </div>
      </header>
      <p className="max-muted max-invite">{c.invite}</p>
      <h3 className="max-block-title">Ученики ({c.students?.length ?? 0})</h3>
      {!c.students?.length ? <p className="max-muted">Пока никто не присоединился.</p> : <ul className="max-list">{c.students.map((s) => <li key={s.id} className="max-list-row" data-student={s.id}>
        {s.photo_url ? <img className="max-avatar max-avatar-sm" src={s.photo_url} alt="" referrerPolicy="no-referrer" /> : <span className="max-avatar max-avatar-sm max-avatar-fallback" aria-hidden="true">{s.name[0]}</span>}
        <div className="min-w-0 flex-1"><div className="max-row-title">{s.name}</div></div>
        <Button variant="ghost" type="button" onClick={() => void kick(c, s.id)}>Убрать</Button>
      </li>)}</ul>}
    </section>)}
  </div>;
}
