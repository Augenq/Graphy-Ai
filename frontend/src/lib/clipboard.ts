/** A successful state is shown only after the clipboard operation succeeds. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* Some browser contexts require the local fallback. */ }
  const previous = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("aria-hidden", "true");
  area.style.cssText = "position:fixed;inset:0 auto auto 0;opacity:0;width:1px;height:1px;pointer-events:none";
  // A fallback inside the modal must remain within its native focus trap.
  const modalContent = document.querySelector("[data-ui-dialog] .graphy-dialog-content");
  (modalContent ?? document.body).append(area);
  area.select();
  let copied = false;
  try { copied = document.execCommand("copy"); } catch { /* Let the caller show the failure. */ }
  area.remove();
  previous?.focus({ preventScroll: true });
  if (selection) {
    selection.removeAllRanges();
    ranges.forEach(range => selection.addRange(range));
  }
  return copied;
}
