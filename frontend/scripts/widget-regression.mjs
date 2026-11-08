// Visuals the agent draws: a sandboxed frame for a good call, nothing for a failed one, the same after a reload.
import { until, navigate } from './ui-regression.mjs';
const assert = (value, message) => { if (!value) throw Error(message); };

export async function runWidgetRegression(theme = 'dark') {
  const { updateSettings } = await import('/src/lib/settings.ts');
  updateSettings({ language: 'ru', theme });
  const { getState } = await import('/src/lib/store.ts');
  const { transcriptBlocks, widgetFromCall } = await import('/src/lib/wire.ts');
  const { widgetDocument, widgetFragment, staticWidgetImage } = await import('/src/lib/widget-doc.ts');
  await navigate('Матрицы');
  const frames = () => [...document.querySelectorAll('iframe.widget-frame')];
  const before = frames().length;
  window.__mockBackend.emitWidget();
  await until(() => frames().length === before + 1, 'The widget frame appears');
  const frame = frames().at(-1);
  const blocks = getState().sessions['fixture-matrix'].blocks;
  assert(blocks.filter(b => b.kind === 'widget').length === 1, 'Only the successful show_widget call draws a picture');
  assert(!blocks.some(b => b.kind === 'action' && /read_me|show_widget/.test(b.title)), 'Setup and picture calls must not add tool rows');
  const sandbox = frame.getAttribute('sandbox') ?? '';
  assert(sandbox === 'allow-scripts', `The sandbox must allow scripts only, got "${sandbox}"`);
  assert(frame.getAttribute('srcdoc').includes('Content-Security-Policy'), 'The widget page must carry its CSP');
  await until(() => frame.getBoundingClientRect().height > 100, 'The frame takes the height of its content');

  // The child viewport can use different CSS pixels under page/browser zoom.
  window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow,
    data: { graphy: 'widget', type: 'height', height: 100, width: frame.clientWidth / 2 } }));
  await until(() => Math.abs(frame.clientHeight - 200) <= 1, 'Frame height converts child pixels into host pixels');
  window.dispatchEvent(new MessageEvent('message', { source: window,
    data: { graphy: 'widget', type: 'height', height: 999, width: 1 } }));
  assert(Math.abs(frame.clientHeight - 200) <= 1, 'Other windows must not control the frame height');
  frame.contentWindow.postMessage({ graphy: 'measure' }, '*');
  await until(() => Math.abs(frame.clientHeight - 200) > 1, 'A fresh measurement restores the drawing height');
  const expand = [...frame.closest('.widget-visual').querySelectorAll('.widget-toolbar .ui-button')].at(-1);
  expand.click();
  await until(() => document.querySelector('.widget-viewer'), 'Drawing viewer opens');
  const viewer = document.querySelector('.widget-viewer');
  const zoomButtons = viewer.querySelectorAll('.ui-icon-button');
  zoomButtons[1].click();
  await until(() => viewer.querySelector('.widget-viewer-content').style.width === '150%', 'Drawing can be enlarged');
  assert(viewer.querySelector('iframe').getAttribute('sandbox') === 'allow-scripts', 'Enlargement preserves the sandbox');
  viewer.querySelector('.ui-button').click();
  await until(() => viewer.querySelector('.widget-viewer-content').style.width === '100%', 'Fit restores the whole drawing');
  zoomButtons[2].click();
  await until(() => !document.querySelector('.widget-viewer'), 'Drawing viewer closes');

  const themeVars = { scheme: theme, vars: { '--ink': '#fff' } };
  const staticCode = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 230"><rect x="20" y="20" width="640" height="190" class="box"/><text x="340" y="120" text-anchor="middle" class="th">Схема растения</text></svg>';
  assert(staticWidgetImage(staticCode, themeVars)?.startsWith('data:image/svg+xml'), 'Static diagrams use native vector rendering');
  assert(staticWidgetImage(staticCode.replace('<rect ', '<rect onclick="alert(1)" '), themeVars) === null, 'Interactive SVG stays sandboxed');
  const { patchBlock } = await import('/src/lib/store.ts');
  const original = blocks.find(b => b.kind === 'widget');
  patchBlock('fixture-matrix', original.id, b => ({ ...b, code: staticCode }));
  await until(() => document.querySelector('.widget-svg')?.complete && document.querySelector('.widget-svg').naturalWidth > 0, 'Vector image loads');
  const image = document.querySelector('.widget-svg');
  assert(Math.abs(image.clientHeight / image.clientWidth - 230 / 680) < .01, 'Vector preview preserves the entire aspect ratio');
  const visual = image.closest('.widget-visual');
  visual.querySelectorAll('.widget-toolbar .ui-icon-button')[1].click();
  await until(() => visual.querySelector('.widget-inline-scroll').scrollWidth > visual.querySelector('.widget-inline-scroll').clientWidth, 'Inline zoom makes small labels readable');
  visual.querySelector('.widget-toolbar .ui-button').click();
  await until(() => visual.querySelector('.widget-inline-scroll').scrollWidth <= visual.querySelector('.widget-inline-scroll').clientWidth + 1, 'Fit restores the entire inline diagram');
  patchBlock('fixture-matrix', original.id, () => original);
  await until(() => frames().at(-1)?.clientHeight > 100, 'Interactive drawing restored');

  const snapshot = { messages: window.__mockBackend.snapshotMessages('fixture-matrix'), resolved_questions: {}, question: null };
  const rebuilt = transcriptBlocks(snapshot);
  assert(rebuilt.filter(b => b.kind === 'widget').length === 1, 'A reloaded lesson must draw the same single picture');
  assert(widgetFromCall({ id: 'x', name: 'show_widget', arguments: { title: 'a_b', widget_code: '  ' } }) === null, 'Empty code draws nothing');
  const doc = widgetDocument('```html\n<!doctype html><html><body><p>hi</p></body></html>\n```', { scheme: 'dark', vars: { '--ink': '#fff' } });
  assert(widgetFragment('```svg\n<svg></svg>\n```') === '<svg></svg>' && !/<html[^>]*>.*<html/is.test(doc) && doc.includes('data-scheme="dark"'), 'A fenced or full-document fragment is reduced to a fragment');
  return { frameHeight: Math.round(frames().at(-1).getBoundingClientRect().height), heightConversion: true, vectorPreview: true, inlineZoom: true, viewer: true };
}
