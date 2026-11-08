import { assert, click, wait, until, navigate, closeDialog } from './ui-regression.mjs';

/** Verify the palette switch in Settings → Appearance: the choice, its persistence and the colours it applies. */
export async function runPaletteRegression(theme = 'dark') {
  const { updateSettings, getSettings } = await import('/src/lib/settings.ts');
  updateSettings({ theme, palette: 'graphy', language: 'ru' });
  await closeDialog();
  await navigate('Настройки');
  click([...document.querySelectorAll('.settings-nav md-list-item')].find(el => el.getAttribute('aria-label') === 'Внешний вид'));
  await wait();
  const group = document.querySelector('[role=radiogroup][aria-label="Цветовая палитра"]');
  assert(group, 'Palette choice is in Appearance');
  const graphy = [...group.querySelectorAll('[role=radio]')].find(el => el.dataset.value === 'graphy');
  const max = [...group.querySelectorAll('[role=radio]')].find(el => el.dataset.value === 'max');
  assert(graphy && max, 'Both palettes are offered');
  assert(graphy.getAttribute('aria-checked') === 'true' && max.getAttribute('aria-checked') === 'false', 'Graphy is the default choice');
  assert(getComputedStyle(document.documentElement).getPropertyValue('--md-sys-color-surface').trim() !== '#f1f2f4', 'Graphy surfaces are neutral');
  click(max);
  await until(() => getSettings().palette === 'max', 'MAX palette applied from settings');
  assert(document.documentElement.dataset.palette === 'max', 'The root carries the palette');
  assert(JSON.parse(localStorage.getItem('graphy-material-settings-v1')).palette === 'max', 'Palette persisted');

  const probe = document.createElement('div');
  document.body.append(probe);
  const color = (value, property = 'color') => {
    probe.style[property] = value;
    return getComputedStyle(probe)[property];
  };
  const checks = [];
  for (const mode of ['light', 'dark']) {
    updateSettings({ theme: mode, palette: 'max' });
    await wait();
    const accent = mode === 'light' ? 'rgb(0, 119, 255)' : 'rgb(26, 133, 255)';
    const selected = mode === 'light' ? 'rgb(229, 240, 255)' : 'rgb(45, 45, 54)';
    assert(color('var(--paper)') === color('var(--background-primary)'), `${mode}: page follows the MAX surface`);
    assert(color('var(--md-sys-color-primary)') === accent, `${mode}: Material accent uses the MAX blue`);
    assert(color('var(--ink)') === color('var(--text-primary)'), `${mode}: text follows the MAX ink`);
    assert(color('var(--md-sys-color-on-primary)') === 'rgb(255, 255, 255)', `${mode}: primary labels remain white`);
    assert(getComputedStyle(document.querySelector('.graphy-max-ui')).getPropertyValue('--button-primary').trim() === (mode === 'light' ? '#0077ff' : '#1a85ff'), `${mode}: MAX provider uses the MAX accent`);
    assert(color('var(--surface-selected)') === selected, `${mode}: the chosen row uses the MAX selection colour`);
    assert(color('var(--md-sys-color-primary)') !== color('var(--md-sys-color-surface)'), `${mode}: accent and surface stay apart`);
    checks.push(`${mode}: surfaces, ink, accent, provider, selection`);
  }

  updateSettings({ palette: 'graphy', theme });
  await wait();
  assert(document.documentElement.dataset.palette === 'graphy', 'Graphy palette restored');
  assert(color('var(--button-primary)') === color('var(--ink)'), 'Graphy MAX override restored');
  probe.remove();
  await closeDialog();
  return checks;
}
