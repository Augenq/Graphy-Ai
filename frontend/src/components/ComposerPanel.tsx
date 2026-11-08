import { prefersReducedMotion } from "../lib/motion-pref";
import { useId, type HTMLAttributes, type ReactNode } from "react";
import { t } from "../lib/i18n";

/**
 * The one input panel of the first screen and of the lesson: no separate copies, so the two cannot drift apart.
 *
 * Two layers, one above the other. The field (white, a clear 1px ring and a soft shadow) holds the text and, in a
 * toolbar of its own, the attach button, the model and the actions. Under it, tucked behind its lower edge, lies a
 * quiet tray of the same width with what the lesson is about: the mode (+ the timer of a quiz).
 * The field sits above the tray by its shadow alone; the tray is rounded only at the bottom, like a sheet slipped under.
 *
 * Slots: `attach`, `model`, `actions` in the toolbar; `mode` and `meta` (status, usage) in the tray.
 */
export function ComposerPanel({ variant, surface, above, overlay, chips, field, notice, attach, model, actions, mode, meta, className = "" }: {
  variant: "home" | "lesson";
  /** props of the field surface (drag and drop, data-drop) */
  surface?: HTMLAttributes<HTMLDivElement> & { "data-drop"?: boolean };
  /** a block above the field (the message queue) */
  above?: ReactNode;
  /** layers inside the field's frame, above its content (drop hint, slash commands) */
  overlay?: ReactNode;
  chips?: ReactNode;
  field: ReactNode;
  notice?: ReactNode;
  attach: ReactNode;
  model?: ReactNode;
  actions: ReactNode;
  mode: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  const trayLabel = useId();
  return <div className={`composer-panel ${className}`} data-composer-panel data-variant={variant}>
    {above}
    <div {...surface} className={`composer-surface${variant === "home" ? " home-composer" : ""} ${surface?.className ?? ""}`}>
      {overlay}
      {chips}
      {field}
      {notice}
      <div className="composer-toolbar">
        <div className="composer-attach">{attach}</div>
        <span className="flex-1" />
        {model}
        <div className="composer-actions">{actions}</div>
      </div>
    </div>
    <div className="composer-tray" role="group" aria-labelledby={trayLabel} data-composer-tray>
      <span id={trayLabel} className="sr-only">{t("Параметры занятия")}</span>
      {mode}
      {meta && <div className="composer-meta">{meta}</div>}
    </div>
  </div>;
}

/**
 * Sizes the field to its text. The height is a pixel value so that CSS (`height 150ms ease-out`) can animate it:
 * measure with `auto` without a transition, put the old height back, then set the new one with the transition on.
 */
export function fitField(input: HTMLTextAreaElement | null, max = 200) {
  if (!input) return;
  const from = input.offsetHeight;
  input.style.transition = "none";
  input.style.height = "auto";
  const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 20;
  const to = Math.max(lineHeight, Math.min(input.scrollHeight, max));
  const still = !from || Math.abs(from - to) < 1 || prefersReducedMotion();
  input.style.height = `${still ? to : from}px`;
  input.style.overflowY = input.scrollHeight > max ? "auto" : "hidden";
  if (still) { input.style.transition = ""; return; }
  void input.offsetHeight; // commit the old height as the start of the transition
  input.style.transition = "";
  input.style.height = `${to}px`;
}
