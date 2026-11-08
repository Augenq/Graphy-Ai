// Run reliability: typed failure rows with retry / edit, the stalled banner (stop / wait), queue edits.
import { until, wait, navigate, click } from './ui-regression.mjs';
const assert = (value, message) => { if (!value) throw Error(message); };
const ID = 'fixture-matrix';
const btn = text => [...document.querySelectorAll('md-outlined-button, button')].find(e => e.textContent.trim() === text);
const posts = path => window.__mockBackend.requests.filter(r => r.method === 'POST' && r.path.endsWith(path));

export async function runReliabilityRegression(theme = 'dark') {
  const { updateSettings } = await import('/src/lib/settings.ts');
  updateSettings({ language: 'ru', theme });
  const { getState, mergeSession } = await import('/src/lib/store.ts');
  const { changeQueued, runErrorActions } = await import('/src/lib/run-errors.ts');
  await navigate('Матрицы');
  const mock = window.__mockBackend;
  const original = getState().sessions[ID].blocks;
  const out = {};
  const reset = () => mergeSession(ID, s => ({ ...s, queue: [], draft: '', blocks: [...original, { id: `rl-u${Math.random()}`, kind: 'user', text: 'Объясни ранг матрицы', attachments: [], at: Date.now() }] }));
  const noticeEvent = (code, can_retry, text = 'Provider failed') => mock.emitEvent(ID, { type: 'notice', text, error: true, code, can_retry });

  // 1. a failure before the reply started: typed title, Retry + Edit, never a silent drop
  reset();
  noticeEvent('network', true, 'error sending request');
  await until(() => btn('Повторить'), 'A network failure offers «Повторить»');
  assert(btn('Изменить и отправить'), 'The failure offers «Изменить и отправить»');
  assert(document.body.textContent.includes('Нет связи с провайдером'), 'The failure shows its typed reason');
  const before = posts('/messages').length;
  click(btn('Повторить'));
  await until(() => posts('/messages').length === before + 1, 'Retry re-sends the message');
  const sent = posts('/messages').at(-1).body;
  assert(sent.retry === true && sent.text === 'Объясни ранг матрицы', `Retry sends the last learner message as a retry: ${JSON.stringify(sent)}`);
  out.retry = true;

  // 2. edit and send puts the words back in the editor, sends nothing
  reset();
  noticeEvent('rate_limit', true);
  await until(() => btn('Изменить и отправить'), 'A second failure row appears');
  const sends = posts('/messages').length;
  click(btn('Изменить и отправить'));
  await until(() => getState().sessions[ID].draft === 'Объясни ранг матрицы', 'Edit puts the message back into the editor');
  assert(posts('/messages').length === sends, 'Edit sends nothing');

  // 3. once the answer has started there is no retry (it would replay work): only «Продолжить»
  reset();
  mergeSession(ID, s => ({ ...s, blocks: [...s.blocks, { id: 'rl-a', kind: 'text', text: 'Ранг — это', streaming: false }] }));
  noticeEvent('error', false);
  await until(() => btn('Продолжить'), 'Without a retry the row offers «Продолжить»');
  assert(!btn('Повторить'), 'No retry once the reply started');
  assert(!runErrorActions('error', false).some(a => a.id === 'retry'), 'Action list agrees');

  // 4. stalled banner: wait, then stop
  reset();
  mock.emitEvent(ID, { type: 'busy', busy: true });
  mock.emitEvent(ID, { type: 'stalled', phase: 'model', seconds: 120, aborted: false });
  await until(() => document.querySelector('[data-run-notice]'), 'The stalled banner appears');
  const banner = document.querySelector('[data-run-notice]');
  const rect = banner.getBoundingClientRect();
  assert(rect.width > 200 && rect.bottom <= innerHeight + 1 && rect.top >= 0, `The banner is on screen: ${JSON.stringify(rect)}`);
  assert(banner.getAttribute('role') === 'alert' && /120/.test(banner.textContent), 'The banner is an alert that names the silence');
  click(banner.querySelector('[data-run-wait]'));
  await until(() => posts('/stall/wait').length === 1 && !document.querySelector('[data-run-notice]'), 'Wait extends and hides the banner');
  mock.emitEvent(ID, { type: 'stalled', phase: 'tool', seconds: 3600, aborted: false });
  await until(() => document.querySelector('[data-run-notice]'), 'The banner returns');
  mock.emitEvent(ID, { type: 'stall_cleared' });
  await until(() => !document.querySelector('[data-run-notice]'), 'Activity clears the banner');
  mock.emitEvent(ID, { type: 'stalled', phase: 'model', seconds: 120, aborted: false });
  await until(() => document.querySelector('[data-run-stop]'), 'Banner again');
  click(document.querySelector('[data-run-stop]'));
  await until(() => posts('/abort').length >= 1 && !document.querySelector('[data-run-notice]'), 'Stop aborts the run');
  mock.emitEvent(ID, { type: 'stalled', phase: 'model', seconds: 240, aborted: true });
  noticeEvent('stalled', true, 'Агент завис');
  await until(() => document.body.textContent.includes('Агент завис'), 'The watchdog abort shows a failure row');
  assert(!document.querySelector('[data-run-notice]'), 'An aborted stall shows no live banner');
  mock.emitEvent(ID, { type: 'busy', busy: false });
  out.stalled = true;

  // 5. queue items: edit, remove, and an item that is already gone is dropped with a reason
  mergeSession(ID, s => ({ ...s, queue: [{ text: 'a', followup: false }, { text: 'b', followup: true }, { text: 'c', followup: false }] }));
  assert(await changeQueued(ID, 2, 'c2') === null, 'Editing succeeds');
  let body = posts('/queue/edit').at(-1).body;
  assert(body.index === 1 && body.followup === false && body.text === 'c2', `Index counts within the kind: ${JSON.stringify(body)}`);
  assert(getState().sessions[ID].queue[2].text === 'c2', 'The local copy follows');
  assert(await changeQueued(ID, 1) === null && getState().sessions[ID].queue.length === 2, 'Removing drops the item');
  mock.queueGone = true;
  const reason = await changeQueued(ID, 0);
  mock.queueGone = false;
  assert(/уже отправлено/.test(reason ?? '') && getState().sessions[ID].queue.length === 1, `A vanished item reports why: ${reason}`);
  out.queue = true;
  reset();
  return out;
}
