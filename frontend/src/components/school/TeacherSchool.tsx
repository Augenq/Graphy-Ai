import { useCallback, useEffect, useMemo, useState } from "react";
import { CaretRight, ClipboardText, FileText, LinkSimple, Plus, ShareNetwork, Users, Warning } from "@phosphor-icons/react";
import { describe } from "../../lib/api";
import { t } from "../../lib/i18n";
import { hub, shareInvite, type HubClass } from "../../lib/max";
import { fmtDateTime, school, type AssignmentSummary, type ClassGroup, type AssignmentKind } from "../../lib/school";
import { notify } from "../../lib/toast";
import { Button } from "../ui/index";
import { TeacherClasses } from "../TeacherClasses";
import { TeacherAssignment } from "./TeacherAssignment";
import { TeacherShareDialog } from "./TeacherShareDialog";

type View = { name: "home" } | { name: "classes" } | { name: "item"; id: string };
type Create = { kind: AssignmentKind; classCode?: string };

function Row({ a, onOpen }: { a: AssignmentSummary; onOpen: () => void }) {
  const Icon = a.kind === "quiz" ? ClipboardText : FileText;
  const st = a.stats;
  const total = a.recipients_count || 0;
  const done = st?.submitted ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <li>
      <button type="button" className="tsc-item" data-tsc-item={a.id} onClick={onOpen}>
        <Icon size={20} aria-hidden="true" className="tsc-item-icon" />
        <span className="tsc-item-text">
          <span className="tsc-item-title">{a.title}</span>
          <span className="tsc-item-meta">
            {a.kind === "quiz" ? t("Тест") : t("Материал")}
            {a.deadline ? ` · ${t("до {0}", [fmtDateTime(a.deadline)])}` : ""}
          </span>
        </span>
        {a.kind === "quiz" && st && (
          <span className="tsc-prog" title={t("Сдали {0} из {1}", [done, total])}>
            <span className="tsc-prog-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
            <span className="tsc-prog-text">{done}/{total}</span>
          </span>
        )}
        {!!st?.pending_review && <span className="tsc-badge is-warn">{t("проверить: {0}", [st.pending_review])}</span>}
        <CaretRight size={16} aria-hidden="true" className="tsc-item-go" />
      </button>
    </li>
  );
}

function ClassCard({ g, info, onOpen, onCreate }: { g: ClassGroup; info?: HubClass; onOpen: (id: string) => void; onCreate: (c: Create) => void }) {
  const [all, setAll] = useState<AssignmentSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const items = all ?? g.items;
  const students = info?.students?.length ?? 0;
  const showAll = async () => {
    setBusy(true);
    try { setAll((await school.list({ class: g.code, limit: 200 }))[0]?.items ?? g.items); } catch (e) { setError(describe(e)); } finally { setBusy(false); }
  };
  const copy = () => {
    if (!info) return;
    void navigator.clipboard?.writeText(info.invite).then(() => notify(t("Ссылка-приглашение скопирована"), { kind: "success" }), () => notify(info.invite));
  };
  return (
    <section className="tsc-group-card" data-tsc-class={g.code}>
      <header className="tsc-class-head">
        <div className="tsc-class-id">
          <h2 className="tsc-class-name">{g.title}</h2>
          <p className="tsc-hint tsc-class-meta"><Users size={14} aria-hidden="true" /> {students ? t("Учеников: {0}", [students]) : t("Учеников пока нет")}</p>
        </div>
        <div className="tsc-class-actions">
          <Button variant="primary" onClick={() => onCreate({ kind: "quiz", classCode: g.code })} data-tsc-class-quiz iconBefore={<Plus size={16} aria-hidden="true" />}>{t("Тест")}</Button>
          <Button variant="secondary" onClick={() => onCreate({ kind: "material", classCode: g.code })} data-tsc-class-material iconBefore={<Plus size={16} aria-hidden="true" />}>{t("Материал")}</Button>
        </div>
      </header>
      {info && (
        <div className="tsc-invite" data-tsc-invite>
          <span className="tsc-invite-label">{students ? t("Пригласить ещё") : t("Отправьте ученикам ссылку, чтобы они присоединились")}</span>
          <Button variant="ghost" onClick={copy} iconBefore={<LinkSimple size={16} aria-hidden="true" />}>{t("Копировать ссылку")}</Button>
          <Button variant="ghost" onClick={() => shareInvite(info)} iconBefore={<ShareNetwork size={16} aria-hidden="true" />}>{t("Отправить в MAX")}</Button>
        </div>
      )}
      {items.length ? (
        <>
          <ul className="tsc-items">{items.map((a) => <Row key={a.id} a={a} onOpen={() => onOpen(a.id)} />)}</ul>
          {g.total > items.length && <Button variant="ghost" disabled={busy} onClick={() => void showAll()} data-tsc-all>{t("Показать все ({0})", [g.total])}</Button>}
          {error && <p role="alert" className="tsc-error">{error}</p>}
        </>
      ) : <p className="tsc-hint tsc-empty-class">{t("Пока ничего не выдано. Нажмите «Тест» или «Материал», чтобы отправить первое задание.")}</p>}
    </section>
  );
}

