// The method is a dropdown in the lesson composer; depth and layout are global agent settings.
import { click, wait, until, navigate } from './ui-regression.mjs';
const assert = (value, message) => { if (!value) throw Error(message); };
export async function runExplanationRegression() {
  const { getState } = await import('/src/lib/store.ts');
  await navigate('Матрицы');
  assert(!document.querySelector('.style-button'), 'The composer does not expose the explanation style');

  // Depth and layout: Settings > Agent, adaptive by default, one PATCH per change.
  await navigate('Настройки');
  await wait(400);
  click([...document.querySelectorAll('.settings-nav md-list-item')].find(e => e.getAttribute('aria-label') === 'Агент'));
  await until(() => document.querySelector('[aria-label^="Глубина объяснения"]'), 'Agent settings');
  const settingTrigger = label => document.querySelector(`.settings-body [aria-label="${label}"]`);
  assert(settingTrigger('Глубина объяснения').textContent.trim() === 'По ситуации', 'Depth is not adaptive by default');
  assert(settingTrigger('Оформление ответа').textContent.trim() === 'По ситуации', 'Layout is not adaptive by default');
  const patches = () => window.__mockBackend.requests.filter(r => r.method === 'PATCH' && r.path === '/settings');
  const pickSetting = async (label, option) => {
    click(settingTrigger(label));
    await wait(220);
    const item = [...document.querySelectorAll('[role=option]')].find(e => e.textContent.trim().startsWith(option));
    click(item);
    await wait(220);
  };
  const patched = patches().length;
  await pickSetting('Стиль объяснения', 'Сократический диалог');
  await pickSetting('Глубина объяснения', 'Кратко');
  await pickSetting('Оформление ответа', 'Разделы и списки');
  assert(patches().slice(patched).map(r => JSON.stringify(r.body)).join('|') ===
    '{"default_style":"socratic"}|{"explanation_depth":"brief"}|{"explanation_presentation":"structured"}', 'Settings are not sent independently');
  assert(settingTrigger('Глубина объяснения').textContent.trim() === 'Кратко' && settingTrigger('Оформление ответа').textContent.trim() === 'Разделы и списки', 'Settings did not reach the UI');
  await pickSetting('Стиль объяснения', 'Объяснение');
  await pickSetting('Глубина объяснения', 'По ситуации');
  await pickSetting('Оформление ответа', 'По ситуации');
  document.querySelector('[data-ui-dialog]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait();
  const lesson = getState().sessions['fixture-matrix'];
  return { pass: true, method: lesson.explanationStyle };
}
