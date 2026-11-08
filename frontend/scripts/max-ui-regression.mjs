import { assert, click, wait, until, navigate, closeDialog } from './ui-regression.mjs';

const setValue = (field, value) => {
  const prototype = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
};
const button = (label, root = document) => [...root.querySelectorAll('.ui-button')].find(el => el.querySelector('.ui-button-label')?.textContent.trim() === label);

/** Cross-component interactions affected by replacing web components with native React controls. */
export async function runMaxUIRegression(theme = 'dark') {
  const { getState, patchSession } = await import('/src/lib/store.ts');
  const { updateSettings } = await import('/src/lib/settings.ts');
  updateSettings({ theme, language: 'ru' });
  await navigate('Матрицы');
  const id = 'fixture-matrix';
  const area = document.querySelector('[data-composer]');
  assert(area instanceof HTMLTextAreaElement, 'Composer ref targets the native textarea');
  setValue(area, 'Черновик\nсо второй строкой');
  await until(() => getState().sessions[id].draft.includes('второй'), 'Native input updates draft');
  const before = area.getBoundingClientRect().height;
  setValue(area, 'Длинный черновик\n'.repeat(25));
  await wait();
  assert(area.getBoundingClientRect().height >= before && area.clientHeight <= 210, 'Textarea grows with a bounded scrolling height');
  patchSession(id, s => ({ ...s, chips: [{ id: 'ui-file', name: 'конспект.pdf', kind: 'file', path: '/fixture/notes.pdf', size: 100 }] }));
  await until(() => document.querySelector('.ui-chip-remove'), 'Attachment chip');
  click(document.querySelector('.ui-chip-remove'));
  await until(() => !getState().sessions[id].chips.length, 'Remove chip updates state');
  setValue(area, '/');
  await until(() => document.querySelector('[role=listbox]'), 'Slash commands');
  area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => document.querySelector('.ui-chip'), 'Command chip');
  click(document.querySelector('.ui-chip-remove'));
  await until(() => !document.querySelector('.ui-chip'), 'Command removal');
  setValue(area, '');

  // Searchable MAX Select: no matches, clearing and keyboard dismissal.
  const model = document.querySelector('.ui-toolbar-select [role=combobox]');
  click(model); await until(() => document.querySelector('.ui-menu-content input'), 'Model search opens');
  setValue(document.querySelector('.ui-menu-content input'), 'not-a-real-model'); await wait();
  assert(!document.querySelector('[role=option]'), 'Unmatched model search has no selectable rows');
  setValue(document.querySelector('.ui-menu-content input'), 'Fixture'); await wait();
  assert(document.querySelector('[role=option]'), 'Model search recovers');
  document.querySelector('.ui-menu-content input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await until(() => !document.querySelector('.ui-menu-content'), 'Select closes on Escape');

  await navigate('Настройки'); await wait();
  assert(document.querySelector('[data-settings-page]') && !document.getElementById('root').inert && !document.querySelector('[data-ui-dialog]'), 'Settings is a page: the app root is not inert');
  const appearance = [...document.querySelectorAll('.settings-nav md-list-item')].find(el => el.getAttribute('aria-label') === 'Внешний вид');
  click(appearance); await wait();
  const opposite = theme === 'dark' ? 'light' : 'dark';
  click(document.querySelector(`[role=radio][data-theme-card="${opposite}"]`));
  await until(() => document.documentElement.dataset.theme !== theme, 'Theme card changes root');
  assert(document.querySelector('[data-settings-page]'), 'Picking a theme does not leave Settings');
  updateSettings({ theme });
  await closeDialog();
  assert(!document.querySelector('[data-settings-page]') && !document.getElementById('root').inert, 'Leaving Settings restores app interaction');

  // First-run flow uses the same labels, progress, fields and buttons.
  await navigate('Настройки'); await wait();
  click([...document.querySelectorAll('.settings-nav md-list-item')].find(el => el.getAttribute('aria-label') === 'Общие')); await wait();
  click(button('Показать снова')); await until(() => document.querySelector('[aria-label="Первый запуск"]'), 'First-run opens');
  assert(document.querySelector('[aria-label="Шаги"]').getAttribute('aria-valuenow') === '50', 'Numeric progress reports first step');
  click(button('Далее')); await wait();
  assert(document.querySelector('[data-ui-dialog] h2').textContent === 'Выберите модель', 'Wizard model step');
  click(button('Назад')); await wait();
  click(button('Пропустить')); await until(() => !document.querySelector('[data-ui-dialog]'), 'Wizard closes');

  await navigate('Определитель');
  const form = () => document.querySelector('.question-form');
  click(form().querySelector('md-radio'));
  click(button('Далее', form())); await wait();
  const answer = form().querySelector('textarea[aria-label="Ваш ответ"]');
  assert(answer, 'Free text answer uses native MAX textarea');
  setValue(answer, 'Определитель равен единице');
  click(button('Далее', form())); await wait();
  click(button('Не знаю', form()));
  click(button('Далее', form())); await wait();
  click(button('Пропустить', form()));
  click(button('Далее', form())); await wait();
  click(form().querySelector('md-radio'));
  click(button('Обзор', form())); await wait();
  assert(form().textContent.includes('Определитель равен единице'), 'Review retains native textarea answer');
  click(button('Отправить ответы', form()));
  await until(() => window.__mockBackend.requests.some(r => r.path.endsWith('/questions/fixture-quiz/submit')), 'Quiz submits through API');
  await until(() => document.querySelector('[data-composer]'), 'Composer returns after quiz');
  assert(!window.__mockBackend.unexpected.length, 'No unexpected backend calls');
  return { pass: true, checks: ['native draft', 'autosize', 'attachment removal', 'slash command removal', 'model search', 'modal select', 'theme change', 'modal focus/restore', 'first-run steps', 'quiz answer/review/submit'] };
}
