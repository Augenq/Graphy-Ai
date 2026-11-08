// The shared input panel (components/ComposerPanel.tsx): two layers, a quiet tray with the mode, the model
// control with reasoning, the send button states, the mode menu, the placement of menus.
// Targets are on-screen px: the page zoom (1.1 on a desktop, 1 on a phone) is not visible in computed styles,
// so sizes come from getBoundingClientRect.
import { until, wait, click } from './ui-regression.mjs';
const assert = (value, message) => { if (!value) throw Error(message); };
const q = (selector, root = document) => root.querySelector(selector);
const rect = el => el.getBoundingClientRect();
const pixel = color => { const c = document.createElement('canvas'); c.width = c.height = 1; const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = color; x.fillRect(0, 0, 1, 1); return [...x.getImageData(0, 0, 1, 1).data]; };
const luminance = color => { const [r, g, b] = pixel(color); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const transparent = color => /rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\)|transparent/.test(color);
const setText = (el, value) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); };
const esc = () => q('.ui-menu-content')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
const closeMenus = async () => { esc(); await until(() => !q('.ui-menu-content'), 'The menu closes on Escape'); };
const fieldOf = variant => q(variant === 'home' ? '[data-home-goal]' : '[data-composer]');

/** Two layers, shared by the first screen and the lesson; quiet send; the mode is visible, model and effort fold. */
export async function checkComposerPanel(variant) {
  const panels = document.querySelectorAll('[data-composer-panel]');
  assert(panels.length === 1 && panels[0].dataset.variant === variant, `${variant}: exactly one shared input panel (ComposerPanel) is on screen`);
  const panel = panels[0];
  const surface = q('.composer-surface', panel), tray = q('.composer-tray', panel), toolbar = q('.composer-toolbar', panel);
  assert(surface && tray && toolbar && surface.nextElementSibling === tray, `${variant}: the field is followed by its tray`);

  // 1. two layers: the same width, the tray tucked under the field and rounded at the bottom, the field lighter in both themes
  const s = rect(surface), t = rect(tray);
  assert(Math.abs(s.left - t.left) < 1 && Math.abs(s.right - t.right) < 1, `${variant}: the tray has the width of the field`);
  assert(t.top < s.bottom - 8 && t.bottom > s.bottom + 26 && t.bottom - s.bottom <= 42, `${variant}: the tray is tucked under the field and shows ~30-40px (${(t.bottom - s.bottom).toFixed(1)})`);
  assert(parseFloat(getComputedStyle(tray).borderBottomLeftRadius) >= 16 && parseFloat(getComputedStyle(surface).borderTopLeftRadius) >= 16, `${variant}: rounded corners`);
  const fieldBg = getComputedStyle(surface).backgroundColor, trayBg = getComputedStyle(tray).backgroundColor;
  assert(!transparent(fieldBg) && !transparent(trayBg) && luminance(fieldBg) > luminance(trayBg) + 3, `${variant}: the field is lighter than the tray (${fieldBg} / ${trayBg})`);
  assert(luminance(fieldBg) > luminance(getComputedStyle(document.body).backgroundColor) - 1 || document.documentElement.dataset.theme === 'dark', `${variant}: the field is not darker than the page in the light theme`);
  const shadow = getComputedStyle(surface).boxShadow;
  assert(shadow !== 'none' && /0px 0px 0px 1px/.test(shadow), `${variant}: the field has a clear 1px ring and a shadow (${shadow})`);
  assert(/height/.test(getComputedStyle(fieldOf(variant)).transitionProperty) && getComputedStyle(fieldOf(variant)).transitionDuration.split(',')[0].trim() === '0.15s', `${variant}: the field height changes smoothly (150ms)`);

  // 2. the toolbar: attach, model, voice, send. No mode or reasoning in it
  assert(q('[data-attach], .composer-attach button', toolbar) && q('.model-control [role=combobox]', toolbar) && q('.voice-button', toolbar) && q('.send-button', toolbar), `${variant}: the toolbar holds attach, model, voice and send`);
  assert(!q('.mode-switch, .reasoning-button', toolbar), `${variant}: the mode does not sit in the toolbar`);
  assert(q('.mode-button', tray), `${variant}: the mode is visible in the tray`);
  const mode = q('.mode-button', tray);
  assert(mode.textContent.trim() === 'Объяснение' && q('svg.graphy-icon', mode), `${variant}: the chosen mode (icon and name) is visible in the closed control`);

  // 3. quiet send: a ring while there is nothing to send, a fill (eased) once there is
  const send = q('.send-button', toolbar), voice = q('.voice-button', toolbar), field = fieldOf(variant);
  assert(Math.abs(rect(send).width - rect(send).height) < 1 && getComputedStyle(send).borderRadius !== '0px', `${variant}: send is a round button`);
  setText(field, ''); await wait(300);
  assert(send.disabled && transparent(getComputedStyle(send).backgroundColor) && /rgb/.test(getComputedStyle(send).boxShadow), `${variant}: an empty field gives a ring without a fill`);
  assert(transparent(getComputedStyle(voice).backgroundColor), `${variant}: voice is a plain icon without a fill`);
  assert(/background-color/.test(getComputedStyle(send).transitionProperty) && parseFloat(getComputedStyle(send).transitionDuration) >= 0.15, `${variant}: the fill is eased`);
  setText(field, 'Разобрать матрицы'); await wait(450);
  assert(!send.disabled && !transparent(getComputedStyle(send).backgroundColor) && send.hasAttribute('data-ready'), `${variant}: something to send fills the button`);
  // the height follows the text
  const before = rect(field).height;
  setText(field, Array.from({ length: 7 }, (_, i) => `строка ${i + 1}`).join('\n')); await wait(400);
  assert(rect(field).height > before + 20, `${variant}: the field grows with its text (${before.toFixed(0)} -> ${rect(field).height.toFixed(0)})`);
  setText(field, ''); await wait(300);
  assert(rect(field).height <= before + 1, `${variant}: and shrinks back`);

  // 4. the model control: name, an explicit non-default effort, levels inside the panel
  const combo = q('.model-control [role=combobox]', toolbar);
  assert(!q('[data-effort]', combo), `${variant}: the plain «off» is not spelled out`);
  click(combo);
  await until(() => q('.ui-menu-content .model-panel'), `${variant}: the model panel opens`);
  const panel2 = q('.ui-menu-content');
  assert(q('input', panel2) && q('[role=option]', panel2), `${variant}: the panel has a search and the models`);
  const radios = [...panel2.querySelectorAll('[role=radio]')];
  assert(radios.length >= 2 && radios.filter(r => r.getAttribute('aria-checked') === 'true').length === 1, `${variant}: the reasoning levels are a radio group with one chosen`);
  assert(rect(panel2).left >= 0 && rect(panel2).right <= innerWidth && rect(panel2).top >= 0 && rect(panel2).bottom <= innerHeight, `${variant}: the model panel fits the viewport`);
  if (variant === 'home') {
    const high = radios.find(r => r.textContent.includes('Высокое'));
    click(high); await wait(200);
    assert(q('[data-effort]', combo)?.textContent === 'Высокое', `${variant}: a non-default effort is shown in the closed control`);
    click(radios.find(r => r.textContent.includes('Без рассуждений'))); await wait(200);
    assert(!q('[data-effort]', combo), `${variant}: back to «off»: the control is plain again`);
  }
  await closeMenus();
  await until(() => document.activeElement === combo, `${variant}: focus returns to the model control`);
  return true;
}

