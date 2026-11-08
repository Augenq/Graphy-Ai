import { Icon16Info } from "@maxhub/max-ui";
import { useId, useState } from "react";
import { IconButton } from "./ui/index";
import { t } from "../lib/i18n";
import { isImeKey } from "../lib/ime";

/**
 * A `?` that keeps long helper text out of the layout. Focusable; the text shows on hover, focus or click,
 * Esc hides it (only while it is shown: otherwise Esc goes on to the dialog), and screen readers always get it:
 * as the button's description and as an always-present visually hidden copy.
 */
export function InfoMark({ text, label }: { text: string; label?: string }) {
  const id = useId();
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = (pinned || hover || focus) && !dismissed;
  const description = { "aria-description": text } as Record<string, string>;
  return (
    <span className="info-mark" data-open={open || undefined} data-pinned={pinned || undefined} data-keeps-escape={open || undefined}>
      <IconButton variant="ghost" size="xsmall" className="info-mark-btn" aria-label={label ?? t("Подробнее")} aria-expanded={open} aria-describedby={id} {...description}
        onClick={() => { setDismissed(false); setPinned((v) => !v); }}
        onFocus={() => { setFocus(true); setDismissed(false); }} onBlur={() => { setFocus(false); setPinned(false); setDismissed(false); }}
        onPointerEnter={() => { setHover(true); setDismissed(false); }} onPointerLeave={() => setHover(false)}
        onKeyDown={(e) => { if (e.key === "Escape" && open && !isImeKey(e)) { e.preventDefault(); e.stopPropagation(); setPinned(false); setDismissed(true); } }}><Icon16Info aria-hidden="true" /></IconButton>
      <span id={id} role="tooltip" className="info-mark-text">{text}</span>
    </span>
  );
}
