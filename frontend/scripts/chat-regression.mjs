// Chat UX: find in chat, sidebar lesson states and unread dot, grouped tool calls, progress picture-in-picture.
import { until, wait, navigate } from './ui-regression.mjs';
const assert = (value, message) => { if (!value) throw Error(message); };
const key = (target, k, init = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
const type = (input, value) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

export async function runChatRegression(theme = 'dark') {
  const { updateSettings } = await import('/src/lib/settings.ts');
  updateSettings({ language: 'ru', theme });
  const { getState, mergeSession } = await import('/src/lib/store.ts');
  const { togglePinned, setDone, useLessonMarks } = await import('/src/lib/lesson-state.ts');
  const marks = () => JSON.parse(localStorage.getItem('graphy-lesson-state-v1') ?? '{}');
  await navigate('Матрицы');
  const ID = 'fixture-matrix';
  const original = getState().sessions[ID].blocks;
  const patch = fn => mergeSession(ID, s => fn(s));
  const act = (i, tool, state, extra = {}) => ({ id: `rt-${i}`, kind: 'action', tool, title: tool, detail: `d${i}`, state, ms: 300, ...extra });
  const agent = kind => patch(s => ({ ...s, agent: { kind, label: '', since: Date.now() } }));
  const out = {};

  // ---- find in chat
  patch(s => ({ ...s, blocks: [...original,
    { id: 'rt-u', kind: 'user', text: 'Объясни умножение матриц', attachments: [], at: Date.now() },
    { id: 'rt-t', kind: 'text', text: 'Матрица A умножается на матрицу B строка на столбец.', streaming: false },
    { id: 'rt-r', kind: 'reasoning', text: 'Скрытое рассуждение про Транспонирование', seconds: 3, streaming: false }] }));
  await until(() => document.getElementById('blk-rt-r'), 'Injected blocks render');
  key(window, 'а', { ctrlKey: true, code: 'KeyF' }); // Russian layout: the key is «а», the physical key is F
  await until(() => document.querySelector('.chat-find'), 'Ctrl+F opens the find bar on a Russian layout');
  assert(document.activeElement === document.querySelector('.chat-find-input'), 'The find field takes focus');
  const bar = document.querySelector('.chat-find-input');
  type(bar, 'матриц');
  await until(() => /из/.test(document.querySelector('.chat-find-count').textContent), 'The match counter appears');
  const total = Number(document.querySelector('.chat-find-count').textContent.split('из')[1]);
  assert(total >= 3, `Expected at least 3 matches of «матриц», got ${total}`);
  if (CSS.highlights) assert(CSS.highlights.get('graphy-find')?.size === total, 'All matches are highlighted');
  assert(document.querySelector('.chat-find-count').textContent.startsWith('1 из'), 'Starts at the first match');
  key(bar, 'Enter');
  await until(() => document.querySelector('.chat-find-count').textContent.startsWith('2 из'), 'Enter goes to the next match');
  key(bar, 'Enter', { shiftKey: true });
  await until(() => document.querySelector('.chat-find-count').textContent.startsWith('1 из'), 'Shift+Enter goes back');
  patch(s => ({ ...s, blocks: [...s.blocks, { id: 'rt-k', kind: 'text', text: 'Формула $xyz$ готова', streaming: false }] }));
  await until(() => document.querySelector('#blk-rt-k .katex'), 'A formula renders');
  type(bar, 'xyz');
  await until(() => document.querySelector('.chat-find-count').textContent === '1 из 1', `A formula counts once (got «${document.querySelector('.chat-find-count').textContent}»)`);
  type(bar, 'content_copy');
  await until(() => document.querySelector('.chat-find-count').textContent === 'Нет совпадений', 'Icon ligatures and copy buttons are not searched');
  type(bar, 'Транспонирование');
  const reasoning = () => document.getElementById('blk-rt-r').querySelector('button.trace');
  await until(() => reasoning().getAttribute('aria-expanded') === 'true' && document.querySelector('.chat-find-count').textContent === '1 из 1', 'A folded reasoning row opens for its match');
  document.querySelector('[aria-label="Учитывать регистр"]').click();
  type(bar, 'транспонирование');
  await until(() => document.querySelector('.chat-find-count').textContent === 'Нет совпадений', 'Case toggle narrows the search');
  document.querySelector('[aria-label="Учитывать регистр"]').click();
  agent('thinking');
  key(bar, 'Escape');
  await until(() => !document.querySelector('.chat-find'), 'Esc closes the find bar');
  await wait(150);
  assert(getState().sessions[ID].agent.kind === 'thinking', 'Esc in the find bar must not stop a running agent');
  if (CSS.highlights) assert(!CSS.highlights.has('graphy-find'), 'Highlights are cleared on close');
  agent('idle');
  out.find = { total };

  // ---- grouped tool calls
  patch(s => ({ ...s, blocks: [...s.blocks, ...[act(1, 'read', 'done'), act(2, 'web_search', 'done'), act(3, 'bash', 'done'), act(4, 'web_read', 'error', { output: 'Нет сети' })]] }));
  await until(() => document.querySelector('#blk-rt-1 .tool-group'), 'Consecutive tool calls fold into one group');
  const group = () => document.querySelector('#blk-rt-1 .tool-group');
  assert(group().querySelector('.tool-group-count').textContent === '4', 'The group shows how many calls it holds');
  assert(/1 сбой/.test(group().textContent), 'The group shows failures');
  assert(group().querySelectorAll('.trace-list > div').length === 4, 'A group with a failure shows its original rows');
  group().querySelector('button.trace').click();
  await until(() => !group().querySelector('.trace-list'), 'The learner can fold a group');
  group().querySelector('button.trace').click();
  patch(s => ({ ...s, blocks: [...s.blocks, act(5, 'read', 'running')] }));
  await wait(120);
  assert(group().querySelector('.trace-list') && group().dataset.running !== undefined, 'A running group is open and marked');
  assert(/идёт 1/.test(group().querySelector('button.trace').getAttribute('aria-label')) && /сбой/.test(group().querySelector('button.trace').getAttribute('aria-label')), 'The group label carries running and failed counts');
  patch(s => ({ ...s, blocks: s.blocks.map(b => b.id === 'rt-5' ? { ...b, state: 'done' } : b).filter(b => b.id !== 'rt-4') }));
  await wait(120);
  assert(group().querySelector('.trace-list'), 'An open group does not fold again when it updates');
  const many = Array.from({ length: 40 }, (_, i) => act(100 + i, 'read', i === 39 ? 'running' : 'done'));
  patch(s => ({ ...s, blocks: [...s.blocks.filter(b => !/^rt-\d$/.test(b.id)), ...many] }));
  await until(() => document.querySelector('#blk-rt-100 .tool-group .tool-group-more'), 'A long running group is bounded');
  assert(document.querySelectorAll('#blk-rt-100 .trace-list > div').length === 30, 'The live preview shows 30 entries');
  key(window, 'f', { ctrlKey: true, code: 'KeyF' });
  await until(() => document.querySelector('.chat-find-input'), 'Find reopens');
  type(document.querySelector('.chat-find-input'), 'd100');
  await until(() => /^1 из [12]$/.test(document.querySelector('.chat-find-count').textContent) && document.querySelectorAll('#blk-rt-100 .trace-list > div').length > 30, `A search shows rows beyond the live bound (${document.querySelector('.chat-find-count')?.textContent}, ${document.querySelectorAll('#blk-rt-100 .trace-list > div').length} rows)`);
  key(document.querySelector('.chat-find-input'), 'Escape');
  await until(() => !document.querySelector('.chat-find'), 'Find closes');
  patch(s => ({ ...s, blocks: s.blocks.filter(b => !/^rt-\d{3}$/.test(b.id)) }));
  out.tools = true;

  // ---- progress picture-in-picture
  const wcode = c => `<svg width="100%" viewBox="0 0 100 40" role="img"><title>${c}</title><rect width="100" height="40" fill="${c}"/></svg>`;
  patch(s => ({ ...s, plan: { goal: 'Умножение матриц', steps: ['Размеры', 'Строка на столбец', 'Пример', 'Итог'], current: 1 },
    blocks: [...s.blocks.filter(b => !b.id.startsWith('rt-p')),
      { id: 'rt-p1', kind: 'plan', goal: 'Умножение матриц', steps: ['Размеры', 'Строка на столбец', 'Пример', 'Итог'], current: 0 },
      { id: 'rt-w1', kind: 'widget', title: 'product', code: wcode('tomato') },
      { id: 'rt-p2', kind: 'plan', goal: 'Умножение матриц', steps: ['Размеры', 'Строка на столбец', 'Пример', 'Итог'], current: 1 },
      { id: 'rt-w2', kind: 'widget', title: 'product', code: wcode('seagreen') }] }));
  await until(() => document.querySelector('.progress-pip'), 'The progress pill appears');
  const pip = () => document.querySelector('.progress-pip');
  const isOpen = () => pip().dataset.open !== undefined;
  const pane = pip().parentElement.clientWidth;
  const col = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--col-max')) || 720;
  const expect = pane >= 1000 && (pane - col) / 2 >= 296;
  assert(isOpen() === expect, `Card opens by default only in a wide pane (pane ${pane}px, col ${col}, expected ${expect}, open=${isOpen()})`);
  assert(/\d+ точ\S+ · /.test(pip().textContent) || isOpen(), 'The pill shows checkpoints and age');
  if (!isOpen()) pip().querySelector('.pip-pill').click();
  await until(() => pip().querySelector('.pip-card'), 'The pill expands into a card');
  const tiles = () => [...pip().querySelectorAll('.pip-frame-tile')];
  assert(tiles().length >= 4, `Filmstrip has plan steps and drawings, got ${tiles().length}`);
  assert(/Шаг 2 из 4/.test(pip().textContent), 'The card shows the plan position');
  assert(tiles().at(-1).getAttribute('aria-current') === 'true', 'The newest checkpoint is current');
  pip().querySelector('[aria-label="Предыдущая точка"]').click();
  await wait(60);
  assert(tiles().at(-2).getAttribute('aria-current') === 'true', 'Previous steps back');
  pip().querySelector('[aria-label="Показать по порядку"]').click();
  await until(() => tiles().at(-1).getAttribute('aria-current') === 'true', 'Play advances to the end', 4000);
  await wait(100);
  assert(pip().querySelector('[aria-label="Показать по порядку"]'), 'Play stops at the end');
  const { checkpointsOf } = await import('/src/lib/progress-pip.ts');
  const planBlock = (id, goal, steps, current) => ({ id, kind: 'plan', goal, steps, current });
  const fake = blocks => checkpointsOf({ blocks }).filter(c => c.kind === 'step').length;
  assert(fake([planBlock('a', 'G', ['1', '2'], 1), planBlock('b', 'H', ['1', '2'], 1)]) === 2, 'A new plan starts counting steps again');
  assert(fake([planBlock('a', 'G', ['1', '2'], 2), planBlock('b', 'G', ['1', '2'], 1)]) === 2, 'Progress that goes back is a step again');
  assert(fake([planBlock('a', 'G', ['1', '2'], 1), planBlock('b', 'G', ['1', '2'], 1)]) === 1, 'The same step is not counted twice');
  // dims while typing, comes back
  const composer = document.querySelector('textarea');
  if (composer) { key(composer, 'a'); await wait(60); assert(pip().dataset.dim !== undefined, 'Dims while the learner types'); await wait(1400); assert(pip().dataset.dim === undefined, 'Returns after 1.2 s'); }
  // large view with before/after
  agent('thinking');
  key(window, 'f', { ctrlKey: true, code: 'KeyF' });
  await until(() => document.querySelector('.chat-find'), 'Find opens before the large view');
  pip().querySelector('[aria-label="Крупно"]').click();
  await until(() => document.querySelector('.pip-large'), 'Large view opens');
  assert(document.querySelector('.pip-large').getAttribute('aria-modal') === 'true', 'The large view is modal');
  assert(document.querySelector('.pip-large').contains(document.activeElement), 'Focus moves into the large view');
  key(window, 'f', { ctrlKey: true, code: 'KeyF' });
  assert(document.querySelectorAll('.chat-find').length === 1, 'Ctrl+F does nothing while the large view is open');
  assert(document.querySelector('.pip-compare input[type=range]'), 'Two drawings of one visual show a before/after slider');
  assert([...document.querySelectorAll('.pip-large iframe')].every(f => f.getAttribute('sandbox') === 'allow-scripts'), 'Drawings stay sandboxed');
  const title = () => document.querySelector('.pip-large-title').textContent;
  const first = title();
  key(window, 'ArrowLeft');
  await wait(60);
  assert(title() !== first, 'Arrow keys step through the large view');
  key(window, 'Escape');
  await until(() => !document.querySelector('.pip-large'), 'Esc closes the large view');
  assert(document.querySelector('.chat-find'), 'The first Esc closes only the topmost layer (the large view)');
  assert(getState().sessions[ID].agent.kind === 'thinking', 'Esc that closes the large view must not stop the agent');
  key(window, 'Escape');
  await until(() => !document.querySelector('.chat-find'), 'The second Esc closes the find bar');
  await wait(100);
  assert(getState().sessions[ID].agent.kind === 'thinking', 'Esc that closes the find bar must not stop the agent');
  agent('idle');
  out.pip = { pane, opened: expect };

  // ---- sidebar states and unread
  const openRow = async id => { document.querySelector(`nav[data-sidebar] md-list-item[data-lesson-id="${id}"]`).click(); await until(() => getState().activeId === id && getState().sessions[id].loaded, `Open ${id}`); };
  const section = name => document.querySelector(`nav[data-sidebar] [data-state-section="${name}"]`);
  const rowIn = (sec, title) => [...(sec?.querySelectorAll('md-list-item') ?? [])].find(e => e.querySelector('[slot=headline]')?.textContent.includes(title));
  patch(s => ({ ...s, title: 'Матрицы' }));
  togglePinned(ID);
  await until(() => rowIn(section('pinned'), 'Матрицы'), 'A pinned lesson moves to «Закреплённые»');
  assert(section('pinned').getAttribute('aria-label') === 'Закреплённые', 'Pinned section is labelled');
  togglePinned(ID);
  await until(() => !section('pinned'), 'Unpinning removes the section');
  await openRow('fixture-det');
  await until(() => rowIn(section('active'), 'Определитель'), 'A lesson that waits for a test is under «Идёт»');
  const { parseSaved } = await import('/src/lib/lesson-state.ts');
  for (const raw of ['{{', 'null', '[]', '7', '{"pinned":"x","done":[1],"unread":[1,{},"ok"]}', '{"pinned":[null,"p"],"done":{"a":"yes","b":true},"unread":{}}']) {
    const v = parseSaved(raw);
    assert(Array.isArray(v.pinned) && Array.isArray(v.unread) && v.done && typeof v.done === 'object' && !Array.isArray(v.done), `Garbage storage «${raw}» yields a valid shape`);
    assert(v.pinned.every(x => typeof x === 'string') && v.unread.every(x => typeof x === 'string') && Object.values(v.done).every(x => typeof x === 'boolean'), `Garbage storage «${raw}» keeps only well-formed entries`);
  }
  assert(parseSaved('{"pinned":[null,"p"],"done":{"a":"yes","b":true},"unread":{}}').pinned.join() === 'p', 'Valid entries survive');
  localStorage.setItem('graphy-lesson-state-v1', '{"pinned":5,"done":"x","unread":[{}]}');
  // aborted runs are not «unread»
  agent('writing'); await wait(60); patch(s => ({ ...s, agent: { kind: 'stopped', label: '', since: Date.now() } })); await wait(120);
  assert(!marks().unread?.includes(ID), 'A stopped run does not make a lesson unread');
  patch(s => ({ ...s, agent: { kind: 'error', label: '', since: Date.now() } })); agent('writing'); await wait(60);
  patch(s => ({ ...s, agent: { kind: 'error', label: '', since: Date.now() } })); await wait(120);
  assert(!marks().unread?.includes(ID), 'A failed run does not make a lesson unread');
  // dead lessons are forgotten
  togglePinned('ghost-lesson'); setDone('ghost-lesson', true);
  patch(s => ({ ...s, updatedAt: s.updatedAt + 1 })); await wait(100);
  assert(!marks().pinned?.includes('ghost-lesson') && !('ghost-lesson' in (marks().done ?? {})), 'Marks of deleted lessons are pruned');
  // a reply ends while another lesson is open: unread dot, cleared by opening
  agent('writing'); await wait(60); agent('idle'); await wait(120);
  assert(marks().unread?.includes(ID), 'A reply that ended in a closed lesson is remembered as unread');
  const matrixRow = () => [...document.querySelectorAll('nav[data-sidebar] md-list-item')].find(e => e.dataset.lessonId === ID);
  assert(matrixRow()?.dataset.unread !== undefined && matrixRow().querySelector('.unread-dot'), 'The row shows an unread dot');
  await openRow(ID);
  await until(() => !marks().unread?.includes(ID), 'Opening the lesson clears unread');
  // mark finished and reopen
  setDone(ID, true);
  await until(() => section('finished'), 'A finished lesson goes to «Завершённые»');
  assert(!rowIn(section('finished'), 'Матрицы'), 'The finished section starts folded');
  section('finished').querySelector('.state-section-head').click();
  await until(() => rowIn(section('finished'), 'Матрицы'), 'The finished section unfolds');
  setDone(ID, false);
  await until(() => !section('finished'), 'Reopening returns the lesson to «Недавние»');
  const menu = matrixRow().querySelector('[aria-haspopup=menu]');
  assert(menu, 'Row menu is present');
  out.sidebar = true;

  // ?keep=1 leaves a populated lesson on screen for looking at it
  if (new URLSearchParams(location.search).has('keep')) {
    const w = c => `<svg width="100%" viewBox="0 0 100 40"><rect width="100" height="40" fill="${c}"/><circle cx="50" cy="20" r="12" fill="white"/></svg>`;
    const steps = ['Размеры', 'Строка на столбец', 'Пример', 'Итог'];
    patch(s => ({ ...s, agent: { kind: 'tool', label: '', since: Date.now() }, plan: { goal: 'Умножение матриц', steps, current: 1 }, blocks: [
      { id: 'su', kind: 'user', text: 'Объясни умножение матриц', attachments: [], at: Date.now() },
      { id: 'sp1', kind: 'plan', goal: 'Умножение матриц', steps, current: 1 },
      { id: 'st', kind: 'text', text: 'Матрица A умножается на матрицу B строка на столбец.', streaming: false },
      act(1, 'read', 'done'), act(2, 'web_search', 'done'), act(3, 'bash', 'error', { output: 'нет' }), act(4, 'web_read', 'running'),
      { id: 'sw1', kind: 'widget', title: 'p', code: w('tomato') }, { id: 'sw2', kind: 'widget', title: 'p', code: w('seagreen') }] }));
    togglePinned(ID);
    await wait(500);
    key(window, 'f', { ctrlKey: true });
    await wait(200);
    type(document.querySelector('.chat-find-input'), 'матриц');
    if (!document.querySelector('.pip-card')) document.querySelector('.pip-pill')?.click();
    await wait(500);
    if (new URLSearchParams(location.search).get('keep') === 'large') { document.querySelector('[aria-label="Крупно"]')?.click(); await wait(500); }
    return out;
  }
  // restore
  patch(s => ({ ...s, blocks: original, plan: undefined }));
  localStorage.removeItem('graphy-lesson-state-v1');
  return out;
}
