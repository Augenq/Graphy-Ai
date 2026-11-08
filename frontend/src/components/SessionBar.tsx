import { IconButton } from "./ui/index";
import { t } from "../lib/i18n";
import { isImeKey } from "../lib/ime";
import { SidebarSimple } from "@phosphor-icons/react";

import { useEffect, useRef, useState } from "react";
import { type Session } from "../lib/types";
import { StepList } from "./Checklist";
import { Tip } from "./Tip";
import { iconBtn } from "./ui";
import { QuizBar } from "./QuizBar";

/** The step ruler: one tick per plan step; click opens the plan list. */
function StepRuler({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && !isImeKey(e) && (setOpen(false), e.stopPropagation());
    window.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);

  const plan = session.plan;
  const count = plan?.steps.length ?? 0;
  const cur = plan ? Math.min(plan.current, count - 1) : 0;
  const label = plan ? t("Шаг {0} из {1}", [Math.min(plan.current + 1, count), count]) : t("План занятия");

  return (
    <div ref={box} className="relative">
      <button data-material-disclosure
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t("{0}. Открыть план занятия", [label])}
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 cursor-default items-center gap-2.5 rounded-control border-0 bg-transparent px-2 text-sm text-ink-2 transition-colors duration-100 hover:bg-wash"
      ><md-ripple /><md-focus-ring />
        <span aria-hidden className="flex gap-[3px] max-[873.75px]:hidden">
          {Array.from({ length: count }, (_, i) => (
            <i key={i} className={`block h-[3px] w-4 rounded-sm ${i < cur ? "bg-ink-3" : i === cur ? "bg-accent-ui" : "bg-rule-2"}`} />
          ))}
        </span>
        <span className="whitespace-nowrap tabular-nums">
          {label}
        </span>
      </button>
      {open && (
        <div role="dialog" aria-label={t("План занятия")} className="plan-popover fade-in absolute right-0 top-full z-30 mt-2 w-[340px] rounded-sheet border border-outline bg-sheet p-4 shadow-pop">
          {plan && (
            <>
              <div className="text-xs text-ink-3">{t("Цель")}</div>
              <p className="m-0 mt-0.5 text-base font-medium text-ink">{plan.goal}</p>
            </>
          )}
          <div className={plan ? "mt-2" : ""}>
            {plan ? <StepList plan={plan} /> : <p className="m-0 text-sm text-ink-3">{t("План пока не создан")}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

interface Props {
  session: Session;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** space reserved for window controls (macOS traffic lights on the left, others on the right) */
  padLeft: number;
  padRight: number;
}

export function SessionBar({ session, sidebarOpen, onToggleSidebar, padLeft, padRight }: Props) {
  return (
    <header
      className="session-bar drag chrome relative z-10 flex h-11 shrink-0 items-center gap-2 pl-4 pr-3"
      style={{ paddingLeft: padLeft, paddingRight: padRight }}
    >
      {!sidebarOpen && (
        <div className="no-drag">
          <Tip label={t("Показать боковую панель")} hint="Ctrl \\">
            <IconButton variant="ghost" type="button" data-no-ripple aria-label={t("Показать боковую панель")} className={iconBtn} onClick={onToggleSidebar}>
              <SidebarSimple aria-hidden="true" className="size-4" />
            </IconButton>
          </Tip>
        </div>
      )}
      <div className="session-title min-w-0">
        <h1 className="m-0 truncate text-base font-medium leading-5 text-ink">{session.title}</h1>
      </div>
      <div className="min-w-0 flex-1" />
      {session.mode === "quiz" && <div className="no-drag"><QuizBar session={session} /></div>}
    </header>
  );
}
