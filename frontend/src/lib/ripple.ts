import { prefersReducedMotion } from "./motion-pref";
// One press response for native buttons, menu items and controls inside web components.
export function initRipple() {
  const selector = 'button, [role="button"], [role="tab"], md-list-item[type="button"], md-icon-button, md-filled-button, md-outlined-button, md-text-button';

  const coarse = matchMedia("(pointer: coarse)");
  const show = (event: PointerEvent | MouseEvent) => {
    if (coarse.matches) return; // touch screens keep the platform's own press feedback; the JS wave is mispositioned under page zoom
    if (event instanceof PointerEvent && (event.button !== 0 || !event.isPrimary)) return;
    if (event.type === "click" && event.detail !== 0) return;
    const target = event.composedPath().find(node => node instanceof HTMLElement && node.matches(selector)) as HTMLElement | undefined;
    if (!target || target.matches(':disabled, [disabled], [aria-disabled="true"]')) return;
    if (event.composedPath().some(node => node instanceof Element && node.hasAttribute("data-no-ripple"))) return;
    if (event.composedPath().some(node => node instanceof Element && node.matches('[role="menu"], [role="listbox"], [role="menuitem"], [role="option"], .ui-menu-content'))) return;
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const keyboard = event.type === "click";
    const x = keyboard ? rect.width / 2 : event.clientX - rect.left;
    const y = keyboard ? rect.height / 2 : event.clientY - rect.top;
    const radius = Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y));
    const clip = document.createElement("span");
    const wave = document.createElement("span");
    const style = getComputedStyle(target);
    Object.assign(clip.style, {
      position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
      // DOM rectangles use viewport pixels; cancel the app's root zoom for this fixed overlay.
      zoom: "calc(1 / var(--ui-scale))", borderRadius: style.borderRadius, overflow: "hidden", pointerEvents: "none", zIndex: "2147483647",
    });
    Object.assign(wave.style, {
      position: "absolute", left: `${x - radius}px`, top: `${y - radius}px`, width: `${radius * 2}px`, height: `${radius * 2}px`,
      borderRadius: "50%", background: style.color, opacity: "0.14", transform: "scale(0)",
    });
    clip.append(wave);
    document.body.append(clip);
    const reduced = prefersReducedMotion();
    const animation = wave.animate(reduced
      ? [{ opacity: 0.14, transform: "scale(1)" }, { opacity: 0, transform: "scale(1)" }]
      : [{ opacity: 0.14, transform: "scale(0)" }, { opacity: 0.14, transform: "scale(1)", offset: 0.55 }, { opacity: 0, transform: "scale(1)" }],
    { duration: reduced ? 100 : 450, easing: "ease-out" });
    animation.onfinish = () => clip.remove();
  };
  document.addEventListener("pointerdown", show, true);
  document.addEventListener("click", show, true);
}
