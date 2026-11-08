// Study: calendar with review counts and events, the «Что повторить» list, the task bank with filters and the
// learner's own marks. Wording stays calm: nothing says «просрочено» and nothing counts days in a row.
import { until, click, closeDialog } from './ui-regression.mjs';
const assert = (value, message) => { if (!value) throw Error(message); };
const q = (selector, root = document) => root.querySelector(selector);
const qa = (selector, root = document) => (root ? [...root.querySelectorAll(selector)] : []);
const typeInto = (input, value) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

export async function runStudyRegression(theme = 'dark') {
  const { updateSettings } = await import('/src/lib/settings.ts');
  const study = await import('/src/lib/study-api.ts');
  updateSettings({ language: 'ru', theme });
  await closeDialog();

  // --- pure helpers ---
  const grid = study.monthGrid(2026, 10);
  assert(grid.length === 42 && grid[0].date === '2026-10-26' && grid.find(c => c.inMonth).date === '2026-11-01', 'The month grid starts on Monday and flags the days of other months');
  assert(study.dueText(null, 0) === 'Без напоминания' && study.dueText(10, 20) === 'Пора освежить' && /^Через 3 дня$/.test(study.dueText(3 * 86400 + 5, 0)), 'Due wording is calm and plural-aware');
  assert(study.days(1) === '1 день' && study.days(2) === '2 дня' && study.days(5) === '5 дней', 'Russian plurals of days');

  // --- the hidden section remains available through its deep link ---
  if (!q('nav[data-sidebar]')) click(qa('.ui-icon-button').find(e => e.getAttribute('aria-label') === 'Показать боковую панель'));
  assert(!q('[data-study-nav]'), 'Study navigation is hidden');
  await window.__openStudyForTest();
  await until(() => q('[data-study-view] [data-calendar]'), 'The calendar renders');
  const view = q('[data-study-view]');
  assert(qa('[role=tab]', view).length === 3, 'Three tabs: calendar, review, bank');

  // --- calendar ---
  await until(() => qa('.study-cell', view).length === 42, '42 day cells');
  await until(() => q('.study-cell[data-today] .study-mark-review'), 'Today carries the number of reviews ready to refresh');
  const todayCell = q('.study-cell[data-today]', view);
  assert(todayCell.getAttribute('aria-label').includes('к повторению'), 'The cell label says what is planned, for screen readers');
  await until(() => q('[data-exam]', view), 'The exam countdown is shown');
  assert(/дн/.test(q('[data-exam] .study-count-days', view).textContent), 'The countdown counts days');
  assert(!/просроч|серия|подряд/i.test(view.textContent), 'No guilt or streak wording on the calendar');
  click(todayCell);
  await until(() => q('[data-day-panel]')?.textContent.includes('Пора освежить'), 'The day panel lists the topics to refresh');
  const form = q('.study-form', view);
  const title = q('input[aria-label="Название события"]', form);
  typeInto(title, 'Контрольная по матрицам');
  click(qa('.study-kind', form).find(b => b.textContent === 'Занятие'));
  await until(() => !q('.study-form button[type=submit]', view).disabled, 'The add button enables with a title');
  const before = window.__mockBackend.requests.length;
  q('.study-form button[type=submit]', view).click();
  await until(() => window.__mockBackend.requests.slice(before).some(r => r.method === 'POST' && r.path === '/study/events' && r.body.kind === 'session' && r.body.title === 'Контрольная по матрицам'), 'A planned session is created');
  await until(() => qa('.study-event', view).some(e => e.textContent.includes('Контрольная по матрицам')), 'The new event appears in the day panel');
  click(q('.study-event [aria-label^="Удалить событие"]', view));
  await until(() => !qa('.study-event', view).some(e => e.textContent.includes('Контрольная')), 'The event can be deleted');
  click(qa('button', view).find(b => b.getAttribute('aria-label') === 'Следующий месяц'));
  await until(() => !q('.study-cell[data-today]', view), 'Next month does not show today');
  click(qa('button', view).find(b => b.textContent === 'Сегодня'));
  await until(() => q('.study-cell[data-today]', view), 'Today button comes back');
  const shot = { calendar: view.getBoundingClientRect().width };
  const stop = new URLSearchParams(location.search).get('shot'); // ?shot=calendar|review leaves that screen open for a visual check
  if (stop === 'calendar') return shot;

  // --- what to review ---
  click(qa('[role=tab]', view)[1]);
  await until(() => q('[data-review]', view), 'The review list renders');
  assert(qa('.study-topic', view).length === 2 && qa('.study-row', view).length === 2, 'Two weak topics and two tasks are ready to refresh');
  assert(qa('.study-chip[data-outcome=with_hints]', view).length === 1, 'A task solved with hints is marked as such, not as success');
  assert(!/просроч|серия|подряд/i.test(view.textContent), 'No guilt wording in the review list');
  if (stop === 'review') return shot;
  const sessionsBefore = window.__mockBackend.requests.length;
  click(q('[data-review-start]', view));
  await until(() => window.__mockBackend.requests.slice(sessionsBefore).some(r => r.method === 'POST' && r.path === '/study/review/next'), 'Review asks the backend which tasks to repeat');
  await until(() => window.__mockBackend.requests.slice(sessionsBefore).some(r => r.method === 'POST' && r.path === '/sessions'), 'A normal lesson is created for the review');
  await until(() => !q('[data-study-view]'), 'The review lesson opens');

  // --- bank ---
  if (!q('nav[data-sidebar]')) click(qa('.ui-icon-button').find(e => e.getAttribute('aria-label') === 'Показать боковую панель'));
  await window.__openStudyForTest();
  await until(() => q('[data-study-view]'), 'Back to study');
  click(qa('[role=tab]', q('[data-study-view]'))[2]);
  const bank = () => q('[data-bank]');
  await until(() => qa('.study-card', bank()).length === 4, 'The bank lists four tasks');
  assert(qa('.study-select', bank()).length >= 3, 'Filters by topic, result, error type and state');
  const outcome = q('select[aria-label="Результат"]', bank());
  outcome.value = 'with_hints';
  outcome.dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => qa('.study-card', bank()).length === 1, 'The result filter narrows the list');
  outcome.value = '';
  outcome.dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => qa('.study-card', bank()).length === 4, 'The filter resets');
  typeInto(q('input[type=search]', bank()), 'ранг');
  await until(() => qa('.study-card', bank()).length === 1, 'Search narrows the list');
  typeInto(q('input[type=search]', bank()), '');
  await until(() => qa('.study-card', bank()).length === 4, 'Search clears');
  const card = qa('.study-card', bank())[0];
  click(q('.study-card-q', card));
  await until(() => q('.study-detail', card), 'A task opens with the answer and feedback');
  typeInto(q('input[aria-label="Новая метка"]', card), 'экзамен');
  q('.study-detail form button[type=submit]', card).click();
  await until(() => qa('.study-tag', bank()).some(x => x.textContent.includes('экзамен')), 'A tag is added');
  const first = qa('.study-card', bank())[0];
  click(qa('button', first).find(b => b.textContent === 'Отложить'));
  await until(() => qa('.study-card', bank()).length === 3, 'A paused task leaves the active list');
  click(qa('button', qa('.study-card', bank())[0]).find(b => b.textContent === 'Удалить'));
  await until(() => qa('button', bank()).some(b => b.textContent === 'Убрать'), 'Delete asks for confirmation first');
  click(qa('button', bank()).find(b => b.textContent === 'Убрать'));
  await until(() => qa('.study-card', bank()).length === 2, 'A removed task disappears');
  assert(!window.__mockBackend.unexpected?.length, 'Nothing left the fixture backend');
  return { calendarWidth: shot.calendar, cells: 42 };
}
