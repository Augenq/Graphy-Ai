// Input surface: sanitizers (script, handlers, javascript: URLs, foreignObject, style exfiltration), charts,
// the queue inside the composer, the "+" menu and limits, the sketch editor, the command palette, rich questions.
import { until, wait, navigate, click, closeDialog } from './ui-regression.mjs';
const assert = (value, message) => { if (!value) throw Error(message); };
const q = (selector, root = document) => root.querySelector(selector);

export async function runInputRegression(theme = 'dark') {
  const { updateSettings } = await import('/src/lib/settings.ts');
  updateSettings({ language: 'ru', theme });
  await closeDialog();
  const results = [];

  // ---------------------------------------------------------------- sanitizers
  const { sanitizeSvg, sanitizeHtml, sanitizeCss, svgDataUrl } = await import('/src/lib/sanitize.ts');
  const svgIn = body => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`;
  const bad = /<script|onload|onclick|onerror|javascript:|foreignObject|<image|<use|<a[ >]|<style|url\(\s*https?:|url\(\s*data:|href=|<iframe|@import/i;
  const svgAttacks = [
    '<script>alert(1)</script><rect width="5" height="5"/>',
    '<rect width="5" height="5" onclick="alert(1)" onmouseover="x()"/>',
    '<g onload="alert(1)"><circle r="2"/></g>',
    '<a href="javascript:alert(1)"><text>x</text></a>',
    '<foreignObject width="10" height="10"><iframe src="https://evil.example"></iframe><div xmlns="http://www.w3.org/1999/xhtml" onclick="x()">hi</div></foreignObject>',
    '<rect width="5" height="5" fill="url(https://evil.example/p.svg#a)"/>',
    '<rect width="5" height="5" style="fill:url(https://evil.example/x)"/>',
    '<style>@import url(https://evil.example/x.css); rect{fill:url(https://evil.example/y)}</style><rect width="5" height="5"/>',
    '<image href="https://evil.example/pixel.png" width="5" height="5"/>',
    '<use href="https://evil.example/sprite.svg#a"/>',
    '<set attributeName="href" to="javascript:alert(1)"/><animate attributeName="fill" values="url(https://evil.example)"/>',
    '<text x="1" y="1" fill="javascript:alert(1)">t</text>',
    '<rect width="5" height="5" fill="url(&#106;avascript:alert(1))"/>',
  ];
  for (const attack of svgAttacks) {
    const out = sanitizeSvg(svgIn(attack));
    assert(out !== null, `A valid svg with a bad part still renders its safe part: ${attack.slice(0, 40)}`);
    assert(!bad.test(out), `SVG sanitizer let through: ${attack.slice(0, 50)} -> ${out}`);
  }
  assert(sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect/>') === null, 'Broken XML is refused');
  assert(sanitizeSvg('<div>not svg</div>') === null, 'A non-svg document is refused');
  const keepSvg = sanitizeSvg(svgIn('<g><rect x="1" y="1" width="4" height="4" fill="#d55e00" stroke="currentColor"/><text x="1" y="9">Привет</text><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient><circle r="2" fill="url(#g)"/></g>'));
  assert(keepSvg.includes('<rect') && keepSvg.includes('Привет') && keepSvg.includes('url(#g)'), 'Safe svg content survives');
  assert(svgDataUrl(keepSvg).startsWith('data:image/svg+xml'), 'Svg is shown as an image');

  const htmlBad = /<script|<style|<iframe|<object|<embed|<form|<input|<link|<meta|<svg|<math|javascript:|\son\w+\s*=|url\(|@import|src="https?:|href="javascript/i;
  const htmlAttacks = [
    '<script>alert(1)</script><p>ok</p>',
    '<p onclick="alert(1)" onmouseover=alert(1)>hi</p>',
    '<img src="https://evil.example/p.png" onerror="alert(1)">',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">x</a><a href="JaVaScRiPt:alert(1)">y</a><a href="  javascript:alert(1)">z</a>',
    '<a href="data:text/html,<script>alert(1)</script>">d</a>',
    '<iframe src="https://evil.example"></iframe><object data="x"></object><embed src="x">',
    '<style>@import url(https://evil.example/a.css); p{background:url(https://evil.example/b.png)}</style><p>s</p>',
    '<p style="background:url(https://evil.example/leak?c=1)">a</p><p style="color:red;background-image:url(//e.example/x)">b</p>',
    '<p style="width:expression(alert(1));color:red">c</p>',
    '<p style="color:\\72 ed; background:\\75 rl(https://evil.example)">e</p>',
    '<svg><script>alert(1)</script><foreignObject><div onclick="x()">x</div></foreignObject></svg>',
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
    '<form action="https://evil.example"><input name="q"><button>go</button></form>',
    '<link rel="stylesheet" href="https://evil.example/x.css"><meta http-equiv="refresh" content="0;url=https://evil.example">',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
    '<template><script>alert(1)</script></template>',
    '<p title="x" id="grab" class="y" data-x="1" onfocus=x()>attrs</p>',
  ];
  for (const attack of htmlAttacks) {
    const out = sanitizeHtml(attack);
    assert(!htmlBad.test(out), `HTML sanitizer let through: ${attack.slice(0, 60)} -> ${out}`);
    const doc = new DOMParser().parseFromString(out, 'text/html');
    assert(![...doc.querySelectorAll('*')].some(el => [...el.attributes].some(a => a.name.startsWith('on'))), `An event handler survived: ${attack.slice(0, 50)}`);
  }
  assert(sanitizeCss('color: red; background: url(https://e.example/x); width: expression(1); position: fixed; display: block') === 'color: red; display: block', 'CSS keeps only safe properties and values');
  const okHtml = sanitizeHtml('<h3>Тест</h3><table><tr><th>a</th><td style="color:#d55e00">1</td></tr></table><a href="https://example.org">link</a><img src="https://e.example/x.png" alt="pic"><ul><li>x</li></ul>');
  assert(okHtml.includes('<table>') && okHtml.includes('color: #d55e00') && okHtml.includes('rel="noopener noreferrer nofollow"') && !okHtml.includes('<img'), 'Safe html survives; a remote image is replaced by its alt text');
  assert(okHtml.includes('[pic]'), 'The alt text of a refused image stays');
  results.push({ check: 'Sanitizers: 13 svg and 18 html attacks neutralised, safe content kept', pass: true });

  // ---------------------------------------------------------------- charts and images
  const rm = await import('/src/lib/rich-markdown.ts');
  const good = rm.parseChart('{"type":"bar","title":"Оценки <b>","unit":"б","data":[{"label":"A","value":3},{"label":"B","value":5.5}]}');
  assert(good.spec && good.spec.series[0].values[1] === 5.5, 'A bar chart parses');
  for (const [src, why] of [
    ['{"type":"bar"', 'broken JSON'], ['[]', 'array'], ['{"type":"radar","data":[{"label":"a","value":1}]}', 'unknown type'],
    ['{"type":"bar","data":[{"label":"a","value":"1"}]}', 'string value'], ['{"type":"bar","data":[]}', 'no points'],
    [JSON.stringify({ type: 'bar', data: Array.from({ length: 25 }, (_, i) => ({ label: String(i), value: i })) }), 'too many points'],
    ['{"type":"pie","data":[{"label":"a","value":-1}]}', 'negative pie'], ['{"type":"pie","data":[{"label":"a","value":0}]}', 'zero pie'],
    ['{"type":"line","labels":["a","b"],"series":[{"name":"s","values":[1]}]}', 'length mismatch'],
    ['{"type":"line","labels":["a"],"series":[{"name":"s","values":[1e30]}]}', 'huge number'],
  ]) assert('error' in rm.parseChart(src), `Chart is refused: ${why}`);
  const svg = rm.chartSvg(good.spec);
  assert(svg.includes('role="img"') && svg.includes('aria-label') && !svg.includes('<b>') && svg.includes('&lt;b&gt;'), 'Chart svg is accessible and labels are escaped');
  assert(!/<script|onclick|href=/i.test(svg), 'Chart svg carries no script');
  const line = rm.chartSvg(rm.parseChart('{"type":"line","labels":["1","2","3"],"series":[{"name":"x","values":[1,3,2]},{"name":"y","values":[2,2,2]}]}').spec);
  const pie = rm.chartSvg(rm.parseChart('{"type":"pie","data":[{"label":"a","value":1},{"label":"b","value":3}]}').spec);
  assert(line.includes('<polyline') && pie.includes('<path') && pie.includes('75%'), 'Line and pie charts draw');
  assert(rm.niceAxis(0, 930).hi >= 930 && rm.niceAxis(-3, 4).lo <= -3, 'Axis covers the data');
  assert(rm.classifyImage('https://e.example/a.png').kind === 'remote' && rm.classifyImage('//e.example/a.png').kind === 'blocked'
    && rm.classifyImage('javascript:alert(1)').kind === 'blocked' && rm.classifyImage('../secret.png').kind === 'blocked' && rm.classifyImage('file:///etc/passwd').kind === 'blocked'
    && rm.classifyImage('fig/a.png').kind === 'workspace' && rm.classifyImage('data:image/png;base64,AAAA').kind === 'data' && rm.classifyImage('data:image/svg+xml;base64,AAAA').kind === 'blocked', 'Images are classified; remote ones are never loaded');
  results.push({ check: 'Charts validate, draw and escape; image sources classified', pass: true });

  // ---------------------------------------------------------------- pure helpers
  const cmd = await import('/src/lib/commands.ts');
  assert(cmd.fuzzyScore('нзан', 'Новое занятие') !== null && cmd.fuzzyScore('xyz', 'Новое занятие') === null, 'Fuzzy match is a subsequence match');
  assert(cmd.fuzzyScore('тем', 'Включить тёмную тему') > cmd.fuzzyScore('тем', 'Настройки: Использование') ?? -1e9, 'A word-start hit ranks first');
  assert(cmd.matchScore('theme', 'Включить тёмную тему', 'theme тема') !== null, 'Extra words find an action');
  const { applyQueueOp } = await import('/src/lib/queue.ts');
  const Q = [{ text: 'a', followup: false }, { text: 'b', followup: true }, { text: 'c', followup: true }];
  assert(applyQueueOp(Q, { kind: 'move', index: 1, by: 1 }).queue.map(m => m.text).join('') === 'acb' && applyQueueOp(Q, { kind: 'move', index: 0, by: -1 }) === null, 'Reorder swaps and stops at the ends');
  assert(applyQueueOp(Q, { kind: 'remove', index: 0 }).queue.length === 2 && applyQueueOp(Q, { kind: 'edit', index: 2 }).draft === 'c', 'Remove and edit');
  const steered = applyQueueOp(Q, { kind: 'steer', index: 2 }).queue;
  assert(steered[0].text === 'c' && steered[0].followup === false && applyQueueOp(Q, { kind: 'steer', index: 0 }) === null, 'Send now makes a follow-up a steering message, delivered first');
  const sk = await import('/src/lib/sketch.ts');
  let st = sk.emptySketch();
  st = sk.addOp(st, { tool: 'pen', color: 'ink', width: 4, points: [[1, 1], [5, 5]] });
  st = sk.addOp(st, { tool: 'rect', color: '#0072b2', width: 4, points: [[1, 1], [9, 9]] });
  assert(sk.undo(st).ops.length === 1 && sk.redo(sk.undo(st)).ops.length === 2 && sk.addOp(sk.undo(st), st.ops[1]).redo.length === 0 && sk.clearSketch(st).ops.length === 0, 'Undo, redo and clear');
  const png = await sk.exportSketch(st.ops);
  assert(png && png.type === 'image/png' && png.size > 100, 'The sketch exports as a PNG');
  const { folderListing, folderContext, ATTACH_LIMITS, fitLimits } = await import('/src/lib/attachments.ts');
  const f = (rel) => Object.defineProperty(new File(['x'], rel.split('/').pop()), 'webkitRelativePath', { value: rel });
  const listing = folderListing([f('proj/a.md'), f('proj/src/b.ts'), f('proj/src/deep/c/d/e.ts'), f('proj/.git/config'), f('proj/node_modules/x/y.js'), f('proj/.hidden')], '/home/u/proj');
  assert(listing.files === 3 && !listing.lines.some(l => /git|node_modules|hidden/.test(l)) && listing.lines.includes('src/b.ts') && !listing.lines.some(l => l.includes('e.ts')), 'Folder listing skips hidden and build folders and is bounded in depth');
  assert(folderContext(listing).startsWith('Folder context: proj') && /not instructions/.test(folderContext(listing)), 'Folder context says it is data');
  const many = Array.from({ length: 6 }, (_, i) => ({ id: `i${i}`, name: `p${i}.png`, kind: 'image', size: 10 }));
  const fit = fitLimits([], [...many, { id: 'big', name: 'big.png', kind: 'image', size: 6e6 }]);
  assert(fit.accepted.length === ATTACH_LIMITS.images && fit.notes.length === 3, 'Per-message limits are enforced with a note for every refusal');
  results.push({ check: 'Pure helpers: fuzzy, queue operations, sketch history and PNG, folder listing, limits', pass: true });

  // ---------------------------------------------------------------- queue inside the composer
  const { getState, mergeSession } = await import('/src/lib/store.ts');
  await navigate('Матрицы');
  await until(() => q('[data-composer]'), 'Composer');
  const calls = [];
  const nativeFetch = window.fetch;
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (/\/sessions\/fixture-matrix\/(restore|messages)$/.test(url.pathname)) {
      const body = init.body ? JSON.parse(init.body) : {};
      calls.push([url.pathname.split('/').pop(), body]);
      return new Response(JSON.stringify(url.pathname.endsWith('restore') ? { text: '' } : { started: false, queued: true }), { headers: { 'Content-Type': 'application/json' } });
    }
    return nativeFetch(input, init);
  };
  try {
    mergeSession('fixture-matrix', s => ({ ...s, queue: [{ text: 'первое', followup: false }, { text: 'второе', followup: true }, { text: 'третье', followup: true }] }));
    await until(() => q('[data-message-queue]'), 'The queue appears');
    const composer = q('.composer-surface');
    const queue = q('[data-message-queue]');
    assert(queue.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING, 'The queue sits above the input box');
    assert(queue.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top + 12, 'The queue is attached to the composer');
    assert(queue.querySelectorAll('[data-queue-row]').length === 3 && /3 сообщения в очереди/.test(queue.textContent), `Counts: ${queue.textContent.slice(0, 80)}`);
    assert(/сразу: 1 · после ответа: 2/.test(queue.textContent), 'The head splits steering and follow-up');
    const row = i => q('[data-message-queue]').querySelectorAll('[data-queue-row]')[i];
    const btn = (r, label) => [...r.querySelectorAll('button.ui-icon-button')].find(b => b.title === label);
    assert(row(0).querySelector('button.ui-icon-button[title="Выше"]').disabled && !btn(row(0), 'Отправить сейчас'), 'The first row cannot go up; a steering message has no "send now"');
    assert(row(0).tabIndex === 0 && row(0).getAttribute('aria-label').startsWith('1 из 3'), 'Rows are focusable and labelled');
    // "send now" on the last follow-up
    click(btn(row(2), 'Отправить сейчас'));
    await until(() => calls.length === 4, 'Send now: restore, then three messages');
    assert(calls[0][0] === 'restore' && calls.slice(1).map(c => c[1].text).join(',') === 'третье,первое,второе' && calls[1][1].followup === false && calls[3][1].followup === true, `Send now re-posts the list with the message first: ${JSON.stringify(calls)}`);
    // the fixture backend emits no `queued` events: play them back
    const echo = () => { mergeSession('fixture-matrix', x => ({ ...x, queue: calls.filter(c => c[0] === 'messages').map(c => ({ text: c[1].text, followup: c[1].followup })) })); calls.length = 0; };
    echo();
    await until(() => q('[data-queue-row]')?.textContent.includes('третье'), 'Queue shows the new order');
    // reorder with the keyboard
    row(1).focus();
    row(1).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
    await until(() => calls.length === 4, 'Alt+Down reorders');
    assert(calls.slice(1).map(c => c[1].text).join(',') === 'третье,второе,первое', 'Alt+ArrowDown moves the row down');
    echo();
    await wait(200);
    // edit puts the text in the editor
    click(btn(row(1), 'Править в редакторе'));
    await until(() => getState().sessions['fixture-matrix'].draft.includes('второе'), 'Edit moves the text to the editor');
    assert(calls.slice(1).map(c => c[1].text).join(',') === 'третье,первое', 'The others are re-posted without it');
    mergeSession('fixture-matrix', s => ({ ...s, draft: '', queue: [] }));
    await until(() => !q('[data-message-queue]'), 'An empty queue disappears');
    results.push({ check: 'Queue: inside the composer, counts, send now, keyboard reorder, edit', pass: true });
  } finally { window.fetch = nativeFetch; }

  // ---------------------------------------------------------------- "+" menu, limits, sketch
  const { setRemote } = await import('/src/lib/remote.ts');
  const { patchSession } = await import('/src/lib/store.ts');
  const m0 = getState().sessions['fixture-matrix'];
  const attach = q('button.ui-icon-button[data-attach]');
  assert(attach, 'The + button exists');
  attach.click();
  await wait(300);
  const menu = document.querySelector('.ui-menu-content');
  const items = () => [...document.querySelectorAll('.ui-menu-content [role=menuitem]')];
  const names = () => items().map(i => i.querySelector('.ui-menu-title').textContent);
  const closeMenu = () => document.querySelector('.ui-menu-content')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert(['Файл или фото…', 'Папка…', 'Материалы из чатов…', 'Набросок…'].every(n => names().includes(n)), `Menu entries: ${names()}`);
  assert(/До 4 изображений, 5 документов и 3 папок/.test(attach.closest('.ui-menu-anchor').textContent), 'The menu states the limits');
  const sketchItem = () => items().find(i => i.querySelector('.ui-menu-title').textContent === 'Набросок…');
  assert(sketchItem().getAttribute('aria-disabled') === 'true' && /не принимает изображения/.test(sketchItem().textContent), 'Without vision the sketch is disabled and says why');
  closeMenu();
  await wait(200);
  // materials: files from other chats
  patchSession('fixture-det', s => ({ ...s, blocks: [...s.blocks, { id: 'u-att', kind: 'user', text: 'файл', at: 1, attachments: [{ id: 'a1', name: 'notes.md', kind: 'file', size: 2048, path: '/fixture/notes.md' }] }] }));
  attach.click();
  await wait(300);
  items().find(i => i.querySelector('.ui-menu-title').textContent === 'Материалы из чатов…').click();
  await until(() => q('.materials-dialog'), 'The materials dialog opens');
  const mat = q('.materials-dialog');
  assert(/notes\.md/.test(mat.textContent), 'It lists files from other chats');
  click(mat.querySelector('.materials-row'));
  await until(() => getState().sessions['fixture-matrix'].chips.some(c => c.path === '/fixture/notes.md'), 'Picking a material adds a chip');
  await until(() => q('.composer .ui-chip, .ui-chip'), 'The chip is drawn');
  await closeDialog();
  patchSession('fixture-matrix', s => ({ ...s, chips: [] }));
  // the browser sketch editor (HTTP upload fixture; model with vision)
  const models = [{ id: 'fixture/model', provider: 'fixture', name: 'Fixture model', context: 128000, vision: true, tools: true, reasoning: true, thinking_levels: ['off', 'low', 'high'], metadata_estimated: false }];
  const oldModels = (await import('/src/lib/remote.ts')).getRemote().models;
  setRemote({ models });
  window.__uploadedBytes = 0;
  try {
    attach.click();
    await wait(300);
    assert(sketchItem().getAttribute('aria-disabled') !== 'true', 'With a vision model the browser sketch is enabled');
    sketchItem().click();
    await until(() => q('[data-sketch]'), 'The sketch dialog opens');
    await wait(300);
    const sketch = q('[data-sketch]');
    const canvas = q('canvas', sketch);
    const box = canvas.getBoundingClientRect();
    assert(box.width > 300 && box.height > 150 && box.right <= innerWidth + 1, 'The canvas fits the window');
    const pointer = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { clientX: box.left + x * box.width, clientY: box.top + y * box.height, button: 0, pointerId: 1, bubbles: true }));
    const attachBtn = q('[data-sketch-attach]');
    assert(attachBtn.disabled, 'An empty sketch cannot be attached');
    canvas.setPointerCapture = () => {};
    pointer('pointerdown', 0.1, 0.1); pointer('pointermove', 0.4, 0.5); pointer('pointermove', 0.6, 0.2); pointer('pointerup', 0.6, 0.2);
    sketch.querySelector('[data-tool=rect]').click(); await wait(60);
    pointer('pointerdown', 0.2, 0.6); pointer('pointermove', 0.7, 0.9); pointer('pointerup', 0.7, 0.9);
    sketch.querySelector('[data-tool=arrow]').click(); await wait(60);
    pointer('pointerdown', 0.1, 0.9); pointer('pointermove', 0.5, 0.95); pointer('pointerup', 0.5, 0.95);
    await wait(100);
    const ctx = canvas.getContext('2d');
    const ink = () => { const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - d[0]) > 40 || Math.abs(d[i + 1] - d[1]) > 40) n++; return n; };
    assert(ink() > 2000, 'Strokes are drawn on the canvas');
    const dark = document.documentElement.dataset.theme === 'dark';
    const bg = ctx.getImageData(2, 2, 1, 1).data;
    assert(dark ? bg[0] < 60 : bg[0] > 200, `The canvas background follows the ${theme} theme (${[...bg]})`);
    const fullInk = ink();
    sketch.querySelector('[data-undo]').click(); await wait(200);
    const afterUndo = ink();
    sketch.querySelector('[data-redo]').click(); await wait(200);
    const afterRedo = ink(); assert(afterRedo > afterUndo, `Undo/redo ink: full ${fullInk}, undo ${afterUndo}, redo ${afterRedo}: Undo removes the last shape and redo brings it back`);
    sketch.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); await wait(80);
    assert(ink() === afterUndo, 'Ctrl+Z undoes');
    sketch.querySelector('[data-clear]').click(); await until(() => ink() === 0, `Clear empties the canvas (ink ${ink()}, ops disabled ${attachBtn.disabled})`, 1500);
    assert(ink() === 0 && attachBtn.disabled, `Clear empties the canvas (ink ${ink()}, disabled ${attachBtn.disabled})`);
    sketch.querySelector('[data-tool=pen]').click(); await wait(60);
    pointer('pointerdown', 0.2, 0.2); pointer('pointermove', 0.8, 0.8); pointer('pointerup', 0.8, 0.8);
    await wait(80);
    attachBtn.click();
    await until(() => getState().sessions['fixture-matrix'].chips.some(c => c.kind === 'image' && c.path === '/fixture/uploads/sketch.png'), 'The sketch becomes an image chip');
    assert(window.__uploadedBytes > 200, `PNG bytes were uploaded (${window.__uploadedBytes})`);
    await until(() => !q('[data-sketch]'), 'The dialog closes');
    patchSession('fixture-matrix', s => ({ ...s, chips: [] }));
    results.push({ check: 'Menu entries and limits, earlier materials, sketch: tools, undo/redo, theme-aware canvas, PNG attached', pass: true });
  } catch (e) { window.__sketchFail = true; throw e; } finally { if (!window.__sketchFail) { setRemote({ models: oldModels }); await closeDialog(); } }

  // ---------------------------------------------------------------- command palette
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  await until(() => q('.palette-results'), 'The palette opens');
  const optionTexts = () => [...document.querySelectorAll('.palette-results [role=option]')].map(o => o.textContent);
  const sections = () => [...document.querySelectorAll('.palette-section')].map(s => s.textContent);
  assert(sections().includes('Занятия') && sections().includes('Действия'), `Sections: ${sections()}`);
  assert(optionTexts().some(t => /Новое занятие/.test(t) && /Ctrl N/.test(t)), 'Shortcut hints are shown');
  const field = q('.palette-search input');
  const type = value => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); };
  type('тем');
  await wait(150);
  assert(optionTexts().some(t => /тему/.test(t)), `Typing finds the theme action: ${optionTexts().slice(0, 5)}`);
  type('стиль');
  await wait(150);
  assert(optionTexts().some(t => /Настройки: Агент/.test(t)), 'Explanation style is available in settings');
  type('nvs');
  await wait(150);
  type('навык');
  await wait(150);
  assert(optionTexts().some(t => /Настройки: Навыки/.test(t)), 'The skills action is listed');
  type('использ');
  await wait(150);
  assert(optionTexts().some(t => /Настройки: Использование/.test(t)), 'Settings sections are listed');
  type('Матр');
  await wait(150);
  assert(optionTexts().some(t => /Матрицы/.test(t)), 'Lesson search still works');
  type('');
  await wait(100);
  const fieldInput = q('.palette-search input');
  fieldInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  type('тёмн');
  await wait(150);
  const before = document.documentElement.dataset.theme;
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => document.documentElement.dataset.theme !== before || /Включить светлую/.test(optionTexts().join()) === false, 'Enter runs the first action');
  await wait(200);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  await until(() => q('.palette-results'), 'The palette reopens');
  assert(sections()[0] === 'Недавнее', `Recent items come first: ${sections()}`);
  updateSettings({ theme });
  await closeDialog();
  results.push({ check: 'Palette: sections, hints, fuzzy actions, settings sections, recents, lesson search kept', pass: true });

  // ---------------------------------------------------------------- rich question text
  const { patchBlock } = await import('/src/lib/store.ts');
  await navigate('Определитель');
  const qb = getState().sessions['fixture-det'].blocks.find(b => b.kind === 'question');
  const prompt = [
    'Данные: $x^2$', '', '```chart', '{"type":"bar","title":"Оценки","data":[{"label":"A","value":3},{"label":"B","value":5}]}', '```', '',
    '```svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="window.__pwn=1"><script>window.__pwn=2</script><circle cx="5" cy="5" r="4" fill="#0072b2"/></svg>', '```', '',
    '```html', '<p onclick="window.__pwn=3" style="color:#d55e00">Привет</p><script>window.__pwn=4</script><img src="https://evil.example/leak.png">', '```', '',
    '![удалённая](https://evil.example/pixel.png) ![рабочая](fig/a.png)', '', '```chart', '{"type":"radar"}', '```',
  ].join('\n');
  patchBlock('fixture-det', qb.id, b => b.kind === 'question' ? { ...b, state: 'open', step: 0, view: 'step', questions: b.questions.map((qq, i) => i === 0 ? { ...qq, prompt } : qq) } : b);
  await until(() => q('.rm-chart'), 'The chart is drawn in the question');
  const chart = q('.rm-chart');
  assert(q('svg[role=img]', chart).getAttribute('aria-label').includes('A: 3') && q('details', chart), 'The chart has a text alternative');
  assert(q('.rm-svg img').src.startsWith('data:image/svg+xml') && !decodeURIComponent(q('.rm-svg img').src).includes('script'), 'The svg is sanitized and shown as an image');
  const host = q('.rm-html-host');
  assert(host.shadowRoot && host.shadowRoot.querySelector('p') && !host.shadowRoot.querySelector('script, img') && !host.shadowRoot.querySelector('p').hasAttribute('onclick'), 'The html runs in a shadow root, sanitized');
  assert(window.__pwn === undefined, 'No injected script ran');
  assert(q('.rm-remote-img[href^="https://evil"]') && !document.querySelector('img[src*="evil.example"]'), 'A remote image is a link, never an <img>');
  assert(/fig\/a\.png/.test(q('.rm-remote-img:not([href])').textContent), 'A folder image is named, not fetched');
  assert(q('.rm-problem') && /radar|тип графика/.test(q('.rm-problem').textContent), 'An invalid chart explains itself');
  const cr = chart.getBoundingClientRect();
  assert(cr.width > 150 && cr.right <= innerWidth + 1, 'The chart fits the column');
  assert(window.__mockBackend.unexpected.length === 0, `No unexpected network requests: ${window.__mockBackend.unexpected}`);
  results.push({ check: 'Question: chart, svg, html in a shadow root, remote images as links; nothing executed or fetched', pass: true });
  return results;
}
