/** True when motion must be skipped: the learner turned animations off in Settings, or the system asks for reduced motion. */
export function prefersReducedMotion(): boolean {
  if (typeof document !== "undefined" && document.documentElement.dataset.motion === "off") return true;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
