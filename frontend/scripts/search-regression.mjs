import { assert, click, wait, until, navigate, closeDialog } from './ui-regression.mjs';
const set = (el, value) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const clear = async field => {
  const control = field.closest('.ui-field').querySelector('[aria-label="Очистить"]');
  assert(control, 'Search exposes a clear control'); click(control); await wait();
  assert(field.value === '', 'Clear updates controlled search value');
};
const anchored = trigger => {
  const panel = document.querySelector('.ui-menu-content');
  assert(panel, 'Popup exists');
  const t = trigger.getBoundingClientRect(), p = panel.getBoundingClientRect();
  const gap = Math.min(Math.abs(p.top - t.bottom), Math.abs(p.bottom - t.top));
  assert(gap <= 12, `Popup vertical offset is ${gap}px`);
  assert(Math.min(Math.abs(p.left - t.left), Math.abs(p.right - t.right)) <= 3, `Popup is horizontally displaced (${p.left}, ${t.left})`);
  assert(p.left >= -1 && p.right <= innerWidth + 1 && p.top >= -1 && p.bottom <= innerHeight + 1, 'Popup remains in viewport');
};
export async function runSearchRegression(theme = 'dark') {
  const { updateSettings } = await import('/src/lib/settings.ts'); updateSettings({ theme, language: 'ru' });
  await navigate('Настройки'); await wait();
  const settings = document.querySelector('input[aria-label="Поиск по настройкам"]');
  set(settings, 'nothing-matches-this'); await wait();
  assert(document.querySelector('.settings-nav').textContent.includes('Ничего не найдено'), 'Settings empty search');
  await clear(settings);
  assert(document.querySelectorAll('.settings-nav md-list-item').length === 10, 'Settings clear restores sections');
  set(settings, 'ширина'); await wait();
  click(document.querySelector('.settings-nav [aria-label="Результаты поиска"] button')); await wait();
  assert(settings.value === '' && document.querySelector('.settings-body').textContent.includes('Ширина колонки'), 'Settings hit opens its section');
  // the theme, size and width are radio choices now (settings-regression); the dropdowns left are the agent's
  click(document.querySelector('.settings-nav md-list-item[data-section="agent"]')); await until(() => document.querySelector('[role=combobox][aria-label="Стиль объяснения"]'), 'Agent section');
  for (const label of ['Стиль объяснения', 'Глубина объяснения', 'Оформление ответа']) {
    const field = document.querySelector(`[role=combobox][aria-label="${label}"]`);
    click(field); await wait(); anchored(field);
    document.querySelector('.ui-menu-content').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait();
    assert(document.querySelector('[data-settings-page]'), 'Escape closes the dropdown before the page');
  }
  await closeDialog();
  await navigate('Поиск'); await wait();
  const palette = document.querySelector('.palette-search input');
  set(palette, 'Карта знаний'); await wait();
  assert(!document.querySelector('.search-result'), 'Removed knowledge map is not offered as a search action');
  set(palette, 'nothing-matches-this'); await wait();
  assert(document.querySelector('.palette-results').textContent.includes('Ничего не найдено'), 'Lesson search empty state');
  await clear(palette);
  set(palette, 'Матрицы'); await wait();
  assert(document.querySelector('.search-result'), 'Lesson search filters');
  palette.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait();
  assert(!document.querySelector('[data-ui-dialog]'), 'Escape closes search even though its results are a listbox');
  await navigate('Настройки');
  // Material moves aria-label off the host (data-aria-label), so an attribute selector on it never matches: the section is addressed by data-section
  await until(() => document.querySelector('.settings-nav md-list-item[data-section="skills"]'), 'Skills settings section');
  click(document.querySelector('.settings-nav md-list-item[data-section="skills"]')); await until(() => document.querySelectorAll('[data-skill]').length, 'Skills');
  const skills = document.querySelector('.skills-search input');
  if (skills) {
    set(skills, 'nothing-matches-this'); await wait();
    assert(document.querySelector('.skills-empty'), 'Skills empty search');
    await clear(skills); assert(document.querySelectorAll('[data-skill]').length, 'Skills clear restores cards');
  } else assert(document.querySelector('[data-skills-view] [role=list]'), 'Project skills list renders');
  await closeDialog();
  await navigate('Новое занятие');
  const model = document.querySelector('.ui-toolbar-select [role=combobox]');
  click(model); await wait(); anchored(model);
  const filter = document.querySelector('.ui-menu-content input');
  set(filter, 'missing'); await wait(); assert(!document.querySelector('[role=option]'), 'Model empty search');
  set(filter, 'Fixture'); await wait(); assert(document.querySelector('[role=option]'), 'Model search recovers');
  click(document.querySelector('[role=option]')); await wait(); assert(!document.querySelector('.ui-menu-content'), 'Selecting a model closes search');
  assert(!window.__mockBackend.unexpected.length, 'No unexpected backend calls');
  return { pass: true, checks: ['settings search/clear/navigation', 'three anchored settings dropdowns', 'palette search/clear/Escape', 'current skills view', 'anchored model search/selection'] };
}
