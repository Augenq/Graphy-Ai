// Settings as a page (components/SettingsPage.tsx): addresses, Back/Forward, a workspace that stays alive under it (drafts, reading
// position, a running agent), the theme cards, the text preview, the logo block. Sizes are checked in on-screen px (getBoundingClientRect)
// and in logical px (divided by the page zoom, 1.1 on a desktop).
import { until, wait, click, navigate, closeDialog } from './ui-regression.mjs';
import { uiScale } from '/src/lib/layout.ts';

const assert = (value, message) => { if (!value) throw Error(message); };
const q = (selector, root = document) => root.querySelector(selector);
const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
const screen = el => el.getBoundingClientRect();
const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x / uiScale(), y: r.y / uiScale(), left: r.left / uiScale(), right: r.right / uiScale(), width: r.width / uiScale(), height: r.height / uiScale() }; };
const setText = (el, value, proto = HTMLTextAreaElement.prototype) => { Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); };
const key = (el, k, init = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
const page = () => q('[data-settings-page]');
const section = () => page()?.dataset.section;
const visible = el => !!el && el.getClientRects().length > 0;
const title = () => qa('[data-settings-title]', page()).find(visible);
const nav = id => q(`.settings-nav md-list-item[data-section="${id}"]`);
const radios = group => qa('[role=radio]', q(`[role=radiogroup][aria-label="${group}"]`));
const checked = group => radios(group).find(r => r.getAttribute('aria-checked') === 'true');
const abortCount = () => window.__mockBackend.requests.filter(r => r.method === 'POST' && /\/abort$/.test(r.path)).length;
const openByShortcut = async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true })); await until(page, 'Ctrl+, opens Settings'); await wait(60); };
const leave = async () => { key(page(), 'Escape'); await until(() => !page(), 'Escape leaves Settings'); await wait(60); };
// a new copy of a module reads localStorage as a freshly loaded page does (vite takes a numeric ?t= as a cache buster)
let copies = 0;
const fresh = (path) => import(/* @vite-ignore */ `${path}?t=${Date.now()}${copies++}`);

