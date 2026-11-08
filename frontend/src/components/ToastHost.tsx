import { prefersReducedMotion } from "../lib/motion-pref";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "@phosphor-icons/react";
import { Button, IconButton } from "./ui/index";
import { dismissToast, useToasts, type Toast } from "../lib/toast";
import { t } from "../lib/i18n";

/** One toast: its timer waits while the pointer is over it or focus is inside it. */
function ToastItem({ toast }: { toast: Toast }) {
  const [hold, setHold] = useState({ hover: false, focus: false });
  const paused = hold.hover || hold.focus;
  // Leaving plays a 150ms exit (CSS, data-leaving) before the toast is removed; reduced motion removes it at once.
  const [leaving, setLeaving] = useState(false);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const leave = () => {
    if (exitTimer.current) return;
    if (prefersReducedMotion()) return dismissToast(toast.id);
    setLeaving(true);
    exitTimer.current = setTimeout(() => dismissToast(toast.id), 150);
  };
  // The same text raised again (rev) cancels a running exit; unmount clears it.
  useEffect(() => {
    clearTimeout(exitTimer.current); exitTimer.current = undefined; setLeaving(false);
  }, [toast.rev]);
  useEffect(() => () => clearTimeout(exitTimer.current), []);
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  const left = useRef(toast.duration);
  const started = useRef(0);
  useEffect(() => {
    if (paused) return;
    started.current = Date.now();
    const timer = setTimeout(() => leaveRef.current(), left.current);
    return () => {
      clearTimeout(timer);
      left.current = Math.max(1000, left.current - (Date.now() - started.current));
    };
  }, [paused, toast.id, toast.rev]);
  return (
    <div className="toast" data-keeps-escape data-kind={toast.kind} data-paused={paused || undefined} data-leaving={leaving || undefined}
      onPointerEnter={() => setHold((h) => ({ ...h, hover: true }))} onPointerLeave={() => setHold((h) => ({ ...h, hover: false }))}
      onFocus={() => setHold((h) => ({ ...h, focus: true }))} onBlur={() => setHold((h) => ({ ...h, focus: false }))}
      onKeyDown={(e) => { if (e.key === "Escape") { leave(); e.stopPropagation(); } }}>
      <p className="toast-text">{toast.text}</p>
      {toast.action && <Button variant="overlay" className="toast-action" onClick={() => { toast.action!.run(); leave(); }}>{toast.action.label}</Button>}
      <IconButton variant="overlay" className="toast-close" aria-label={t("Закрыть уведомление")} onClick={leave}><X aria-hidden="true" /></IconButton>
    </div>
  );
}

/** The innermost open dialog, if any (Material md-dialog or the MAX Modal frame): a modal keeps focus inside itself and paints over the page. */
const openDialog = () => { const all = document.querySelectorAll<HTMLElement>("md-dialog[open], [data-ui-dialog]"); return all[all.length - 1] ?? null; };

/**
 * Warm glass in the bottom-right. The host is a manual popover (top layer), mounted inside the open dialog when
 * there is one so it stays visible, clickable and hover-pausable above Settings and other modals.
 * Two live regions stay mounted so announcements are reliable.
 */
export function ToastHost() {
  const toasts = useToasts();
  const [dialog, setDialog] = useState<HTMLElement | null>(null);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sync = () => setDialog((d) => { const next = openDialog(); return next === d ? d : next; });
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
    return () => obs.disconnect();
  }, []);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    try { if (!el.matches(":popover-open")) el.showPopover(); } catch { /* popover API missing: z-index still applies */ }
  }, [dialog, toasts.length]);
  const calm = toasts.filter((x) => x.kind !== "error");
  const errors = toasts.filter((x) => x.kind === "error");
  const node = (
    <div ref={host} popover="manual" slot={dialog?.localName === "md-dialog" ? "content" : undefined} className="toast-host" data-toast-host>
      <div role="status" aria-live="polite" aria-atomic="false" className="toast-region">{calm.map((x) => <ToastItem key={x.id} toast={x} />)}</div>
      <div role="alert" aria-live="assertive" aria-atomic="false" className="toast-region">{errors.map((x) => <ToastItem key={x.id} toast={x} />)}</div>
    </div>
  );
  return createPortal(node, dialog ?? document.body);
}
