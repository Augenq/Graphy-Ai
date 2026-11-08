import { until, click, navigate, closeDialog } from './ui-regression.mjs';
const assert = (value, message) => { if (!value) throw Error(message); };
export async function runSkillsRegression() {
  await closeDialog();
  await navigate('Настройки');
  await until(() => [...document.querySelectorAll('.settings-nav md-list-item')].some(e => e.getAttribute('aria-label') === 'Навыки'), 'Skills settings navigation');
  click([...document.querySelectorAll('.settings-nav md-list-item')].find(e => e.getAttribute('aria-label') === 'Навыки'));
  await until(() => document.querySelectorAll('[data-skill]').length === 2, 'Project skills render');
  const view = document.querySelector('[data-skills-view]');
  assert(view.querySelector('[data-skill="socratic-tutor"]'), 'Project skill is shown');
  assert(!view.querySelector('[data-skill="ext-notes"], [data-catalog], [data-skill-create], button'), 'Other sources and unnecessary controls are absent');
  assert(!window.__mockBackend.requests.some(r => r.path === '/skills/catalog' || r.path === '/skills/library'), 'Catalog and mixed library are not requested');
  window.__oldSkillsBackend = true;
  const { listProjectSkills } = await import('/src/lib/skills-api.ts');
  const fallback = await listProjectSkills();
  assert(fallback.skills.length === 3 && !fallback.skills.some(s => s.name === 'ext-notes'), 'Older backend falls back to .graphy/skills only');
  window.__oldSkillsBackend = false;
  return { skills: 2, fallback: true };
}