export async function runSettingsRegression(theme = 'dark') {
  const { updateSettings, getSettings, defaultSettings } = await import('/src/lib/settings.ts');
  const { getState, patchSession } = await import('/src/lib/store.ts');
  const { setLogoChoice, getLogoId } = await import('/src/lib/logo-choice.ts');
  const { logoCandidates } = await import('/src/lib/logo-candidates.ts');
  if (!q('link[rel="icon"]')) document.head.append(Object.assign(document.createElement('link'), { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' })); // the fixture page has none
  updateSettings({ language: 'ru', theme, textSize: 'm', width: 'medium' });
  setLogoChoice('02');
  await closeDialog();
  const checks = [];
  const ok = (name, extra = {}) => checks.push({ check: name, pass: true, ...extra });

  // ---- 1. the first screen's draft survives a visit to Settings (the workspace is not remounted); focus goes in and comes back
  await navigate('Новое занятие');
  const goal = q('[data-home-goal]');
  setText(goal, 'Разобрать определитель');
  await wait(60);
  goal.focus();
  await openByShortcut();
  assert(goal.isConnected && q('[data-home-goal]') === goal && goal.value === 'Разобрать определитель', 'The draft of the first screen is the same field with the same text under Settings');
  assert(document.activeElement === title(), 'Focus moves to the page title on opening');
  assert(location.hash === '#settings/appearance' && section() === 'appearance', 'Ctrl+, opens «Внешний вид» at #settings/appearance');
  assert(q('.graphy-canvas').inert && (!q('nav[data-sidebar]') || q('nav[data-sidebar]').closest('[inert]')), 'The workspace under the page is inert (no focus, no reading by assistive tech)');
  assert(!q('[data-ui-dialog], .ui-dialog-backdrop') && !document.getElementById('root').inert, 'No overlay, no modal trap');
  click(q('[data-settings-back]'));
  await until(() => !page(), 'Back leaves Settings');
  await wait(100);
  assert(!location.hash && q('[data-home-goal]') === goal && goal.value === 'Разобрать определитель', 'Back returns to the same first screen with its draft');
  assert(document.activeElement === goal, 'Focus returns to the field it left');
  setText(goal, '');
  ok('Home draft kept across Settings (same node, same text); focus in and back out; page, not dialog');

  // ---- 2. a lesson: draft, reading position, open panel, and the agent keeps running (Escape in Settings is not «stop»)
  await navigate('Матрицы');
  await until(() => q('[data-composer]'), 'Lesson composer');
  const composer = q('[data-composer]'), log = q('[role=log]'), body = q('.lesson-body');
  setText(composer, 'Черновик ответа в занятии');
  const scroller = qa('[role=log], [role=log] > div').find(el => el.scrollHeight > el.clientHeight + 40);
  if (scroller) scroller.scrollTop = 60;
  const top = scroller?.scrollTop ?? 0;
  const id = getState().activeId;
  const before = getState().sessions[id].agent;
  patchSession(id, s => ({ ...s, agent: { ...s.agent, kind: 'writing' } }));
  const aborts = abortCount();
  composer.blur();
  await navigate('Настройки');
  await until(page, 'Settings opens from the sidebar');
  assert(!!q('[data-composer]') && q('[data-composer]') === composer && composer.value === 'Черновик ответа в занятии' && getState().sessions[id].draft === 'Черновик ответа в занятии', 'The lesson draft is the same field with the same text');
  assert(q('[role=log]') === log && q('.lesson-body') === body, 'The thread and the panel area are not remounted');
  if (scroller) assert(Math.abs(scroller.scrollTop - top) < 2, 'The reading position is kept');
  assert(q('[data-settings-back] span').textContent.trim() === 'Назад к занятию', 'In a lesson the back button says «Назад к занятию»');
  key(page(), 'Escape');
  await until(() => !page(), 'Escape leaves Settings');
  await wait(120);
  assert(abortCount() === aborts && getState().sessions[id].agent.kind === 'writing', 'Opening Settings and leaving with Escape does not stop the running agent');
  assert(getState().activeId === id && q('[data-composer]') === composer && composer.value === 'Черновик ответа в занятии', 'Back returns to the same lesson and draft');
  if (scroller) assert(Math.abs(scroller.scrollTop - top) < 2, 'The reading position survives the round trip');
  patchSession(id, s => ({ ...s, agent: before, draft: '' }));
  ok('Lesson draft, thread, panel area and a running agent survive Settings and Back', { scroller: !!scroller });

  // ---- 3. addresses: a section in the hash, Back/Forward, the old #settings, bad names, a real page load
  await navigate('Настройки');
  await until(page, 'Settings');
  assert(location.hash === '#settings/appearance', 'The sidebar entry opens #settings/appearance');
  click(nav('models'));
  await until(() => section() === 'models', 'Section models');
  assert(location.hash === '#settings/models', 'A section is in the address');
  history.back();
  await until(() => section() === 'appearance' && location.hash === '#settings/appearance', 'Browser Back returns to the previous section');
  history.back();
  await until(() => !page() && !location.hash, 'Browser Back leaves Settings');
  history.forward();
  await until(() => section() === 'appearance', 'Browser Forward comes back to Settings');
  history.forward();
  await until(() => section() === 'models', 'Browser Forward goes on to the next section');
  click(q('[data-settings-back]'));
  await until(() => !page() && !location.hash, '«Back» goes to where Settings were opened from');
  const length = history.length;
  location.hash = 'settings';
  await until(() => page() && location.hash === '#settings/appearance', 'The old #settings opens «Внешний вид» and becomes canonical');
  location.hash = 'settings/usage';
  await until(() => section() === 'usage', '#settings/usage');
  location.hash = 'settings/no-such-section';
  await until(() => section() === 'appearance' && location.hash === '#settings/appearance', 'An unknown section falls back to «Внешний вид»');
  location.hash = 'skills';
  await until(() => section() === 'skills' && location.hash === '#settings/skills', 'The older #skills deep link still opens Skills');
  await leave();
  assert(!location.hash, 'Leaving a deep-linked Settings removes the hash');
  assert(history.length >= length, 'History was not rewritten by the tests');
  // a real page load of the address in a frame: the section is there, the default logo is FOLD, the choice made here is kept
  localStorage.removeItem('graphy-logo-v1');
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;left:-9999px;top:0;width:1440px;height:900px;border:0';
  frame.src = `${location.pathname}?only=zzz&theme=${getSettings().theme === 'light' ? 'light' : 'dark'}#settings/models`;
  document.body.append(frame);
  await until(() => frame.contentDocument?.querySelector('[data-settings-page][data-section="models"]'), 'A fresh load of #settings/models shows Models', 20000);
  const inner = frame.contentDocument;
  assert(inner.querySelector('.settings-head h1')?.textContent === 'Модели и провайдеры' && inner.querySelector('.settings-nav md-list-item[data-aria-current="page"]')?.dataset.section === 'models', 'The reloaded page shows the addressed section as current');
  frame.contentWindow.location.hash = 'settings/appearance';
  await until(() => inner.querySelector('[data-settings-page][data-section="appearance"] [data-logo]'), 'Appearance in the frame', 5000);
  assert(inner.querySelector('[data-logo][aria-checked="true"]')?.dataset.logo === '02', 'After a fresh load the logo is the default 02');
  frame.remove();
  ok('Addressable sections, reload, Back/Forward, #settings, #skills, unknown section, Back to where it was opened');

  // ---- 4. layout in on-screen px: the side panel, the column, one axis
  await openByShortcut();
  const side = page().querySelector('.settings-side'), column = q('.settings-column'), search = q('.settings-search .ui-field-control');
  const sideW = screen(side).width, h1 = title(), h1Style = getComputedStyle(h1);
  assert(Math.abs(rect(side).width - 224) < 0.5 && sideW >= 240 && sideW <= 262, `The side panel is 224 logical, ${sideW.toFixed(1)} on screen (240-262)`);
  assert(rect(column).width <= 880.5 && Math.abs(rect(column).width - Math.min(880, rect(q('.settings-main')).width)) < 16, 'The content column fills the area up to 880 logical (800 of content; a scrollbar gutter may take a few px)');
  assert(Math.abs(rect(search).height - 36) < 0.5 && parseFloat(getComputedStyle(search).borderTopLeftRadius) >= 18, 'The search is a 36 px pill');
  assert(qa('md-list-item', q('.settings-nav')).every(item => Math.abs(rect(item).height - 36) < 0.5), 'Section rows are 36 logical px');
  assert(qa('.settings-group-title').length === 4, 'Sections are grouped under four headings');
  const titleScreen = parseFloat(h1Style.fontSize) * uiScale();
  assert(h1Style.fontFamily.includes('Roboto') && titleScreen >= 30 && titleScreen <= 34, `The page title is Roboto, ~32 on screen (${titleScreen.toFixed(1)})`);
  const axis = [h1, q('.settings-head p'), q('.settings-section-head h2'), q('.settings-section-body'), q('.theme-cards'), q('.settings-row-title')].map(el => rect(el).left);
  assert(axis.every(v => Math.abs(v - axis[0]) < 0.5), `Title, subtitle, section heads, cards and rows share one left axis (${axis.map(v => v.toFixed(1)).join(', ')})`);
  const rows = qa('.settings-row', page()), row = rows[0];
  assert(rows.every(r => rect(r.querySelector('.settings-row-control')).right <= rect(column).right - 40 + 0.5), 'Row controls stand on the right edge of the column');
  assert(!q('.settings-main').scrollWidth || q('.settings-main').scrollWidth <= q('.settings-main').clientWidth + 1, 'No sideways scroll');
  title().focus();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', bubbles: true }));
  assert(side.contains(document.activeElement), 'F6 goes from the page to the list of sections');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', bubbles: true }));
  assert(document.activeElement === title(), 'F6 goes back to the page');
  ok('Layout: side panel 224 logical (≈246 on screen), 36 px rows and pill search, ≤880 column, one axis, 32 px title', { sideScreen: Math.round(sideW * 10) / 10, columnScreen: Math.round(screen(column).width * 10) / 10, contentScreen: Math.round(screen(q('.settings-section-body')).width * 10) / 10, titleScreen: Math.round(titleScreen * 10) / 10, rowScreen: Math.round(screen(row).height * 10) / 10 });

  // ---- 5. theme: three radio cards, a miniature of Graphy in each, frame + tick, keys, persistence
  const group = q('[role=radiogroup][aria-label="Тема"]');
  const cards = radios('Тема');
  assert(group && cards.length === 3 && cards.map(c => c.dataset.themeCard).join() === 'light,dark,system', 'A radiogroup of three theme cards: light, dark, system');
  assert(cards.filter(c => c.getAttribute('aria-checked') === 'true').length === 1 && cards.filter(c => c.tabIndex === 0).length === 1, 'One card is chosen and is the only one in the Tab order');
  const svgText = c => c.querySelector('svg').outerHTML;
  assert(svgText(cards[0]).includes('#fafafa') && !svgText(cards[0]).includes('#151515'), 'The light card previews the light palette');
  assert(svgText(cards[1]).includes('#151515') && !svgText(cards[1]).includes('#fafafa'), 'The dark card previews the dark palette');
  assert(svgText(cards[2]).includes('#fafafa') && svgText(cards[2]).includes('#151515') && cards[2].querySelector('clipPath'), 'The system card is cut: light and dark halves');
  assert(qa('.theme-card svg rect', page()).length >= 30 && cards.every(c => c.querySelector('.theme-card-svg rect[width="42"]')), 'Each preview draws the app: side panel, answer, message, input');
  const mark = c => ({ border: getComputedStyle(c).borderTopColor, width: getComputedStyle(c).borderTopWidth, tick: +getComputedStyle(c.querySelector('.theme-card-check')).opacity });
  for (const id of ['light', 'dark', 'system', 'dark']) {
    const card = cards.find(c => c.dataset.themeCard === id);
    click(card);
    await wait(260);
    const expectDark = id === 'dark' || (id === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    assert(getSettings().theme === id && document.documentElement.dataset.theme === (expectDark ? 'dark' : 'light'), `Choosing «${id}» applies at once`);
    assert(JSON.parse(localStorage.getItem('graphy-material-settings-v1')).theme === id, `«${id}» is saved`);
    const others = cards.filter(c => c !== card);
    assert(card.getAttribute('aria-checked') === 'true' && others.every(c => c.getAttribute('aria-checked') === 'false'), 'Only the chosen card is checked');
    assert(mark(card).tick === 1 && others.every(c => mark(c).tick === 0), 'Only the chosen card shows the tick');
    assert(mark(card).width === mark(others[0]).width && mark(card).border !== mark(others[0]).border, 'The chosen card has its own frame colour (same width: no jump)');
    assert((await fresh('/src/lib/settings.ts')).getSettings().theme === id, `A fresh load of the page reads «${id}»`);
  }
  // keys: arrows move the choice and the focus, Home/End jump
  updateSettings({ theme: 'light' });
  await wait(100);
  const light = cards.find(c => c.dataset.themeCard === 'light');
  light.focus();
  key(light, 'ArrowRight');
  await wait(120);
  assert(getSettings().theme === 'dark' && document.activeElement.dataset.themeCard === 'dark', 'ArrowRight chooses the next theme and moves focus');
  key(document.activeElement, 'ArrowRight');
  await wait(120);
  assert(getSettings().theme === 'system' && document.activeElement.dataset.themeCard === 'system', 'ArrowRight again: system');
  key(document.activeElement, 'ArrowRight');
  await wait(120);
  assert(getSettings().theme === 'light', 'The choice wraps around');
  key(document.activeElement, 'End');
  await wait(120);
  assert(getSettings().theme === 'system', 'End goes to the last card');
  key(document.activeElement, 'Home');
  await wait(120);
  assert(getSettings().theme === 'light', 'Home goes to the first card');
  updateSettings({ theme });
  await wait(100);
  ok('Theme: radiogroup of 3 cards with real miniatures, frame + tick, instant + saved + read back, arrows/Home/End');

  // ---- 6. text size and width: a live answer with a formula that follows the choice
  const preview = q('[data-text-preview] .md');
  assert(preview && preview.classList.contains('selectable') && preview.querySelector('.katex') && /Определитель/.test(preview.textContent), 'The preview is the dialog\'s own math text (Markdown component, KaTeX)');
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;font-size:var(--content-size);line-height:var(--content-lh)';
  document.body.append(probe);
  const sizes = {};
  for (const id of ['s', 'm', 'l']) {
    const opt = radios('Размер текста').find(r => r.dataset.value === id);
    click(opt);
    await wait(120);
    assert(opt.getAttribute('aria-checked') === 'true' && document.documentElement.dataset.textsize === id, `Text size «${id}» applies at once`);
    const font = parseFloat(getComputedStyle(q('[data-text-preview] .md')).fontSize);
    assert(font === parseFloat(getComputedStyle(probe).fontSize) && parseFloat(getComputedStyle(q('[data-text-preview] .md')).lineHeight) === parseFloat(getComputedStyle(probe).lineHeight), `The preview uses the dialog's --content-size / --content-lh (${font}px)`);
    sizes[id] = font;
  }
  probe.remove();
  assert(sizes.s < sizes.m && sizes.m < sizes.l, `The preview grows with the size (${JSON.stringify(sizes)})`);
  click(radios('Размер текста').find(r => r.dataset.value === 'm'));
  const widths = {};
  for (const id of ['narrow', 'medium', 'wide']) {
    click(radios('Ширина колонки').find(r => r.dataset.value === id));
    await wait(320);
    const col = q('[data-preview-column]');
    const want = Math.min(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--col-max')), rect(q('.settings-preview-stage')).width);
    assert(document.documentElement.dataset.width === id && Math.abs(rect(col).width - want) < 3, `Width «${id}» applies at once; the column is min(--col-max, stage) = ${want}`);
    widths[id] = Math.round(rect(col).width);
  }
  const room = rect(q('.settings-preview-stage')).width; // in a narrow window the stage is narrower than the narrowest column, as the dialog column would be
  assert(room < 700 ? widths.narrow <= room + 3 : widths.narrow < widths.medium && widths.medium <= widths.wide, `The preview column follows the width (${JSON.stringify(widths)}, room ${Math.round(room)})`);
  click(radios('Ширина колонки').find(r => r.dataset.value === 'medium'));
  assert(radios('Размер текста').length === 3 && radios('Размер текста').every((r, i) => qa('.choice-label', r)[0].textContent && (r.getAttribute('aria-checked') === 'true') === (i === 1)), 'Size choices: three options, the middle one chosen, each labelled');
  ok('Text size and width: radios with samples; a live answer with a formula changes at once with the dialog\'s own variables', { sizes, widths });

  // ---- 7. logo: 23 tiles, FOLD by default, applied in the sidebar, the first screen and the tab icon, saved, ROUTE by choice
  await fresh('/src/lib/logo-choice.ts');
  localStorage.removeItem('graphy-logo-v1');
  assert((await fresh('/src/lib/logo-choice.ts')).getLogoId() === '02', 'Without a saved choice the logo is 02 (FOLD)');
  const tiles = radios('Логотип');
  assert(tiles.length === 23 && tiles[0].dataset.logo === 'route' && logoCandidates.length === 22 && tiles.slice(1).every((t, i) => t.dataset.logo === logoCandidates[i].id), '22 traced variants and the clean 16 ROUTE are offered');
  assert(tiles.every(t => /^\w[\w.]*\s/.test(t.getAttribute('aria-label')) && t.querySelector('.logo-tile-label b') && t.querySelector('svg.graphy-mark')), 'Each tile is labelled with its id and name');
  assert(q('[data-logo-current]').dataset.logoCurrent === '02' && /02 FOLD/.test(q('[data-logo-current]').textContent), 'The block says what is chosen now: 02 FOLD');
  const fold = logoCandidates.find(s => s.id === '02');
  const d = sel => q(`${sel} path`)?.getAttribute('d');
  assert(getLogoId() === '02' && checked('Логотип').dataset.logo === '02', 'FOLD is the chosen tile by default');
  assert(+getComputedStyle(checked('Логотип').querySelector('.logo-tile-check')).opacity === 1 && tiles.filter(t => t !== checked('Логотип')).every(t => +getComputedStyle(t.querySelector('.logo-tile-check')).opacity === 0), 'Only the chosen tile shows the tick');
  assert(getComputedStyle(checked('Логотип')).borderTopColor !== getComputedStyle(tiles[0]).borderTopColor, 'The chosen tile has its own frame');
  const docked = !!q('nav[data-sidebar] .sidebar-logo svg.graphy-mark'); // a narrow window keeps the side panel closed (an overlay)
  if (docked) assert(d('nav[data-sidebar] .sidebar-logo svg.graphy-mark') === fold.d, 'The side panel shows FOLD');
  if (q('.home-mark')) assert(d('.home-mark') === fold.d, 'The first screen shows FOLD');
  const icon = () => q('link[rel="icon"]').getAttribute('href');
  assert(icon() === '/favicon.svg', 'The tab icon is the static favicon.svg (FOLD)');
  const svgFile = await (await fetch('/favicon.svg')).text();
  assert(svgFile.includes(`viewBox="${fold.viewBox}"`) && svgFile.includes(fold.d.slice(0, 60)) && svgFile.includes('prefers-color-scheme:dark') && /#f0f0f0/.test(svgFile), 'The static favicon is FOLD with a dark-scheme colour');
  const five = logoCandidates.find(s => s.id === '05');
  click(tiles.find(t => t.dataset.logo === '05'));
  await wait(120);
  assert(getLogoId() === '05' && localStorage.getItem('graphy-logo-v1') === '05', 'Choosing a tile saves it');
  assert((!docked || d('nav[data-sidebar] .sidebar-logo svg.graphy-mark') === five.d) && (!q('.home-mark') || d('.home-mark') === five.d), 'The new mark is in the side panel (and on the first screen) at once');
  assert(icon().startsWith('data:image/svg+xml') && decodeURIComponent(icon()).includes(five.d.slice(0, 40)) && decodeURIComponent(icon()).includes('prefers-color-scheme:dark'), 'The tab icon follows, with a dark-scheme colour');
  assert((await fresh('/src/lib/logo-choice.ts')).getLogoId() === '05', 'A fresh load reads the saved choice');
  checked('Логотип').focus();
  key(checked('Логотип'), 'ArrowRight');
  await wait(100);
  assert(getLogoId() === '06' && document.activeElement.dataset.logo === '06', 'Arrow keys move the logo choice and the focus');
  click(tiles[0]);
  await wait(120);
  const routeMark = q('nav[data-sidebar] .sidebar-logo svg.graphy-mark') ?? tiles[0].querySelector('svg');
  assert(getLogoId() === 'route' && routeMark.querySelector('path').getAttribute('d').startsWith('M18.52 3.75') && getComputedStyle(routeMark).fill === 'none' && getComputedStyle(routeMark).stroke === getComputedStyle(routeMark).color, 'The clean ROUTE is drawn as a stroke in the text colour');
  assert(decodeURIComponent(icon()).includes('M18.52 3.75'), 'The tab icon follows ROUTE as well');
  // «Настройки по умолчанию» brings FOLD back
  click(nav('data'));
  await until(() => section() === 'data', 'Data section');
  const restore = qa('button', page()).find(b => b.textContent.trim() === 'Вернуть');
  click(restore);
  await wait(150);
  assert(getLogoId() === '02' && icon() === '/favicon.svg', '«Настройки по умолчанию» return the logo to FOLD');
  updateSettings({ ...defaultSettings, language: 'ru', theme });
  ok('Logo: 23 tiles with ids and names, FOLD (02) by default, frame + tick, sidebar/first screen/favicon, saved, ROUTE by choice, reset', { favicon: 'static favicon.svg is FOLD' });

  // ---- 8. search and Escape inside the page
  click(nav('appearance'));
  await until(() => section() === 'appearance', 'Appearance');
  const input = q('input[aria-label="Поиск по настройкам"]');
  setText(input, 'логотип', HTMLInputElement.prototype);
  await wait(150);
  const hit = q('.settings-nav [aria-label="Результаты поиска"] button');
  assert(hit && /Логотип/.test(hit.textContent), 'Search finds the logo block');
  setText(input, 'размер', HTMLInputElement.prototype);
  await wait(100);
  key(input, 'Escape');
  await wait(120);
  assert(input.value === '' && page(), 'Escape in the search clears it and stays in Settings');
  setText(input, 'логотип', HTMLInputElement.prototype);
  await wait(150);
  click(q('.settings-nav [aria-label="Результаты поиска"] button'));
  await wait(200);
  assert(input.value === '' && section() === 'appearance' && document.activeElement === title(), 'A search hit opens its section and focuses the title');
  await leave();
  ok('Search finds the logo, Escape clears it first, a hit focuses the title');
  assert(!page() && !location.hash, 'Settings are closed at the end');
  return { pass: true, checks: checks.map(c => c.check), details: checks };
}
