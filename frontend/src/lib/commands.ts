/** Command palette model: fuzzy matching and the list of recently used items. Pure, apart from the recents' localStorage. */

/**
 * Subsequence match of `query` in `text`: null when not all letters are found in order, otherwise a score
 * (higher is better): word starts, consecutive letters and an early start score more.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const s = text.toLowerCase();
  const direct = s.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 + (direct === 0 || /[\s\-_/]/.test(s[direct - 1]) ? 200 : 0) - (s.length - q.length);
  let score = 0, last = -2, at = 0;
  for (const ch of q) {
    const i = s.indexOf(ch, at);
    if (i < 0) return null;
    score += 10;
    if (i === last + 1) score += 15;
    if (i === 0 || /[\s\-_/]/.test(s[i - 1])) score += 20;
    score -= Math.min(10, i - at);
    last = i;
    at = i + 1;
  }
  return score;
}

/** Best score over a title and extra search words (words rank lower than the title). */
export function matchScore(query: string, title: string, words = ""): number | null {
  const a = fuzzyScore(query, title);
  const b = words ? fuzzyScore(query, words) : null;
  if (a === null && b === null) return null;
  return Math.max(a ?? -Infinity, b === null ? -Infinity : b - 300);
}

const KEY = "graphy-palette-recent-v1";
const MAX_RECENT = 6;

export function readRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function pushRecent(key: string): string[] {
  const next = [key, ...readRecents().filter((k) => k !== key)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: the list just is not remembered */
  }
  return next;
}
