import { useCallback, useEffect, useState } from "react";
import { Spinner } from "@maxhub/max-ui";
import { Tab, Tabs } from "./ui/index";
import { describe } from "../lib/api";
import { t } from "../lib/i18n";
import { loadDue, startReview, type DueResult } from "../lib/study-api";
import { StudyCalendar } from "./StudyCalendar";
import { StudyReview } from "./StudyReview";
import { StudyBank } from "./StudyBank";

const TABS = ["calendar", "review", "bank"] as const;

/** Study: calendar of reviews and events, what is worth refreshing now, and the bank of answered tasks. */
export function StudyView({ onOpenLesson }: { onOpenLesson: (id: string) => void }) {
  const [tab, setTab] = useState(0);
  const [due, setDue] = useState<DueResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick(n => n + 1), []);
  useEffect(() => {
    let live = true;
    loadDue().then(r => { if (live) { setDue(r); setError(""); } }, e => { if (live) setError(describe(e)); });
    return () => { live = false; };
  }, [tick]);
  const review = async (courseId?: string) => {
    setBusy(true);
    setError("");
    try {
      const id = await startReview(courseId);
      if (id) onOpenLesson(id);
      else setError(t("Сейчас нечего освежать"));
    } catch (e) { setError(describe(e)); } finally { setBusy(false); }
  };
  const count = due?.total_due ?? 0;
  return <section className="study-view" aria-label={t("Учёба")} data-study-view>
    <header className="study-head">
      <p className="study-sub">{t("Календарь, повторение и банк задач из ваших занятий. Всё считается на этом устройстве.")}</p>
    </header>
    <div className="study-bar">
      <Tabs selectedIndex={tab} onSelect={setTab} aria-label={t("Разделы учёбы")}>
        <Tab id="study-tab-calendar" aria-controls="study-panel">{t("Календарь")}</Tab>
        <Tab id="study-tab-review" aria-controls="study-panel">{t("Что повторить")}{count > 0 && <span className="skills-count">{count}</span>}</Tab>
        <Tab id="study-tab-bank" aria-controls="study-panel">{t("Банк задач")}</Tab>
      </Tabs>
    </div>
    <div className="study-scroll scroll-y" id="study-panel" role="tabpanel" aria-labelledby={`study-tab-${TABS[tab]}`}>
      {error && <div className="study-error" role="alert"><span>{error}</span></div>}
      {!due && !error && <div className="study-loading" role="status"><Spinner size={20} aria-hidden="true" />{t("Загрузка")}</div>}
      {tab === 0 && <StudyCalendar due={due} busy={busy} onReview={() => void review()} onChanged={reload} />}
      {tab === 1 && due && <StudyReview due={due} busy={busy} onReview={course => void review(course)} />}
      {tab === 2 && <StudyBank now={due?.now ?? Date.now() / 1000} busy={busy} onReview={() => void review()} onChanged={reload} />}
    </div>
  </section>;
}
