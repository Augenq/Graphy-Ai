// WCAG contrast for the Graphy palette pairs in light and dark. Fails below AA:
// 4.5:1 for text, 3:1 for UI components (controls, outlines, focus rings). Run: node scripts/contrast-check.mjs
import { paletteFor } from '../src/lib/palette.ts';

const hex = (c) => {
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  throw Error(`Unsupported colour ${c}`);
};
const parse = (c) => {
  const m = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(c);
  return m ? { rgb: [+m[1], +m[2], +m[3]], a: +m[4] } : { rgb: hex(c), a: 1 };
};
const over = (fg, bg) => { const f = parse(fg); const b = parse(bg); return f.rgb.map((v, i) => v * f.a + b.rgb[i] * (1 - f.a)); };
const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const ratio = (fg, bg, base = bg) => {
  const bgRgb = over(bg, base); const a = lum(over(fg, `#${bgRgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`)); const b = lum(bgRgb);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

const SURFACES = ['paper', 'rail', 'sheet', 'wash', 'bubble', 'plan-bg'];
const TEXT = ['ink', 'ink-2', 'ink-3', 'warn', 'danger'];
const UI = ['control', 'accent', 'course-english', 'course-algebra'];
let failures = 0;
const check = (mode, name, fg, bg, min, base) => {
  const r = ratio(fg, bg, base);
  const ok = r >= min;
  if (!ok) { failures++; console.log(`FAIL ${mode.padEnd(11)} ${name.padEnd(30)} ${r.toFixed(2)} < ${min}`); }
  return r;
};

for (const [mode, dark] of [['light', false], ['dark', true]]) {
  const p = paletteFor(dark);
  for (const s of SURFACES) for (const t of TEXT) check(mode, `${t} on ${s}`, p[t], p[s], 4.5);
  for (const s of ['paper', 'rail', 'sheet']) for (const u of UI) check(mode, `${u} (UI) on ${s}`, p[u], p[s], 3);
  check(mode, 'tooltip (paper on ink)', p.paper, p.ink, 4.5);
  check(mode, 'accent-foreground on accent', p['accent-foreground'], p.accent, 4.5);
  check(mode, 'warn on warn-wash', p.warn, p['warn-wash'], 4.5);
  check(mode, 'danger on warn-wash', p.danger, p['warn-wash'], 4.5);

}
// Toast surfaces: warm glass over the page (worst case is its own tint) and the solid fallback.
for (const [mode, dark] of [['light', false], ['dark', true]]) {
  const p = paletteFor(dark);
  const glass = dark ? '#24211e' : '#fbf6ee';
  for (const t of ['ink', 'ink-2', 'ink-3']) { check(mode, `toast ${t} on glass`, p[t], glass, 4.5); check(mode, `toast ${t} on solid sheet`, p[t], p.sheet, 4.5); }
}
if (failures) { console.error(`${failures} contrast pair(s) below AA`); process.exit(1); }
console.log('Contrast OK: all text pairs >= 4.5:1 and UI pairs >= 3:1 in light and dark');
