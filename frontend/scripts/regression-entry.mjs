import { installMockBackend } from './mock-backend.mjs';

try {
  installMockBackend();
  const { initBackend } = await import('/src/lib/backend.ts');
  await initBackend();
  await import('/src/material.ts');
  await import('/src/index.css');
  import.meta.glob(['/src/styles/*.css', '!/src/styles/mobile.css'], { eager: true }); // feature stylesheets, as main.tsx loads them
  await import('/src/styles/mobile.css');
  const { initSettings } = await import('/src/lib/settings.ts');
  const { createElement, StrictMode } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { default: App } = await import('/src/App.tsx');
  initSettings();
  const root = createRoot(document.getElementById('root'));
  let appKey = 0;
  const renderApp = () => root.render(createElement(StrictMode, null, createElement(App, { key: appKey++ })));
  renderApp();
  // Study is hidden from navigation; exercise the preserved screen through its deep link.
  window.__openStudyForTest = () => {
    const previousHash = location.hash;
    location.hash = 'study';
    renderApp();
    return until(() => document.querySelector('[data-study-view]'), 'Study deep link opens')
      .finally(() => { history.replaceState(null, '', location.pathname + location.search + previousHash); });
  };
  const { runRegression, until } = await import('./ui-regression.mjs');
  const { runPanelRegression } = await import('./panel-regression.mjs');
  await until(() => document.querySelector('[data-home-goal]'), 'Application bootstrap');
  await document.fonts.ready;
  const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
  const { updateSettings } = await import('/src/lib/settings.ts');
  updateSettings({ theme });
  // ?only=widget (or only=present) runs the visuals suite alone (its checks do not depend on the page zoom of the browser)
  const only = new URLSearchParams(location.search).get('only');
  const ui = only ? null : await runRegression(theme);
  const panel = !only || only === 'panel' ? await runPanelRegression(theme) : null;
  const { runExplanationRegression } = await import('./explanation-regression.mjs');
  const explanation = !only || only === 'explanation' ? await runExplanationRegression() : null;
  const { runWidgetRegression } = await import('./widget-regression.mjs');
  // Feature suites: add one line per feature. `?only=<name>` runs just that suite (widget also runs sidebar).
  const features = {
    search: ['/scripts/search-regression.mjs', 'runSearchRegression', true],
    max: ['/scripts/max-ui-regression.mjs', 'runMaxUIRegression', true],
    mobile: ['/scripts/mobile-regression.mjs', 'runMobileRegression', true],
    usage: ['/scripts/usage-regression.mjs', 'runUsageRegression', true],
    skills: ['/scripts/skills-regression.mjs', 'runSkillsRegression', true],
    present: ['/scripts/present-regression.mjs', 'runPresentRegression', true],
    chat: ['/scripts/chat-regression.mjs', 'runChatRegression', true],
    input: ['/scripts/input-regression.mjs', 'runInputRegression', true],
    reliability: ['/scripts/reliability-regression.mjs', 'runReliabilityRegression', true],
    a11y: ['/scripts/a11y-regression.mjs', 'runA11yRegression', true],
    study: ['/scripts/study-regression.mjs', 'runStudyRegression', true],
    modes: ['/scripts/modes-regression.mjs', 'runModesRegression', true],
    memory: ['/scripts/memory-regression.mjs', 'runMemoryRegression', true],
    settings: ['/scripts/settings-regression.mjs', 'runSettingsRegression', true],
    palette: ['/scripts/palette-regression.mjs', 'runPaletteRegression', true],
  };
  const results = {};
  const wanted = (name) => !only || only === name;
  const widget = wanted('widget') || only === 'visual' ? await runWidgetRegression(theme) : null;
  const { runSidebarRegression } = await import('./sidebar-regression.mjs');
  const sidebar = wanted('widget') || wanted('sidebar') ? await runSidebarRegression() : null;
  for (const [name, [file, fn, withTheme]] of Object.entries(features)) {
    if (!wanted(name)) continue;
    const mod = await import(/* @vite-ignore */ file.replace('/scripts/', './'));
    results[name] = await mod[fn](withTheme ? theme : undefined);
  }
  window.__regressionResult = { pass: true, theme, viewport: [innerWidth, innerHeight], ui, panel, explanation, widget, sidebar, ...results };
  document.title = 'Graphy UI regression: PASS';
} catch (error) {
  window.__regressionResult = { pass: false, error: error.stack ?? String(error), viewport: [innerWidth, innerHeight] };
  document.title = 'Graphy UI regression: FAIL';
  console.error(error);
}
