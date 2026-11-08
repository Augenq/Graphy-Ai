import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
process.env.GRAPHY_HUB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
const { validateInitData, writeNoFollow, execChown, makeTicket, readTicket } = await import('./max-hub.mjs');

const sign = (token, fields) => {
  const launch = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(launch).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
};
const now = () => Math.floor(Date.now() / 1000);

test('initData: valid, tampered, stale, future', () => {
  const user = JSON.stringify({ id: 1 });
  assert.equal(validateInitData(sign('tok', { auth_date: now(), user }), 'tok').user.id, 1);
  assert.equal(validateInitData(sign('tok', { auth_date: now(), user }), 'other'), null);
  assert.equal(validateInitData(sign('tok', { auth_date: now() - 90000, user }), 'tok'), null);
  assert.equal(validateInitData(sign('tok', { auth_date: now() + 3600, user }), 'tok'), null);
});

test('writeNoFollow refuses to write through a symlink', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wnf-'));
  const target = path.join(d, 'secret'); fs.writeFileSync(target, 'keep');
  const link = path.join(d, 'settings.json'); fs.symlinkSync(target, link);
  assert.throws(() => writeNoFollow(link, 'evil', 0o600));
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
  writeNoFollow(path.join(d, 'fresh.json'), 'ok', 0o600);
  assert.equal(fs.readFileSync(path.join(d, 'fresh.json'), 'utf8'), 'ok');
});

test('execChown does not follow a symlinked directory', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'chown-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'out-')); fs.chmodSync(outside, 0o755);
  fs.symlinkSync(outside, path.join(d, 'home'));
  execChown(d, process.getuid());
  assert.equal(fs.statSync(outside).mode & 0o777, 0o755);
});

test('login ticket is permanent, reusable and tamper-proof', () => {
  const code = makeTicket(42, 'j_abc');
  assert.deepEqual(readTicket(code), { uid: '42', start: 'j_abc' });
  assert.deepEqual(readTicket(code), { uid: '42', start: 'j_abc' }); // second use works
  assert.equal(makeTicket(42, 'j_abc'), code); // stable link
  const [body, sig] = code.split('.');
  const forged = Buffer.from(JSON.stringify({ u: '1', s: '' })).toString('base64url');
  assert.equal(readTicket(`${forged}.${sig}`), null);
  assert.equal(readTicket(`${body}.x${sig}`), null);
  assert.equal(readTicket(''), null);
});
