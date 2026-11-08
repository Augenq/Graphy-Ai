/** Layout uses the same logical units as the uniformly scaled Material components. */
export function uiScale(): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) || 1;
}

export const viewportWidth = () => window.innerWidth / uiScale();
