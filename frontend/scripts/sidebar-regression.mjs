// The «…» menu of sidebar rows: rename and delete for lessons, long names are cut.
import { until, wait, navigate } from './ui-regression.mjs';
const assert = (value, message) => { if (!value) throw Error(message); };

export async function runSidebarRegression() {
  const { getState } = await import('/src/lib/store.ts');
  const { getRemote } = await import('/src/lib/remote.ts');
  await navigate('Матрицы');
  assert(!document.querySelector('nav[data-sidebar] .sidebar-delete svg[aria-label*="Корзин"]'), 'No trash can');
  const row = title => [...document.querySelectorAll('nav[data-sidebar] md-list-item')].find(e => e.querySelector('[slot=headline]')?.textContent === title);
  const open = async item => {
    item.querySelector('.sidebar-delete').click();
    await wait(300);
    return [...document.querySelectorAll('[role=menuitem]')];
  };
  const dialogField = () => document.querySelector('[data-ui-dialog] :is(.ui-field input, .ui-field textarea)');

  // lesson: the menu offers rename and delete, opening it does not open the row
  const before = getState().activeId;
  let items = await open(row('Определитель'));
  assert(items.map(i => i.textContent.trim()).join('|').includes('Переименовать') && items.some(i => i.textContent.includes('Удалить')), 'Menu must offer rename and delete');
  assert(getState().activeId === before, 'Opening the menu must not open the lesson');
  items.find(i => i.textContent.includes('Переименовать')).click();
  await until(dialogField, 'Rename dialog opens');
  const field = dialogField();
  field.value = 'Определитель 2×2';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(100);
  dialogField().closest('[data-ui-dialog]').querySelector('.ui-button[data-variant=primary]').click();
  assert(getState().activeId === before, 'Choosing a menu item must not open the lesson');
  await until(() => getState().sessions['fixture-det'].title === 'Определитель 2×2', 'Lesson title changes');
  await until(() => !document.querySelector('[data-ui-dialog]'), 'Dialog closes');

  // «Новое занятие» must not cost the draft of the lesson that is open; the input of the first screen takes focus
  const { patchSession } = await import('/src/lib/store.ts');
  await navigate('Матрицы');
  patchSession('fixture-matrix', s => ({ ...s, draft: 'черновик до нового занятия' }));
  await wait(100);
  await navigate('Новое занятие');
  await until(() => document.querySelector('[data-home-goal]'), 'The first screen opens');
  assert(document.activeElement === document.querySelector('[data-home-goal]'), 'The new lesson focuses its input');
  assert(getState().sessions['fixture-matrix'].draft === 'черновик до нового занятия', 'The draft of the open lesson survives «New lesson»');
  await navigate('Матрицы');
  await until(() => document.querySelector('[data-composer]'), 'The lesson reopens');
  assert(getState().sessions['fixture-matrix'].draft === 'черновик до нового занятия', 'The draft is still there when the lesson is reopened');
  // no sideways scroll in the sidebar, whatever the tooltips of the controls at its right edge
  const list = document.querySelector('nav[data-sidebar] .scroll-y');
  assert(list.scrollWidth <= list.clientWidth, 'The sidebar list must not scroll sideways');
  const tip = document.querySelector('nav[data-sidebar] .tip-label');
  assert(tip.getBoundingClientRect().right <= document.querySelector('nav[data-sidebar]').getBoundingClientRect().right + 1, 'Tooltips of the sidebar grow inward');
  const lessonRow = row('Матрицы');
  assert(lessonRow.getAttribute('title')?.startsWith('Матрицы'), 'A lesson row carries its full title as a tooltip');
  return { renamed: true, draftKept: true };
}
