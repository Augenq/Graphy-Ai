// Token and cost tracking: the composer chip follows the stream, the Settings section draws every chart
// with real numbers, and unknown costs are never invented.
import { until, wait, navigate, click, closeDialog } from './ui-regression.mjs';
const assert = (value, message) => { if (!value) throw Error(message); };
const q = (selector, root = document) => root.querySelector(selector);

export async function runUsageRegression(theme = 'dark') {
  const { updateSettings } = await import('/src/lib/settings.ts');
  const { getState } = await import('/src/lib/store.ts');
  const usage = await import('/src/lib/usage.ts');
  updateSettings({ language: 'ru', theme });
  await closeDialog();

  // --- pure helpers ---
  assert(usage.fmtCost(0, true) === '—', 'An unknown cost must read "—", never $0');
  assert(usage.fmtCost(0.5, true).startsWith('≥'), 'A partial sum must be marked "≥"');
  assert(usage.fmtCost(0, false) === '$0', 'A known zero cost is $0');
  assert(usage.cacheHit({ input: 100, cache_read: 300, cache_write: 0 }) === 0.75 && usage.cacheHit({ input: 0, cache_read: 0, cache_write: 0 }) === null, 'Cache hit share');
  const after = usage.addUsage({ input: 1, output: 1, cache_read: 0, cache_write: 0, cost: 0.1, unknown_cost: false }, { input: 2, output: 3, cache_read: 4, cache_write: 5, cost: null });
  assert(after.input === 3 && after.cache_write === 5 && after.cost === 0.1 && after.unknown_cost === true, 'A call without a cost flags the total as unknown and adds nothing to the cost');
  const grid = usage.heatGrid([{ day: '2026-11-05', tokens: 10, lessons: 1 }], '2026-11-05', 4);
  assert(grid.length === 4 && grid.every(c => c.length === 7) && grid[3].some(c => c.day === '2026-11-05' && c.level === 4), 'Heatmap grid is Monday-first weeks ending this week');
  assert(usage.niceScale(930).max >= 930 && usage.niceScale(0).max > 0, 'Axis scale covers the data');

  assert(usage.parseSessionUsage({}) === undefined && usage.parseSessionUsage(null) === undefined && usage.parseSessionUsage({ input: 3 }).input === 3, 'An empty usage object is "no data", not zeros');

  // --- chip under the input ---
  await navigate('Матрицы');
  const chip = () => q('.usage-chip');
  await until(chip, 'The usage chip appears under the input');
  const first = chip().textContent;
  assert(/\$0[.,]04/.test(first), `The chip shows the lesson cost, got "${first}"`);
  const before = getState().sessions['fixture-matrix'].usage;
  window.__mockBackend.emitAnswer('fixture-matrix', { input: 1000, output: 500, cache_read: 0, cache_write: 0, cost: 0.01 });
  await until(() => getState().sessions['fixture-matrix'].usage?.output === before.output + 500, 'A finished answer moves the totals live');
  window.__mockBackend.emitUsage('fixture-matrix', { input: 5200, output: 2300, cache_read: 38000, cache_write: 2100, cost: 0.0521, unknown_cost: false });
  await until(() => getState().sessions['fixture-matrix'].usage?.input === 5200, 'The usage event settles the totals');
  window.__mockBackend.emitUsage('fixture-matrix', { input: 5200, output: 2300, cache_read: 38000, cache_write: 2100, cost: 0, unknown_cost: true });
  await until(() => /—/.test(chip().getAttribute('aria-label')), 'An unknown cost shows as unknown on the chip');
  window.__mockBackend.emitUsage('fixture-matrix', { input: 5200, output: 2300, cache_read: 38000, cache_write: 2100, cost: 0.0521, unknown_cost: false });
  await until(() => /\$0[.,]052/.test(chip().getAttribute('aria-label')), 'The chip returns to the known cost');
  assert(/кэш \d+%/.test(chip().getAttribute('aria-label')), 'The chip label includes the cache share');
  chip().click();
  await until(() => q('.usage-pop'), 'The popover opens');
  const pop = q('.usage-pop');
  assert(chip().getAttribute('aria-expanded') === 'true' && pop.id === chip().getAttribute('aria-controls'), 'Chip and popover are linked');
  assert(/Ввод/.test(pop.textContent) && /Кэш: чтение/.test(pop.textContent) && /Окно контекста/.test(pop.textContent) && q('[role=meter]', pop), 'The popover shows the breakdown and the context window');
  const box = pop.getBoundingClientRect();
  assert(box.top >= 0 && box.left >= 0 && box.right <= innerWidth + 1, 'The popover stays on screen');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await until(() => !q('.usage-pop'), 'Escape closes the popover');

  // --- settings section ---
  await navigate('Настройки');
  await wait(300);
  const item = [...document.querySelectorAll('.settings-nav md-list-item')].find(e => e.getAttribute('aria-label') === 'Использование');
  assert(item, 'Settings has the «Использование» section');
  click(item);
  await until(() => q('.usage-report'), 'The report loads');
  const text = () => q('.usage').textContent;
  for (const label of ['Токены', 'Стоимость', 'Занятия', 'Попадания в кэш', 'Токены по дням', 'Стоимость во времени', 'По моделям', 'Дни занятий', 'Самые затратные занятия'])
    assert(text().includes(label), `Missing: ${label}`);
  assert(document.querySelectorAll('.usage-kpi').length === 4, 'Four KPI tiles');
  assert(document.querySelectorAll('.usage-bar').length === 30, 'One stacked bar per day of the 30-day range');
  assert(q('.usage-line') && q('.usage-dot-partial'), 'The cost line draws known days and marks partly priced ones');
  assert(document.querySelectorAll('.usage-cell').length > 100 && q('.usage-cell.usage-lv4'), 'The calendar heatmap draws the study days');
  assert([...document.querySelectorAll('.usage-heat-label')].some((e) => e.textContent === new Date(2026, 10, 2).toLocaleDateString('ru-RU', { weekday: 'short' })), 'Heatmap weekday labels follow the app language, not the browser locale');
  assert(document.querySelectorAll('.usage-slice').length === 3 && text().includes('Определитель и обратная матрица'), 'Donut slices and the costliest lessons');
  assert(document.querySelectorAll('.usage-plot table.usage-sr').length === 3 && q('.usage-plot table.usage-sr tbody tr'), 'Each chart has a screen-reader data table');
  assert(!text().includes('NaN') && !text().includes('undefined'), 'No NaN/undefined in the report');
  const body = q('.settings-body');
  assert(body.scrollWidth <= body.clientWidth + 1, 'No horizontal overflow in the usage section');
  // colour is never the only cue: each stacked series has its own texture
  const patterns = [...document.querySelectorAll('.usage-svg pattern')].filter(p => p.closest('.usage-plot')?.querySelector('.usage-bar'));
  assert(patterns.length === 3 && patterns.filter(p => p.querySelector('path, circle')).length === 2, 'Input solid, output and cache textured');

  // tooltips: pointer and keyboard
  const plot = q('.usage-plot');
  plot.focus();
  await until(() => q('.usage-tip', plot), 'Focus shows a tooltip');
  const tip = q('.usage-tip', plot).textContent;
  assert(/Ввод/.test(tip) && /Вывод/.test(tip) && /Кэш/.test(tip) && /Стоимость/.test(tip), 'The tooltip lists input, output, cache and cost');
  plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  await wait(60);
  assert(q('.usage-tip', plot).textContent !== tip, 'Arrow keys move the tooltip to another day');
  const pr = plot.getBoundingClientRect();
  plot.dispatchEvent(new PointerEvent('pointermove', { clientX: pr.left + pr.width * 0.5, clientY: pr.top + 40, bubbles: true }));
  await wait(60);
  assert(q('.usage-tip', plot), 'Hover shows a tooltip');
  plot.blur();
  plot.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
  await wait(60);
  assert(!q('.usage-tip', plot), 'The tooltip hides on leave');
  const heat = q('.usage-heat');
  heat.focus();
  await until(() => q('.usage-tip', heat), 'The heatmap opens a tooltip on focus');
  heat.blur();

  // range switch
  const seg = [...document.querySelectorAll('.usage-seg [role=tab]')];
  assert(seg.length === 3 && seg[1].getAttribute('aria-selected') === 'true', 'Range switch defaults to 30 days');
  seg[0].click();
  await until(() => document.querySelectorAll('.usage-bar').length === 7, 'The 7-day range draws 7 bars');
  seg[2].click();
  await until(() => document.querySelectorAll('.usage-bar').length > 30, 'All time draws more bars');
  assert(window.__mockBackend.requests.some(r => r.path === '/usage' && r.search === '?range=7d') && window.__mockBackend.requests.some(r => r.path === '/usage' && r.search === '?range=all'), 'Ranges reach the backend');
  const shot = { width: Math.round(body.clientWidth), kpi: [...document.querySelectorAll('.usage-kpi')].map(k => Math.round(k.getBoundingClientRect().width)) };

  // error and empty states
  window.__mockBackend.usageFail = true;
  seg[1].click();
  await until(() => q('.usage-error'), 'A failed load shows an error with a retry');
  window.__mockBackend.usageFail = false;
  click(q('.usage-error .ui-button'));
  await until(() => q('.usage-report') && !q('.usage-error'), 'Retry recovers');
  window.__mockBackend.usageEmpty = true;
  seg[0].click();
  await until(() => q('.usage-empty'), 'No usage shows the empty state');
  window.__mockBackend.usageEmpty = false;
  seg[1].click();
  await until(() => q('.usage-report'), 'Data returns');
  await closeDialog();
  return { theme, ...shot, chip: first };
}
