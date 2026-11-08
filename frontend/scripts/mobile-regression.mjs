import { assert, until } from './ui-regression.mjs';

const wait = (ms = 200) => new Promise(resolve => setTimeout(resolve, ms));
const click = el => { assert(el, 'Mobile control is missing'); (el.shadowRoot?.querySelector('button') ?? el).click(); };
const nav = text => [...document.querySelectorAll('nav[data-sidebar] md-list-item')].find(el => el.textContent.includes(text));
const rect = el => el.getBoundingClientRect();

/** Exercises navigation and resizing against the wire-format backend fixtures. */
export async function runMobileRegression(theme = 'dark') {
  assert(innerWidth <= 600, 'Run mobile regression at a phone width');
  const { updateSettings } = await import('/src/lib/settings.ts');
  updateSettings({ theme, language: 'ru' });
  await wait();
  assert(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim() === '1', 'Phones must use physical CSS pixels');
  const home = document.querySelector('.home-content');
  const heading = rect(home.querySelector('.home-hero')); // the mark stands above the h1 on a phone: the group starts with it
  const sections = [...home.querySelectorAll(':scope > section')];
  const last = rect(sections.at(-1));
  const frame = rect(home);
  assert(Math.abs((heading.top + last.bottom) / 2 - (frame.top + frame.bottom) / 2) < 3, 'Entire home group must be vertically centered');
  for (const el of document.querySelectorAll('.home-composer .ui-icon-button, .home-composer .send-button')) {
    assert(rect(el).width >= 44 && rect(el).height >= 44, 'Composer touch target below 44px');
  }
  assert(!document.querySelector('nav[data-sidebar]'), 'Phone navigation starts closed');
  // the options tray under the field: the mode is visible at once, 44px targets, one row, nothing outside the screen
  const tray = document.querySelector('.composer-tray');
  const mode = tray.querySelector('.mode-button');
  assert(mode && mode.textContent.trim() === 'Объяснение', 'Mobile: the mode is visible without opening anything');
  for (const el of [mode, ...document.querySelectorAll('.home-composer .composer-toolbar button, .home-composer .composer-toolbar [role=combobox]')]) assert(rect(el).height >= 44 - 0.5, `Mobile: a target below 44px: ${el.className} ${rect(el).height}`);
  assert(rect(tray).left >= 0 && rect(tray).right <= innerWidth && tray.scrollWidth <= tray.clientWidth + 1, 'Mobile: the tray stays inside the screen');
  assert(rect(mode).bottom <= rect(tray).bottom, 'Mobile: the mode sits inside the tray');
  click(mode);
  await until(() => document.querySelector('.ui-menu-content'), 'Mobile mode menu');
  await wait();
  const rows = [...document.querySelectorAll('.ui-menu-content [role=menuitem]')].filter(el => el.getAttribute('aria-disabled') !== 'true');
  assert(rows.length === 3 && rows.every(el => rect(el).height >= 52 && rect(el).height <= 64), 'Mobile: mode rows are 52-64px');
  let box = rect(document.querySelector('.ui-menu-content'));
  assert(box.top >= 0 && box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight, 'Mobile: the mode menu fits the screen');
  document.querySelector('.ui-menu-content').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait();
  click(document.querySelector('.model-control [role=combobox]'));
  await until(() => document.querySelector('.model-panel'), 'Mobile model panel');
  await wait();
  assert(document.querySelector('.model-panel .reasoning-title')?.textContent === 'Глубина рассуждения', 'Mobile: reasoning effort is named inside the model panel');
  box = rect(document.querySelector('.ui-menu-content'));
  assert(box.top >= 0 && box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight, 'Mobile: the model panel fits the screen');
  document.querySelector('.ui-menu-content').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait();
  click(document.querySelector('.app-topbar .ui-icon-button'));
  await until(() => nav('Настройки'), 'Mobile drawer');
  assert(document.querySelector('main').inert, 'Background must be inert behind drawer');
  assert(rect(nav('Настройки')).height >= 44, 'Navigation target below 44px');
  click(nav('Настройки'));
  await until(() => document.querySelector('[data-settings-page]'), 'Mobile settings');
  await wait();
  assert(!document.querySelector('[data-ui-dialog]') && location.hash === '#settings', 'Mobile settings are a page; the list of sections is #settings');
  const shown = selector => document.querySelector(selector).getClientRects().length > 0; // an ancestor with display:none hides it
  assert(shown('.settings-nav') && !shown('.settings-main'), 'Settings opens its labeled list');
  assert([...document.querySelectorAll('.settings-nav md-list-item')].every(el => rect(el).height >= 44), 'Section rows are touch targets');
  click([...document.querySelectorAll('.settings-nav md-list-item')].find(el => el.textContent.includes('Внешний вид')));
  await wait();
  assert(location.hash === '#settings/appearance' && !shown('.settings-nav') && shown('.settings-main'), 'A section is its own screen with its own address');
  const body = document.querySelector('.settings-body');
  assert(rect(body).width >= innerWidth - 40 && body.scrollWidth <= body.clientWidth + 1, 'Settings detail must fit phone width');
  const main = document.querySelector('.settings-main');
  assert(main.scrollWidth <= main.clientWidth + 1, 'Settings detail has no sideways scroll');
  assert([...document.querySelectorAll('.theme-card, .choice-option')].every(el => rect(el).height >= 44), 'Theme and choice cards are touch targets');
  click(document.querySelector('.mobile-settings-header .ui-icon-button'));
  await wait(300);
  assert(location.hash === '#settings' && shown('.settings-nav') && !shown('.settings-main'), 'Back returns to settings list');
  document.querySelector('[data-settings-page]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(300);
  assert(!document.querySelector('[data-settings-page]') && !location.hash, 'Escape on the list leaves Settings');
  click(document.querySelector('.app-topbar .ui-icon-button'));
  await wait();
  click(nav('Матрицы'));
  await until(() => document.querySelector('[data-composer]'), 'Mobile lesson');
  assert(!document.querySelector('nav[data-sidebar]'), 'Choosing a lesson closes drawer');
  assert(!document.querySelector('main').inert, 'Lesson becomes interactive');
  const input = document.querySelector('[data-composer]');
  assert(document.activeElement !== input, 'Opening a lesson must not summon phone keyboard');
  const composer = rect(document.querySelector('.lesson-composer'));
  assert(composer.bottom <= innerHeight + 1, 'Composer must remain above viewport bottom');
  const message = document.querySelector('[role="log"] .md');
  assert(parseFloat(getComputedStyle(message).fontSize) >= 16, 'Reading text below 16px');
  assert(!document.querySelector('.panel-overlay') && !document.querySelector('[data-lesson-panel][data-mode="rail"]'), 'The rail steps aside on a phone and no panel overlay exists');
  assert(!document.querySelector('.session-bar [data-panel-toggle], .session-bar [data-canvas-toggle]'), 'No panel toggle in the session bar');
  await wait();
  assert(document.documentElement.scrollWidth <= innerWidth + 1, 'Page overflows horizontally');
  return { pass: true, checks: ['centered home', '44px controls', 'options fit', 'drawer', 'settings list/detail/back', 'lesson', '16px reading text', 'no panel on phone', 'no page overflow'] };
}