/** The mode menu: rows of 52-60 with an icon of 20-22, a description and a mark; fits the viewport; keyboard; opens upward in the lesson. */
export async function checkModeMenu(variant) {
  const trigger = q('[data-composer-panel] .mode-button');
  click(trigger);
  await until(() => q('.ui-menu-content'), `${variant}: the mode menu opens`);
  await wait(250);
  const menu = q('.ui-menu-content'), mr = rect(menu);
  const items = [...menu.querySelectorAll('[role=menuitem]')].filter(e => e.getAttribute('aria-disabled') !== 'true');
  assert(items.length === 3, `${variant}: the mode menu lists explain, check and mock exam`);
  for (const item of items) {
    const h = rect(item).height, icon = rect(item.querySelector('svg.graphy-icon'));
    assert(h >= 52 && h <= 60, `${variant}: a mode row is 52-60 on screen (${item.textContent.slice(0, 12)}: ${h.toFixed(1)})`);
    assert(icon.width >= 20 && icon.width <= 22.5, `${variant}: the mode icon is 20-22 (${icon.width.toFixed(1)})`);
    assert(item.querySelector('.ui-menu-title')?.textContent.trim() && item.querySelector('.ui-menu-description')?.textContent.trim(), `${variant}: a row has a name and a description`);
  }
  const checked = items.filter(i => i.querySelector('.ui-menu-check'));
  assert(checked.length === 1 && checked[0].textContent.includes('Объяснение'), `${variant}: the chosen mode carries a tick`);
  assert(!transparent(getComputedStyle(checked[0]).backgroundColor) && transparent(getComputedStyle(items.find(i => i !== checked[0])).backgroundColor), `${variant}: the chosen row is tinted, the others are not`);
  assert(new Set(items.map(i => i.querySelector('svg.graphy-icon').innerHTML)).size === 3, `${variant}: three different icons`);
  assert(mr.left >= 0 && mr.right <= innerWidth && mr.top >= 0 && mr.bottom <= innerHeight, `${variant}: the mode menu fits the viewport`);
  const tr = rect(trigger);
  const room = { below: innerHeight - tr.bottom, above: tr.top };
  if (room.below < mr.height + 12) assert(mr.bottom <= tr.top + 2, `${variant}: with no room below the menu opens upward`);
  else assert(mr.top >= tr.bottom - 2, `${variant}: with room below the menu opens under the control`);
  assert(trigger.getAttribute('aria-expanded') === 'true', `${variant}: the open control says so`);
  // keyboard: arrows move between rows, Escape closes and returns the focus
  menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await wait(150);
  assert(document.activeElement?.getAttribute('role') === 'menuitem', `${variant}: arrows move to the rows`);
  await closeMenus();
  await until(() => document.activeElement === trigger, `${variant}: focus returns to the mode control`);
  return true;
}

