import { prefersReducedMotion } from "../lib/motion-pref";
import { Progress } from "./ui/index";
/** Small working indicator, respecting the system motion preference. */
export function Constellation({ live = true, className = "", size = 12 }: { live?: boolean; className?: string; size?: number }) {
  const reduced = prefersReducedMotion();
  return live ? (
    <span className={`working-indicator ${className}`} style={{ width: size, height: size, minWidth: size }} aria-hidden="true">
      <Progress circular indeterminate={!reduced} value={0.65} size={size} className="working-progress" />
    </span>
  ) : <md-icon aria-hidden="true">psychology</md-icon>;
}
