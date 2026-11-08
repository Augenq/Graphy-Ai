import { uiScale, viewportWidth } from '/src/lib/layout.ts';
import { checkComposerPanel, checkModeMenu, checkTimer } from './composer-regression.mjs';
// Loaded by regression.html on the dedicated fixture server (npm run test:ui).
const transparent0 = c => /rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\)|transparent/.test(c);
const wait = (ms = 140) => new Promise(resolve => setTimeout(resolve, ms));
export const assert = (ok, message) => { if (!ok) throw new Error(message); };
const rect = element => Object.fromEntries(Object.entries(element.getBoundingClientRect().toJSON()).map(([key, value]) => [key, value / uiScale()]));
const click = element => {
  assert(element, 'Control is missing');
  (element.shadowRoot?.querySelector('button, input') ?? element).click();
};
const byLabel = (selector, label) => [...document.querySelectorAll(selector)].find(e => e.getAttribute("aria-label") === label);
// «Новое занятие» is its own pill button (.new-lesson) above the list; every other entry is a list row
const navItem = text => [...document.querySelectorAll('nav[data-sidebar] md-list-item, nav[data-sidebar] .new-lesson')].find(e => (e.querySelector('[slot=headline]') ?? e.querySelector('.new-lesson-label'))?.textContent === text);
export async function until(predicate, label, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await wait(30);
  }
  throw Error(`Timed out: ${label}`);
}

async function navigate(text) {
  if (!document.querySelector('nav[data-sidebar]')) {
    click(byLabel(".ui-icon-button", "Показать боковую панель"));
    await wait();
  }
  click(navItem(text));
  await wait();
  // Settings and the search palette are chunks loaded on demand
  if (text === 'Настройки') await until(() => document.querySelector('[data-settings-page]'), 'Settings page (loaded on demand)');
  if (text === 'Поиск') await until(() => document.querySelector('.palette-search input'), 'Search palette (loaded on demand)');
  const id = text === 'Матрицы' ? 'fixture-matrix' : text === 'Определитель' ? 'fixture-det' : null;
  if (id) {
    const { getState } = await import('/src/lib/store.ts');
    await until(() => getState().sessions[id]?.loaded && getState().activeId === id, `Load ${text}`);
  }
}
// Escape closes the top dialog or, with none open, the Settings page (a page of its own since X3, not a dialog)
async function closeDialog() {
  (document.querySelector('[data-ui-dialog]') ?? document.querySelector('[data-settings-page]'))?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(200);
}