/** A quiz brings its timer next to the mode, in the tray: the send button does not move. */
export async function checkTimer() {
  const trigger = q('[data-composer-panel] .mode-button'), send = q('[data-composer-panel] .send-button');
  assert(!q('.mode-timer-button'), 'No timer beside the learning mode');
  const before = rect(send);
  click(trigger); await until(() => q('.ui-menu-content'), 'The mode menu opens');
  click([...document.querySelectorAll('.ui-menu-content [role=menuitem]')].find(e => e.textContent.includes('Квиз')));
  await until(() => q('[data-composer-panel] .mode-timer-button'), 'The timer appears');
  await wait(300);
  const timer = q('[data-composer-panel] .mode-timer-button'), after = rect(send);
  assert(timer.closest('.composer-tray') && !timer.closest('.composer-toolbar'), 'The timer sits in the tray, not in the toolbar');
  assert(trigger.textContent.includes('Квиз') && q('svg.graphy-icon', trigger), 'The chosen quiz mode is visible in the closed control');
  assert(Math.abs(before.left - after.left) < 0.5 && Math.abs(before.top - after.top) < 0.5, 'The timer does not move the send button');
  assert(rect(timer).left >= rect(trigger).right - 1 && Math.abs(rect(timer).top + rect(timer).height / 2 - rect(trigger).top - rect(trigger).height / 2) < 1, 'The timer stands right beside the mode');
  click(trigger); await until(() => q('.ui-menu-content'), 'The mode menu opens again');
  click([...document.querySelectorAll('.ui-menu-content [role=menuitem]')].find(e => e.textContent.includes('Объяснение')));
  await until(() => !q('.mode-timer-button'), 'The timer goes with the quiz');
  return true;
}

