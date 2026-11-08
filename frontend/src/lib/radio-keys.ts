import type { KeyboardEvent } from "react";

/** Arrow / Home / End keys for a radiogroup of buttons: they move the choice and the focus together, as native radios do.
 *  Radios carry `data-value`; only the chosen one is in the Tab order (roving tabindex). */
export function radioKeys<T extends string>(event: KeyboardEvent<HTMLElement>, values: readonly T[], current: T, pick: (value: T) => void) {
  const index = Math.max(0, values.indexOf(current));
  let next: number | null = null;
  switch (event.key) {
    case "ArrowRight": case "ArrowDown": next = (index + 1) % values.length; break;
    case "ArrowLeft": case "ArrowUp": next = (index - 1 + values.length) % values.length; break;
    case "Home": next = 0; break;
    case "End": next = values.length - 1; break;
  }
  if (next === null) return;
  event.preventDefault();
  const value = values[next];
  pick(value);
  const radios = event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
  [...radios].find(radio => radio.dataset.value === value)?.focus();
}
