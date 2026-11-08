import { uiScale, viewportWidth } from '/src/lib/layout.ts';
// Uses HTTP snapshots and streamed wire events from mock-backend.mjs.
import { click, wait, until, navigate, closeDialog } from './ui-regression.mjs';
const assert = (value, message) => { if (!value) throw Error(message); };
const rect = element => Object.fromEntries(Object.entries(element.getBoundingClientRect().toJSON()).map(([key, value]) => [key, value / uiScale()]));
const control = label => [...document.querySelectorAll('.ui-icon-button')].find(e => e.getAttribute('aria-label') === label);
export async function runPanelRegression(theme = 'dark') {
  assert(window.__mockBackend, 'Fixture backend is required');
  await closeDialog();
  const { updateSettings } = await import('/src/lib/settings.ts');
  const { getState, patchSession } = await import('/src/lib/store.ts');
  updateSettings({ theme, language: 'ru' });
  await navigate('Матрицы');
  const draft = 'Длинный черновик с переносами при открытии панели. '.repeat(12);
  patchSession('fixture-matrix', s => ({ ...s, draft }));
  await wait(100);
  const main = document.querySelector('main'), panel = document.querySelector('[data-lesson-panel]');
  assert(panel && panel.dataset.mode === 'rail', 'The rail is always on in a lesson');
  assert(main.contains(panel) && document.querySelector('.lesson-body').contains(panel) && !document.querySelector('.lesson-panel-dock'), 'The rail lives inside the chat container, without a dock');
  assert(getState().sessions['fixture-matrix'].draft === draft, 'Panel lost the draft');
  assert(!control('Скрыть панель') && !control('Показать панель') && !control('Открыть холст') && !control('Скрыть холст'), 'No show/hide toggle exists');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true })); await wait(260);
  assert(document.querySelector('[data-lesson-panel]') === panel && document.body.contains(panel), 'Ctrl+B no longer toggles a panel');
  const chat = document.querySelector('.lesson-chat');
  if (viewportWidth() >= 900) {
    const r = rect(panel), c = rect(chat);
    assert(Math.abs(r.width - 300) < 1, `Rail is 300px wide: ${r.width}`);
    assert(Math.abs(c.right - r.left) < 1 && Math.abs(r.top - c.top) < 1 && Math.abs(r.height - c.height) < 1, 'The rail sits beside the chat column and spans its height');
    const st = getComputedStyle(panel), rs = getComputedStyle(panel.querySelector('.rail'));
    assert(st.backgroundColor === 'rgba(0, 0, 0, 0)' && st.borderLeftWidth === '0px' && st.boxShadow === 'none' && rs.backgroundColor === 'rgba(0, 0, 0, 0)', 'The rail has no background, border or shadow');
  }
  assert(!document.querySelector('[data-lesson-panel] [role=tab], [data-lesson-panel] [role=tablist]') && !/Результат/.test(panel.textContent), 'The Result tab must be gone');
  const cards = [...panel.querySelectorAll('[data-rail-card]')].map(c => c.dataset.railCard);
  assert(cards.length > 0 && cards.every(c => ['plan', 'materials', 'context'].includes(c)) && !cards.includes('canvas') && !/Холст/.test(panel.textContent), `Rail cards: ${cards}`);
  assert(!document.querySelector('[data-pf-viewer]'), 'The file viewer is hidden when nothing was presented');
  for (const title of panel.querySelectorAll('.rail-card-title')) {
    const body = document.getElementById(title.getAttribute('aria-controls'));
    assert(title.getAttribute('aria-expanded') === 'true' && !body.hidden, 'Cards start expanded');
    click(title); await wait(50);
    assert(title.getAttribute('aria-expanded') === 'false' && body.hidden, 'A card title collapses its card');
    click(title); await wait(50);
    assert(title.getAttribute('aria-expanded') === 'true' && !body.hidden, 'A card title expands its card');
  }
  const rail = panel.querySelector('.rail');
  assert(rail.scrollWidth <= rail.clientWidth + 1, 'Rail overflows');
  // a fresh lesson without plan, files or context shows no rail at all
  const saved = getState().sessions['fixture-matrix'];
  patchSession('fixture-matrix', s => ({ ...s, plan: undefined, context: undefined }));
  await wait(100);
  assert(!document.querySelector('[data-rail-card="plan"]') && !document.querySelector('[data-rail-card="context"]'), 'Cards without content are hidden');
  const left = [...document.querySelectorAll('[data-rail-card]')].length;
  patchSession('fixture-matrix', s => ({ ...s, blocks: s.blocks.map(b => b.kind === 'user' ? { ...b, attachments: [] } : b) }));
  await wait(450);
  assert(left >= 0 && !document.querySelector('[data-lesson-panel]'), 'A lesson with nothing to show has no rail');
  patchSession('fixture-matrix', s => ({ ...s, plan: saved.plan, context: saved.context, blocks: saved.blocks }));
  await wait(100);
  patchSession('fixture-matrix', s => ({ ...s, draft: '' }));
  await navigate('Определитель');
  const steps = [...document.querySelectorAll('.question-step')];
  assert(steps.length === 5, 'Question navigation is incomplete');
  assert(!document.body.textContent.includes('ответы отправятся одним блоком') && !document.body.textContent.includes('Alt+←/→'), 'Removed quiz captions remain');
  const circles = steps.map(e => ({ number: e.textContent.trim(), ...rect(e) }));
  assert(circles.every(r => Math.abs(r.width - 28) < .5 && Math.abs(r.height - 28) < .5), 'Question numbers are not compact circles');
  click(steps[2]); await wait();
  assert(getState().sessions['fixture-det'].blocks.find(b => b.kind === 'question').step === 2, 'Round question control does not navigate');
  click(document.querySelector('.question-step')); await wait();
  await until(() => window.__mockBackend.requests.some(r => r.method === 'PUT' && r.path.endsWith('/draft') && r.body.step === 2), 'Question step saved through HTTP');
  await navigate('Матрицы');
  window.__mockBackend.emitTools();
  await until(() => getState().sessions['fixture-matrix'].blocks.filter(b => b.kind === 'action').length === 4, 'Streamed tool events');
  await wait();
  const group = [...document.querySelectorAll('button.trace')].find(e => e.textContent.includes('искал в сети'));
  click(group); await wait();
  if (group.getAttribute('aria-expanded') !== 'true') { click(group); await wait(); }
  const toolRows = group.closest('.tool-group').querySelectorAll('.trace-list > *').length;
  assert(toolRows === 4, 'All four streamed actions remain available in the expanded group');
  assert(document.documentElement.scrollWidth <= innerWidth, 'Page horizontal overflow');
  assert(window.__mockBackend.unexpected.length === 0, `Unexpected requests: ${window.__mockBackend.unexpected.join(', ')}`);
  return { theme, viewport: [innerWidth, innerHeight], circles, toolRows, pass: true };
}
