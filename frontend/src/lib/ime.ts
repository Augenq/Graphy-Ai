let lastCompositionEnd = -1e9;
if (typeof document !== "undefined") document.addEventListener("compositionend", () => { lastCompositionEnd = performance.now(); }, true);

type KeyLike = { isComposing?: boolean; keyCode?: number; key?: string };

/**
 * A keydown that belongs to an input method editor, not to the app. Safari/WKWebView send the Enter that commits
 * a conversion right after `compositionend`, when `isComposing` is already false but `keyCode` is still 229.
 * keyCode 229 alone is not enough (some keyboards/automation send it): it must come with key "Process" /
 * "Unidentified", or right after a compositionend. Every handler that submits or cancels on Enter/Escape bails out on this.
 */
export function isImeKey(e: KeyLike & { nativeEvent?: KeyLike }): boolean {
  const n: KeyLike = e.nativeEvent ?? e;
  if (e.isComposing || n.isComposing) return true;
  if (e.keyCode !== 229 && n.keyCode !== 229) return false;
  const key = e.key ?? n.key;
  return key === "Process" || key === "Unidentified" || performance.now() - lastCompositionEnd < 200;
}
