// Files the agent presents (present_file): a card in the chat, the file in a panel beside it with
// download / full screen / close, previews for common formats, a download-only fallback for the rest.
import { until, navigate } from './ui-regression.mjs';
const assert = (value, message) => { if (!value) throw Error(message); };
const q = (selector) => document.querySelector(selector);

export async function runPresentRegression(theme = 'dark') {
  const { updateSettings } = await import('/src/lib/settings.ts');
  updateSettings({ language: 'ru', theme });
  const { getState } = await import('/src/lib/store.ts');
  const { parseDelimited, } = await import('/src/components/PresentedFile.tsx');
  const { resetPresented, presentedFromResult, previewKind } = await import('/src/lib/presented.ts');
  const { transcriptBlocks } = await import('/src/lib/wire.ts');
  await navigate('Матрицы');
  resetPresented();
  const id = 'fixture-matrix';
  const mock = window.__mockBackend;
  const cards = () => [...document.querySelectorAll('[data-pf-card]')];
  assert(!q('[data-pf-viewer]'), 'Nothing is open before a file is presented');

  // pure parts
  assert(JSON.stringify(parseDelimited('a,"b,1","c ""q"""\n1,2,3\n', ',')) === JSON.stringify([['a', 'b,1', 'c "q"'], ['1', '2', '3']]), 'CSV quoting');
  assert(presentedFromResult('c1', 'not json') === null && presentedFromResult('c1', JSON.stringify({ ok: true, file: {} })) === null, 'A malformed result draws nothing');
  assert(previewKind({ mime: 'application/pdf', name: 'a.pdf' }) === 'pdf' && previewKind({ mime: 'application/octet-stream', name: 'a.xyz' }) === 'none', 'Preview kinds');

  // a presented markdown file: card in the chat, the panel opens by itself
  const before = cards().length;
  mock.emitPresented(id, { name: 'Конспект.md', mime: 'text/markdown', bytes: '# Векторы\n\nДлина вектора: $|x|$.', title: 'Векторы: конспект' });
  await until(() => cards().length === before + 1, 'The card appears in the transcript');
  await until(() => q('[data-pf-viewer]'), 'The viewer opens when a file is presented');
  assert(!getState().sessions[id].blocks.some(b => b.kind === 'action' && /present_file/.test(b.title)), 'present_file adds no tool row');
  const title = q('.pf-title').textContent;
  assert(title === 'Векторы: конспект · MD', `Header reads «title · kind»: ${title}`);
  await until(() => q('.pf-page h1')?.textContent === 'Векторы', 'Markdown renders on a page');
  assert(cards().at(-1).textContent.includes('Документ · MD'), 'The card names the type of file');
  assert(q('[data-pf-download]') && q('[data-pf-full]') && q('[data-pf-close]'), 'Download, full screen and close are present');

  // download
  let saved = null;
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { saved = this.download; };
  q('[data-pf-download]').click();
  await until(() => saved === 'Конспект.md', 'Download saves the file under its name');
  HTMLAnchorElement.prototype.click = click;

  // full screen and back
  q('[data-pf-full]').click();
  await until(() => q('[data-pf-overlay] .pf-viewer.is-full'), 'Full screen covers the window');
  assert(q('[data-pf-overlay] .pf-page h1'), 'The document stays visible in full screen');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await until(() => !q('[data-pf-overlay]') && q('[data-pf-viewer]'), 'Escape leaves full screen but keeps the panel');

  // close, then reopen from the card
  q('[data-pf-close]').click();
  await until(() => !q('[data-pf-viewer]'), 'Close hides the panel');
  assert(cards().length === before + 1, 'The card stays in the transcript');
  cards().at(-1).click();
  await until(() => q('[data-pf-viewer]'), 'The card opens the file again');

  // other formats
  mock.emitPresented(id, { name: 'table.csv', mime: 'text/csv', bytes: 'x,y\n1,2\n3,4\n' });
  await until(() => q('.pf-table td'), 'CSV renders as a table');
  assert([...document.querySelectorAll('.pf-table th')].map(n => n.textContent).join() === 'x,y', 'CSV header row');
  mock.emitPresented(id, { name: 'page.html', mime: 'text/html', bytes: '<h1>Hi</h1><script>parent.__pwned=1</script>' });
  await until(() => q('iframe.pf-html'), 'HTML renders in a frame');
  assert(q('iframe.pf-html').getAttribute('sandbox') === '', 'HTML runs with every sandbox permission off');
  assert(!window.__pwned, 'A script in a presented page must not run');
  mock.emitPresented(id, { name: 'scan.pdf', mime: 'application/pdf', bytes: new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52]) });
  await until(() => q('iframe.pf-pdf'), 'PDF opens in the viewer frame');
  assert(q('.pf-title').textContent.endsWith('· PDF') && cards().at(-1).textContent.includes('Документ · PDF'), 'PDF card and header');
  mock.emitPresented(id, { name: 'archive.bin', mime: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]) });
  await until(() => q('.pf-nopreview'), 'An unknown format still opens, with a download button');
  assert(q('.pf-nopreview .pf-download-btn'), 'The fallback offers a download');

  // a failed call draws nothing
  const count = cards().length;
  const call = { id: 'present-bad', name: 'present_file', arguments: { path: 'missing.pdf' } };
  mock.emitEvent(id, { type: 'tool_start', call });
  mock.emitEvent(id, { type: 'tool_end', call, result: { content: 'File not found', error: true } });
  await new Promise(r => setTimeout(r, 100));
  assert(cards().length === count, 'A failed present_file draws no card');

  // a saved lesson rebuilds the cards but does not pop the panel open
  q('[data-pf-close]').click();
  await until(() => !q('[data-pf-viewer]'), 'Closed again');
  const rebuilt = transcriptBlocks({ ...structuredClone(mock.sessionRef(id)), messages: [
    { id: 'a1', role: 'assistant', content: '', thinking: '', calls: [{ id: 'c9', name: 'present_file', arguments: { path: 'a.pdf' } }] },
    { id: 't1', role: 'tool', call_id: 'c9', name: 'present_file', content: JSON.stringify({ ok: true, file: { id: 'f'.repeat(32), name: 'a.pdf', title: null, mime: 'application/pdf', size: 8 } }) },
  ] });
  assert(rebuilt.some(b => b.kind === 'file' && b.file.title === 'a.pdf'), 'A saved lesson shows the card');

  resetPresented();
  return { ok: true };
}
