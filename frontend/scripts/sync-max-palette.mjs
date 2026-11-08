// Lift MAX's complete native color schemes onto html, including portals outside MaxUI.
// Run after updating @maxhub/max-ui: node scripts/sync-max-palette.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const css = readFileSync(new URL('../node_modules/@maxhub/max-ui/dist/styles.css', import.meta.url), 'utf8');
const version = JSON.parse(readFileSync(new URL('../node_modules/@maxhub/max-ui/package.json', import.meta.url))).version;
let output = `/* Generated from @maxhub/max-ui ${version}. Do not edit; run scripts/sync-max-palette.mjs.\n   Source: https://github.com/max-messenger/max-ui (MIT). */\n`;
for (const mode of ['light', 'dark']) {
  const body = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, selector, declarations]) => selector.includes(`MaxUI_colorScheme_${mode}__`) && declarations.includes('--background-primary:'))?.[2];
  if (!body) throw new Error(`MAX UI ${mode} scheme not found`);
  const root = `html[data-palette="max"][data-theme="${mode}"]`;
  output += `${root},\n${root} .graphy-max-ui,\n${root} .ui-menu-content {\n`;
  output += body.split(';').filter(Boolean).map(decl => `  ${decl};`).join('\n') + '\n}\n';
}
writeFileSync(new URL('../src/styles/max-palette-tokens.css', import.meta.url), output);