/** First visit: no class yet. Create it right here instead of sending the teacher to another section. */
function Onboarding({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try { await hub("POST", "/hub/classes", { title }); setTitle(""); onCreated(); } catch (e) { notify(describe(e), { kind: "error" }); } finally { setBusy(false); }
  };
  return (
    <div className="tsc-onboard" data-empty>
      <h2 className="tsc-onboard-title">{t("Начнём с класса")}</h2>
      <ol className="tsc-steps">
        <li><b>{t("Создайте класс")}</b> — {t("например, «5А математика»")}</li>
        <li><b>{t("Пригласите учеников")}</b> — {t("отправьте им ссылку в MAX")}</li>
        <li><b>{t("Выдайте тест или материал")}</b> — {t("и смотрите результаты здесь")}</li>
      </ol>
      <div className="tsc-onboard-form">
        <input className="tsc-input" type="text" value={title} maxLength={80} placeholder={t("Название класса")} aria-label={t("Название класса")} autoComplete="off"
          onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void create(); }} data-tsc-new-class />
        <Button variant="primary" disabled={!title.trim() || busy} onClick={() => void create()}>{t("Создать класс")}</Button>
      </div>
    </div>
  );
}

/** The teacher's «Школа»: what needs attention, classes with their work, quick creation. */
export function TeacherSchool() {
  const [view, setView] = useState<View>({ name: "home" });
  const [groups, setGroups] = useState<ClassGroup[] | null>(null);
  const [infos, setInfos] = useState<HubClass[]>([]);
  const [error, setError] = useState("");
  const [create, setCreate] = useState<Create | null>(null);
  const load = useCallback(async () => {
    try {
      const [g, c] = await Promise.all([school.list({ limit: 5 }), hub<{ classes: HubClass[] }>("GET", "/hub/classes")]);
      setGroups(g); setInfos(c.classes); setError("");
    } catch (e) { setError(describe(e)); setGroups((g) => g ?? []); }
  }, []);
  useEffect(() => { if (view.name === "home") void load(); }, [view.name, load]);

  const pending = useMemo(() => (groups ?? []).flatMap((g) => g.items).filter((a) => a.stats?.pending_review), [groups]);
  const pendingTotal = pending.reduce((n, a) => n + (a.stats?.pending_review ?? 0), 0);

  return (
    <section className="tsc-view" aria-label={t("Школа")} data-teacher-school>
      <div className="tsc-scroll scroll-y">
        {view.name === "classes" && (
          <>
            <Button variant="ghost" onClick={() => setView({ name: "home" })}>{t("← Назад")}</Button>
            <h2 className="tsc-h2">{t("Классы")}</h2>
            <TeacherClasses />
          </>
        )}
        {view.name === "item" && <TeacherAssignment id={view.id} onBack={() => setView({ name: "home" })} onDeleted={() => setView({ name: "home" })} />}
        {view.name === "home" && (
          <>
            <div className="tsc-top">
              <div>
                <h1 className="tsc-title">{t("Школа")}</h1>
                <p className="tsc-hint">{t("Выдавайте тесты и материалы классам и смотрите, как их выполняют.")}</p>
              </div>
              <div className="tsc-toolbar">
                <Button variant="primary" onClick={() => setCreate({ kind: "quiz" })} data-tsc-new-quiz iconBefore={<Plus size={16} aria-hidden="true" />}>{t("Создать тест")}</Button>
                <Button variant="secondary" onClick={() => setCreate({ kind: "material" })} data-tsc-new-material>{t("Отправить материал")}</Button>
                <Button variant="ghost" onClick={() => setView({ name: "classes" })} data-tsc-classes>{t("Управление классами")}</Button>
              </div>
            </div>
            {error && <p role="alert" className="tsc-error">{error}</p>}
            {groups === null && <p className="tsc-hint">{t("Загрузка…")}</p>}
            {pendingTotal > 0 && (
              <div className="tsc-attention" role="status" data-tsc-attention>
                <Warning size={18} aria-hidden="true" />
                <span className="tsc-attention-text">{t("Ждут вашей проверки: {0}", [pendingTotal])}</span>
                <Button variant="secondary" onClick={() => setView({ name: "item", id: pending[0].id })}>{t("Проверить")}</Button>
              </div>
            )}
            {groups?.length === 0 && !error && <Onboarding onCreated={() => void load()} />}
            {groups?.map((g) => <ClassCard key={g.code} g={g} info={infos.find((c) => c.code === g.code)} onOpen={(id) => setView({ name: "item", id })} onCreate={setCreate} />)}
            {!!groups?.length && <p className="tsc-hint tsc-tip">{t("Совет: попросите Graphy в чате составить тест по теме, и под ответом появится кнопка «Отправить в класс».")}</p>}
          </>
        )}
      </div>
      {create && <TeacherShareDialog kind={create.kind} prefill={{ classCode: create.classCode }} onClose={() => setCreate(null)} onDone={() => void load()} />}
    </section>
  );
}

export default TeacherSchool;