export async function runRegression(theme = "dark") {
  assert(window.__mockBackend, 'Fixture backend is required');
  const results = [];
  const { updateSettings } = await import('/src/lib/settings.ts');
  await closeDialog();
  updateSettings({ language: 'ru', theme });
  await navigate('Новое занятие');
  const input = document.querySelector('[data-home-goal]');
  const send = document.querySelector('.home-composer .send-button');
  const ir = rect(input), sr = rect(send);
  const surfaceRect = rect(document.querySelector('.home-composer'));
  assert(sr.top >= ir.bottom - 1 && sr.right <= surfaceRect.right + 1 && sr.bottom <= surfaceRect.bottom + 1, 'Send button must stay in the composer toolbar');
  assert(Math.abs(sr.height - 32) < 1, 'Send button is not compact');
  assert(!send.textContent.includes('Начать'), 'Send must be icon-only');
  assert(getComputedStyle(document.querySelector('.home-heading')).fontFamily.includes('Roboto'), 'Heading font is missing');
  const wordmark = document.querySelector('.graphy-wordmark');
  if (wordmark) {
    assert(getComputedStyle(wordmark).fontFamily.includes('Roboto'), 'Wordmark font is missing');
    assert(!wordmark.previousElementSibling || wordmark.previousElementSibling.matches('svg.graphy-mark'), 'Only the Graphy mark may stand before the wordmark');
  }
  assert([...document.querySelectorAll('.sidebar-actions md-list-item [slot=start]')].every(e => e.querySelector('svg')), 'Original sidebar icons are missing');
  const rowSizes = [...document.querySelectorAll('nav[data-sidebar] md-list-item')].map(e => [rect(e).width, rect(e).height]);
  if (rowSizes.length) assert(rowSizes.every(([w, h]) => Math.abs(w - rowSizes[0][0]) < 1 && Math.abs(h - 32) < 1), 'Sidebar row geometry');
  const surface = getComputedStyle(document.documentElement).getPropertyValue('--md-sys-color-surface');
  const fieldSurface = getComputedStyle(document.querySelector('.home-composer')).backgroundColor;
  assert(surface !== fieldSurface && !fieldSurface.includes('transparent'), 'Dark input surface');
  results.push({ check: 'Home: send in toolbar, compact navigation, local fonts and input surface', pass: true });

  // first screen. Targets are on-screen px: the page zoom (--ui-scale, 1.1 on a desktop, 1 on a phone) multiplies CSS px,
  // so everything here is measured with getBoundingClientRect and scaled font sizes, never with logical values.
  const scale = uiScale();
  const screen = el => el.getBoundingClientRect();
  const headingEl = document.querySelector('.home-heading');
  const headingStyle = getComputedStyle(headingEl);
  if (innerWidth > 875) {
    const fontOnScreen = parseFloat(headingStyle.fontSize) * scale, lineOnScreen = screen(headingEl).height;
    assert(fontOnScreen >= 38 && fontOnScreen <= 41 && lineOnScreen >= 44 && lineOnScreen <= 49, `Home heading is 38-40/44-48 on screen (${fontOnScreen.toFixed(1)}/${lineOnScreen.toFixed(1)})`);
    const markOnScreen = screen(document.querySelector('.home-hero svg.graphy-mark'));
    assert(markOnScreen.width >= 38 && markOnScreen.width <= 42, `The mark next to the heading is ~40 on screen (${markOnScreen.width.toFixed(1)})`);
  }
  const heroMark = document.querySelector('.home-hero svg.graphy-mark');
  const heroStyle = heroMark && getComputedStyle(heroMark);
  assert(heroStyle && (heroStyle.stroke === heroStyle.color || heroStyle.fill === heroStyle.color), 'The mark next to the heading draws with currentColor (stroked ROUTE or a filled traced shape)');
  assert(document.querySelector('nav[data-sidebar] .sidebar-logo svg.graphy-mark'), 'The mark stands next to the wordmark in the sidebar');
  const axis = el => { const r = rect(el); return (r.left + r.right) / 2; };
  const column = [document.querySelector('.home-hero'), document.querySelector('.home-composer'), document.querySelector('.home-resume')].filter(Boolean);
  assert(column.every(el => Math.abs(axis(el) - axis(column[0])) < 1), 'Heading, input and «Continue» share one axis');
  if (innerWidth > 1200) assert(screen(document.querySelector('.home-composer')).width >= 720 && screen(document.querySelector('.home-composer')).width <= 760, `Home column is 720-760 on screen (${screen(document.querySelector('.home-composer')).width.toFixed(1)})`);
  const resumeTitle = document.querySelector('.home-resume-title');
  if (resumeTitle) {
    const typed = document.querySelector('[data-home-goal]');
    const textLeft = typed.getBoundingClientRect().left + parseFloat(getComputedStyle(typed).paddingLeft || 0) * scale;
    const labelLeft = resumeTitle.getBoundingClientRect().left + parseFloat(getComputedStyle(resumeTitle).paddingLeft) * scale;
    assert(Math.abs(labelLeft - textLeft) < 2, `«Continue» label and typed text share a left edge (${labelLeft.toFixed(1)} vs ${textLeft.toFixed(1)})`);
  }
  const pill = document.querySelector('nav[data-sidebar] .new-lesson');
  // commit 9fab6c9 put «New lesson» back to the size of a sidebar row (the 40-44 target of X2 was dropped); the test follows
  const sidebarRow = document.querySelector('nav[data-sidebar] md-list-item');
  assert(pill && sidebarRow && Math.abs(rect(pill).height - rect(sidebarRow).height) < 1 && parseFloat(getComputedStyle(pill).borderTopLeftRadius) === 8, '«New lesson» has the height of a sidebar row and the 8px radius of the sidebar rows');
  assert(getComputedStyle(pill).boxShadow === 'none' && Math.abs(parseFloat(getComputedStyle(pill).borderTopWidth) * uiScale() - 1) < 0.15 && getComputedStyle(pill).borderTopStyle === 'solid' && !transparent0(getComputedStyle(pill).borderTopColor) && getComputedStyle(pill).boxSizing === 'border-box', '«New lesson» has no shadow and a 1px border (border-box)');
  assert(Math.abs(pill.getBoundingClientRect().height - 32 * uiScale()) < 0.6 || innerWidth <= 600, '«New lesson» keeps the height of a sidebar row (32)');
  assert(pill.querySelector('kbd')?.textContent === 'Ctrl N' && pill.getAttribute('aria-keyshortcuts') === 'Control+N', 'The shortcut of «New lesson» is kept');
  assert(pill.previousElementSibling?.matches('.sidebar-brand') && !pill.closest('md-list'), '«New lesson» stands alone under the brand');
  assert(getComputedStyle(pill).transitionProperty.includes('background-color') && getComputedStyle(pill).transitionProperty.includes('transform') && !getComputedStyle(pill).transitionProperty.includes('box-shadow'), 'The button reacts to hover and press by fill, border and scale, not by shadow');
  assert(document.activeElement === input, '«New lesson» focuses the input');
  const navScroll = document.querySelector('nav[data-sidebar] .scroll-y');
  assert(navScroll.scrollWidth <= navScroll.clientWidth, 'The sidebar list must not scroll sideways');
  results.push({ check: 'Home: heading, mark, one column, pill button, no sideways scroll in the sidebar', pass: true });

  // the shared input panel of the first screen: two layers, quiet send, model with reasoning, mode menu, timer
  await checkComposerPanel('home');
  await checkModeMenu('home');
  await checkTimer();
  results.push({ check: 'Home: shared input panel (field over tray, quiet send, model + effort, mode menu rows, timer)', pass: true });

  await navigate('Настройки');
  await wait(400);
  assert(document.querySelector('[data-settings-page]'), 'Settings is a page');
  assert(!document.querySelector('[data-ui-dialog], .ui-dialog-backdrop') && !document.getElementById('root').inert, 'Settings is not a modal dialog: no backdrop, the app root is not inert');
  assert(document.querySelector('.graphy-canvas').inert, 'The workspace stays mounted under the Settings page and is inert');
  const pages = [];
  for (const item of document.querySelectorAll('.settings-nav md-list-item')) {
    assert(Math.abs(rect(item).height - 36) < 1, 'Settings navigation row is not 36 px');
    if (viewportWidth() > 700) {
      const icon = rect(item.querySelector('md-icon'));
      const label = item.querySelector('.settings-label');
      const text = rect(label);
      assert(Math.abs(icon.y + icon.height / 2 - text.y - text.height / 2) < .5, 'Settings icon and text are not centered');
      assert(label.scrollWidth <= label.clientWidth + 1, 'Settings section label is clipped');
    }
  }
  for (const item of [...document.querySelectorAll('.settings-nav md-list-item')]) {
    click(item);
    await wait();
    assert(location.hash === `#settings/${item.dataset.section}` && document.querySelector('[data-settings-page]').dataset.section === item.dataset.section, 'The section is in the address');
    const side = rect(document.querySelector('.settings-side')), column = rect(document.querySelector('.settings-column')), title = rect(document.querySelector('.settings-head h1'));
    pages.push({ section: item.getAttribute('aria-label'), side: [side.x, side.width], column: [column.x, column.width], title: title.x });
    const main = document.querySelector('.settings-main');
    assert(main.scrollWidth <= main.clientWidth + 1, 'Settings horizontal overflow');
    for (const field of document.querySelectorAll('.settings-body md-outlined-select')) assert(Math.abs(rect(field).height - 32) < 1, 'Settings select is too tall');
    assert(document.querySelector('.settings-page').scrollHeight <= document.querySelector('.settings-page').clientHeight + 1, 'Settings content pushes the page into scrolling');
  }
  assert(pages.length === 10, 'A settings section is missing');
  assert(pages.every(r => ['side', 'column'].every(k => r[k].every((v, i) => Math.abs(v - pages[0][k][i]) < 1)) && Math.abs(r.title - pages[0].title) < 1), 'Settings sidebar, column and title axis change between sections');
  const search = document.querySelector('.settings-search :is(.ui-field input, .ui-field textarea)');
  assert(rect(search).height <= 44, 'Settings search too tall');
  assert(search.tagName === 'INPUT', 'Search is a native input');
  results.push({ check: 'All 10 settings sections keep one sidebar, one column and one title axis', pass: true, pages });
  await closeDialog();

  await navigate('Поиск');
  await wait(400);
  const palette = document.querySelector('[data-ui-dialog]');
  assert(rect(palette).width >= Math.min(760, viewportWidth() - 40) - 1, 'Lesson search panel too narrow');
  const heightBefore = rect(palette).height;
  const ps = document.querySelector('.palette-search input');
  ps.value = 'Определитель';
  ps.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
  await wait();
  assert(document.querySelectorAll('.search-result').length > 0, 'Lesson search is empty');
  assert(Math.abs(rect(palette).height - heightBefore) < 1, 'Search panel changes size');
  const searchScroller = document.querySelector('[data-ui-dialog] .graphy-dialog-content');
  assert(searchScroller.scrollHeight <= searchScroller.clientHeight + 1, 'Search content overflows outer dialog');
  assert(!document.querySelector('.search-result').classList.contains('keyboard-selected'), 'Pointer search should not highlight');
  results.push({ check: 'Large fixed search panel, results without pointer hover/active', pass: true });
  window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }));
  await wait(350);
  assert(!document.querySelector('[data-ui-dialog]') && document.querySelector('.settings-nav'), 'Settings replace the search');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  await wait(350);
  assert(document.querySelectorAll('[data-ui-dialog]').length === 1 && document.querySelector('.palette-search') && document.querySelector('[data-settings-page]'), 'Search opens over the Settings page');
  results.push({ check: 'Keyboard switching keeps only one dialog open; Settings are a page under it', pass: true });
  await closeDialog();
  await closeDialog();
  assert(!document.querySelector('[data-settings-page]'), 'Escape closes the search, then the Settings page');

  await navigate('Определитель');
  const waiting = document.querySelector('[data-composer-waiting]');
  assert(waiting && rect(waiting).height <= 56, 'Waiting footer is too tall');
  assert(!document.querySelector('[data-composer]'), 'Disabled composer should not crop waiting chat');
  const log = document.querySelector('[role=log]');
  assert(rect(log).height > innerHeight / uiScale() * .6, 'Waiting transcript was cropped');
  log.scrollTop = 0;
  log.dispatchEvent(new Event('scroll'));
  await wait();
  const jump = document.querySelector('.jump-to-latest');
  assert(jump && rect(jump).bottom <= rect(log).bottom && rect(jump).top >= rect(log).top, 'Jump button outside transcript');
  results.push({ check: 'Compact waiting footer and jump button inside chat', pass: true });

  const write = navigator.clipboard?.writeText;
  const clipboard = navigator.clipboard;
  assert(clipboard, 'Clipboard API unavailable');
  let copied = '';
  clipboard.writeText = async text => { copied = text; };
  try {
    const button = byLabel(".ui-icon-button", "Копировать код");
    assert(button, 'Code copy button missing');
    click(button);
    await wait();
    assert(copied.includes('import numpy') && button.getAttribute('aria-label') === 'Скопировано', 'Code copy payload or feedback');
    clipboard.writeText = async () => { throw new Error('Test clipboard unavailable'); };
    const exec = document.execCommand;
    document.execCommand = () => false;
    try {
      click(button);
      await wait();
      assert(button.getAttribute('aria-label') === 'Не удалось скопировать', 'Clipboard reports false success');
    } finally { document.execCommand = exec; }
  } finally { clipboard.writeText = write; }
  results.push({ check: 'Copy: real payload, success and rejected failure states', pass: true });

  await navigate('Матрицы');
  await wait(200);
  const button = document.querySelector('.rail-card-title');
  assert(button && button.tagName === 'BUTTON' && !button.shadowRoot && !byLabel(".ui-icon-button", "Показать панель"), 'Rail card titles are native buttons and no panel toggle exists');
  results.push({ check: 'MAX controls use accessible native elements', pass: true });
  const composer = document.querySelector('[data-composer]');
  assert(composer && rect(composer).height >= 28, 'Empty message field collapsed before Material finished rendering');
  const toolbar = document.querySelector('.composer-toolbar');
  assert(rect(toolbar).height >= 28 && rect(toolbar).height <= 36, 'Composer toolbar wraps or is too tall');
  await checkComposerPanel('lesson'); // the same panel in the lesson: no divergence from the first screen
  await checkModeMenu('lesson'); // at the bottom of the window the menu opens upward
  results.push({ check: 'Compact message editor keeps a full text line after opening', pass: true });
  assert(document.documentElement.scrollWidth <= innerWidth, 'Page horizontal overflow');
  assert(window.__mockBackend.unexpected.length === 0, `Unexpected requests: ${window.__mockBackend.unexpected.join(', ')}`);
  assert(window.__mockBackend.requests.some(r => r.path === '/sessions/fixture-det'), 'Quiz must be loaded through the HTTP client');
  return results;
}

export { click, wait, navigate, closeDialog };
