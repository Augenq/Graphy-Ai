// Browser runner for the isolated wire-format fixture server (npm run test:ui).
// Set GRAPHY_CDP_MODULE to another compatible CDP driver if needed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const { Browser } = await import(process.env.GRAPHY_CDP_MODULE ?? '/home/ig/.agents/skills/design-taste-frontend/scripts/lib/cdp.mjs');
const base = process.env.GRAPHY_TEST_URL ?? 'http://127.0.0.1:5186';
const out = resolve('../docs/max-ui-migration');
mkdirSync(`${out}/evidence`, { recursive: true });
const methods = { search: 'runSearchRegression', ui: 'runRegression', panel: 'runPanelRegression', explanation: 'runExplanationRegression', widget: 'runWidgetRegression', sidebar: 'runSidebarRegression', skills: 'runSkillsRegression', usage: 'runUsageRegression', present: 'runPresentRegression', chat: 'runChatRegression', max: 'runMaxUIRegression', mobile: 'runMobileRegression', palette: 'runPaletteRegression' };
const suites = process.env.GRAPHY_UI_SUITES?.split(',') ?? Object.keys(methods).filter(name => name !== 'mobile');
const cases = process.env.GRAPHY_UI_QUICK ? suites.map(name => [name, 1440, 'dark']) : [
  ...['dark', 'light'].flatMap(theme => suites.map(name => [name, 1440, theme])),
  ['max', 768, 'dark'], ['mobile', 390, 'dark'], ['mobile', 390, 'light'],
];
const browser = await Browser.launch();
const results = [];
try {
  for (const [suite, width, theme] of cases) {
    await browser.send('Storage.clearDataForOrigin', { origin: new URL(base).origin, storageTypes: 'all' });
    const page = await browser.newPage({ width, height: 900, mobile: width < 600 });
    try {
      await page.goto(`${base}/scripts/regression.html?only=preview&theme=${theme}`, { timeoutMs: 12000, settleMs: 500 });
      await page.eval(async () => {
        const deadline = Date.now() + 10000;
        while (!document.querySelector('main')) {
          if (Date.now() > deadline) throw Error('Application did not finish bootstrapping: ' + document.body.innerText.slice(0, 200));
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      });
      const result = await page.eval(async ({ suite, method, theme }) => {
        try {
          const mod = await import(`/scripts/${suite === 'max' ? 'max-ui' : suite}-regression.mjs`);
          return { pass: true, details: await mod[method](theme) };
        } catch (error) { return { pass: false, error: error.stack ?? String(error) }; }
      }, { suite, method: methods[suite], theme });
      result.suite = suite; result.width = width; result.theme = theme;
      result.consoleErrors = page.consoleErrors;
      if (page.consoleErrors.length) result.pass = false;
      results.push(result);
      console.log(JSON.stringify(result));
      if (!result.pass) await page.screenshot({ path: `${out}/evidence/failure-${suite}-${width}-${theme}.jpg` });
    } catch (error) {
      const result = { suite, width, theme, pass: false, error: error.stack ?? String(error) };
      results.push(result); console.log(JSON.stringify(result));
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
writeFileSync(`${out}/validation.json`, JSON.stringify({ date: new Date().toISOString(), base, pass: results.every(result => result.pass), results }, null, 2) + '\n');
if (results.some(result => !result.pass)) process.exitCode = 1;
