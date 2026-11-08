// Modes: the switch in the composer, the quiz bar with its timer, and the per-topic report.
import { click, wait, until, navigate, closeDialog } from './ui-regression.mjs';
import { checkComposerPanel, checkModeMenu } from './composer-regression.mjs';
const assert = (value, message) => { if (!value) throw Error(message); };

export async function runModesRegression(theme = 'dark') {
  const { updateSettings } = await import('/src/lib/settings.ts');
  updateSettings({ language: 'ru', theme });
  const { getState } = await import('/src/lib/store.ts');
  const { clock, buildReport, secondsLeft, deadlineFor } = await import('/src/lib/mode-api.ts');
  await closeDialog();

  // pure helpers
  assert(clock(65) === '1:05' && clock(3725) === '1:02:05' && clock(-5) === '−0:05', 'The clock formats mm:ss');
  assert(secondsLeft(null) === null && secondsLeft(1000, 990_000) === 10, 'Seconds left');
  assert(deadlineFor({ mode: 'explain', kind: 'check', minutes: 30 }) === null && deadlineFor({ mode: 'quiz', kind: 'check', minutes: 0 }) === null, 'No deadline for learn or no timer');
  const rep = buildReport([
    { outcome: 'independent', topic_id: 's1', mode: 'quiz' }, { outcome: 'gap', topic_id: 's2', mode: 'quiz' },
    { outcome: 'gap', topic_id: 's2', mode: 'quiz' }, { outcome: 'independent', topic_id: 's2', mode: 'explain' },
  ], [{ id: 's1', title: 'Матрицы' }, { id: 's2', title: 'Определитель' }], 'Без темы');
  assert(rep.total === 3 && rep.independent === 1 && rep.gap === 2 && rep.fixFirst[0] === 'Определитель', 'Only quiz rows count; the weakest topic comes first');

  // weak topics of the study core come first; without them the quiz's own plan topics are used
  const weak = [{ topic: 'Обратная матрица' }, { topic: 'Обратная матрица' }];
  assert(buildReport([{ outcome: 'gap', topic_id: 's2', mode: 'quiz' }], [{ id: 's2', title: 'Определитель' }], 'Без темы', weak).fixFirst.join() === 'Обратная матрица', 'Study weak topics are the source');
  assert(buildReport([{ outcome: 'gap', topic_id: 's2', mode: 'quiz' }], [{ id: 's2', title: 'Определитель' }], 'Без темы', []).fixFirst.join() === 'Определитель', 'Fallback to plan topics');

  // the switch: learn by default, quiz after picking «Проверить себя»
  await navigate('Матрицы');
  await wait(300);
  await checkComposerPanel('lesson'); // the lesson uses the same panel as the first screen
  await checkModeMenu('lesson'); // at the bottom of the window its menu opens upward
  const trigger = () => document.querySelector('[data-mode-switch] .mode-button');
  const modePuts = () => window.__mockBackend.requests.filter(r => r.method === 'PUT' && r.path === '/sessions/fixture-matrix/mode');
  assert(trigger().textContent.trim() === 'Объяснение', 'Default mode is learn');
  assert(!document.querySelector('[data-quiz-bar]'), 'No quiz bar in learn mode');
  click(trigger());
  await wait(220);
  const items = [...document.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])')];
  assert(items.length === 3, 'The mode menu lists explain, check and mock exam');
  click(items.find(e => e.textContent.includes('Квиз')));
  await until(() => modePuts().length === 1, 'Picking the check saves the mode');
  assert(modePuts()[0].body.mode === 'quiz' && modePuts()[0].body.quiz_kind === 'check', 'The request names quiz and check');
  await until(() => getState().sessions['fixture-matrix'].mode === 'quiz', 'The mode reaches the UI state');
  await until(() => document.querySelector('[data-quiz-bar]'), 'The quiz bar appears');
  assert(!document.querySelector('[data-quiz-timer]'), 'No timer without a deadline');

  // timer: counts down; in a check the end only advises
  const { setSessionMode } = await import('/src/lib/mode-api.ts');
  await setSessionMode('fixture-matrix', { mode: 'quiz', kind: 'check', minutes: 15 });
  await until(() => document.querySelector('[data-quiz-timer]'), 'The timer appears with a deadline');
  const first = document.querySelector('[data-quiz-timer]').textContent;
  assert(/^1[45]:\d\d$/.test(first), `Timer shows the remaining time: ${first}`);
  await until(() => document.querySelector('[data-quiz-timer]').textContent !== first, 'The timer ticks', 2500);
  const sends = () => window.__mockBackend.requests.filter(r => r.method === 'POST' && r.path === '/sessions/fixture-matrix/messages').length;
  const messages = sends();
  const mock = window.__mockBackend.sessionRef('fixture-matrix');
  mock.deadline = Math.round(Date.now() / 1000) - 5;
  await setSessionMode('fixture-matrix', { mode: 'quiz', kind: 'check', minutes: 0 });
  window.__mockBackend.sessionRef('fixture-matrix').deadline = Math.round(Date.now() / 1000) - 5;
  const { mergeSession } = await import('/src/lib/store.ts');
  mergeSession('fixture-matrix', s => ({ ...s, deadline: Math.round(Date.now() / 1000) - 5 }));
  await until(() => document.querySelector('[data-quiz-late]'), 'A check past its deadline only says so');
  await wait(300);
  assert(sends() === messages, 'A check does not end itself when time is up');
  assert(document.querySelector('[data-quiz-timer]').textContent.startsWith('−'), 'Late time is negative');

  // report: per-topic result and a one-click lesson
  mock.learning.assessments = [
    { id: 'a1', question: 'q1', outcome: 'independent', feedback: '', used_hints: false, topic_id: 's1', mode: 'quiz' },
    { id: 'a2', question: 'q2', outcome: 'gap', feedback: '', used_hints: false, topic_id: 's2', mode: 'quiz' },
    { id: 'a3', question: 'q3', outcome: 'gap', feedback: '', used_hints: false, topic_id: 's2', mode: 'quiz' },
  ];
  click(document.querySelector('[data-quiz-results]'));
  await until(() => document.querySelector('[data-quiz-report]'), 'The report opens');
  assert(/Самостоятельно: 1 из 3/.test(document.querySelector('[data-quiz-score]').textContent), 'The score line');
  assert(document.querySelectorAll('.quiz-topic').length === 2, 'Two topics are listed');
  const learn = document.querySelector('[data-quiz-learn]');
  assert(learn && /Определитель/.test(learn.textContent), 'The weakest topic gets a learn button');
  const posts = () => window.__mockBackend.requests.filter(r => r.method === 'POST' && r.path === '/sessions').length;
  const before = posts();
  const dialog = document.querySelector('.quiz-popover');
  assert(dialog.getBoundingClientRect().right <= innerWidth + 1 && dialog.getBoundingClientRect().left >= 0, 'The report stays in the viewport');
  if (new URLSearchParams(location.search).has('shot')) return { shot: true }; // leave the report on screen for a screenshot
  click(learn);
  await until(() => posts() === before + 1, 'One click starts a learn session');
  mock.learning.assessments = [];
  return { topics: 2, timer: first };
}
