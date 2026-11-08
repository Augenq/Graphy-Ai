// Strategy memory: the view lists plain-language observations, edits and deletes work, the strategy card shows its reason
// and version history with rollback, the switches reach the backend, errors are visible.
import { until, click, wait, closeDialog, navigate } from './ui-regression.mjs';
const assert = (value, message) => { if (!value) throw Error(message); };
const c = (el, line) => { assert(el, `memory-regression line ${line}: control is missing`); click(el); };
const q = (selector, root = document) => root.querySelector(selector);
const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
const setValue = (input, value) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); };

export async function runMemoryRegression(theme = 'dark') {
  const { updateSettings } = await import('/src/lib/settings.ts');
  const memory = await import('/src/lib/memory-api.ts');
  updateSettings({ language: 'ru', theme });
  await closeDialog();

  const profile = memory.describeProfile({ preferred_style: null, preferred_form: 'worked_example', hint_start: 'late', step_size: null, evidence: {} });
  assert(profile.length === 2 && profile[0].value === 'Разбор на примере', 'The profile is described in plain words and skips unknown fields');

  await navigate('Настройки');
  await until(() => qa('.settings-nav md-list-item').some(e => e.getAttribute('aria-label') === 'Память'), 'Memory settings navigation');
  c(qa('.settings-nav md-list-item').find(e => e.getAttribute('aria-label') === 'Память'), 20);
  await until(() => qa('[data-obs]').length === 4, 'Observations render');
  const view = q('[data-memory-view]');
  assert(view.textContent.includes('Объяснение через пример: задача решена без подсказок'), 'Observations read as plain Russian');
  assert(!/\d\s*%/.test(view.querySelector('[data-obs]').textContent), 'Observations carry no scores');

  // strategy card
  const card = q('[data-strategy]');
  assert(card.dataset.state === 'on' && /версия 2/.test(card.textContent), 'The strategy card shows the current version');
  assert(/Разбор на примере/.test(card.textContent) && /Почему так/.test(card.textContent) && /4 из 4 раз без подсказок/.test(card.textContent), 'The card says what and why');
  c(q('.memory-toggle', card), 30);
  await until(() => q('#memory-history'), 'History opens');
  assert(q('.memory-toggle', card).getAttribute('aria-expanded') === 'true', 'The toggle reports its state');
  assert(qa('[data-version-row]').length === 2, 'Every version is listed');
  c(q('[data-version-row="1"] button'), 34);
  await until(() => qa('[data-version-row]').length === 3, 'Rollback creates a new version');
  assert(/версия 3/.test(q('[data-strategy]').textContent) && /Откат к версии 1/.test(q('[data-strategy]').textContent) && /Аналогия/.test(q('.memory-profile').textContent), 'Rollback restores the old profile with a reason');
  assert(q('[role=status]', view)?.textContent.includes('версии 1'), 'Rollback is announced');

  // edit
  const first = q('[data-obs="obs-a0"]');
  c(q('[aria-label="Изменить"]', first), 41);
  await until(() => q('.memory-edit input', first), 'Edit form opens');
  setValue(q('.memory-edit input', first), 'Это было не про пример');
  c(q('.memory-edit button[type=submit]', first), 44);
  await until(() => q('[data-obs="obs-a0"]')?.dataset.status === 'edited', 'Edited entry is marked');
  assert(q('[data-obs="obs-a0"]').textContent.includes('Это было не про пример') && /не учитывается/.test(q('[data-obs="obs-a0"]').textContent), 'The edit is shown and flagged as not counted');
  const patch = window.__mockBackend.requests.find(r => r.method === 'PATCH' && r.path === '/memory/observations/obs-a0');
  assert(patch?.body.text === 'Это было не про пример', 'The edit reaches the backend');

  // why is this here
  c(q('[aria-label="Откуда это"]', q('[data-obs="obs-a1"]')), 51);
  await until(() => q('.memory-why', q('[data-obs="obs-a1"]')), 'The source explanation opens');

  // delete needs a confirmation
  const last = q('[data-obs="obs-a3"]');
  c(q('[aria-label="Удалить"]', last), 56);
  await until(() => q('.memory-confirm', last), 'Delete asks to confirm');
  c(qa('button', q('.memory-confirm', last)).find(b => b.textContent.trim() === 'Нет'), 58);
  await until(() => !q('.memory-confirm', last) && q('[data-obs="obs-a3"]'), 'Declining keeps the entry');
  c(q('[aria-label="Удалить"]', q('[data-obs="obs-a3"]')), 60);
  await until(() => q('.memory-confirm', q('[data-obs="obs-a3"]')), 'Delete asks again');
  c(qa('button', q('.memory-confirm', q('[data-obs="obs-a3"]'))).find(b => b.textContent.trim() === 'Удалить'), 61);
  await until(() => !q('[data-obs="obs-a3"]'), 'The deleted entry disappears');

  // grouping
  c(qa('.ui-segmented-list *', view).find(e => e.children.length === 0 && e.textContent.includes('По темам')), 65);
  await until(() => q('[data-group="Определитель"]'), 'Grouping by topic');

  // switches
  const adaptive = qa('md-switch', view)[0];
  adaptive.selected = false;
  adaptive.dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => q('[data-strategy]').dataset.state === 'off', 'Turning adaptation off shows in the card');
  assert(window.__mockBackend.requests.some(r => r.method === 'PUT' && r.path === '/memory/settings' && r.body.adaptive === false), 'The switch reaches the backend');
  assert(qa('md-switch', view).length === 1, 'Only adaptation is configurable');
  adaptive.selected = true;
  adaptive.dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => q('[data-strategy]').dataset.state === 'on', 'Adaptation back on');

  // an error is visible and retryable
  window.__memoryFail = true;
  c(qa('button', view).find(b => b.textContent.includes('Найти в прошлых занятиях')), 81);
  await until(() => q('.memory-error', view), 'A backend failure is shown');
  window.__memoryFail = false;
  c(q('.memory-error button', view), 84);
  await until(() => !q('.memory-error', view), 'Retry clears the error');

  // layout: nothing leaves the screen
  const box = q('.memory-scroll', view);
  assert(box.scrollWidth <= box.clientWidth + 1, 'No horizontal overflow');
  return { observations: qa('[data-obs]').length, versions: 3 };
}
