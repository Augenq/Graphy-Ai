import { useId, type ReactNode } from "react";
// Material Web does not ship a tooltip. Use Material 3 plain-tooltip tokens
// for the small supplement while the control itself retains its accessible name.
export function Tip({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return <span className="tip">{children}<span id={id} role="tooltip" className="tip-label">{label}{hint && <span className="ml-2">{hint}</span>}</span></span>;
}
