import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
process.env.GRAPHY_HUB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
process.env.GRAPHY_USERS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'users-'));
const { validateInitData, writeNoFollow, execChown, makeTicket, readTicket, setDefaultKey, ownKeyOf, markServiceKey, anonCharge, anonEstimate } = await import('./max-hub.mjs');

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

test('service key: default token, own key and other providers survive, key is reported as "service"', () => {
  const u = { id: '31337', osuid: 20031 };
  const dir = path.join(process.env.GRAPHY_USERS_DIR, u.id); fs.mkdirSync(dir, { recursive: true });
  const auth = path.join(dir, 'auth.json');
  const read = () => JSON.parse(fs.readFileSync(auth, 'utf8'));
  setDefaultKey(u);
  assert.match(read().openrouter.key, /^gl-31337-[0-9a-f]{32}$/);
  assert.equal(ownKeyOf(u), '');
  const prov = () => ({ providers: [{ name: 'openrouter', configured: true, key_source: 'stored' }, { name: 'anthropic', configured: false }] });
  assert.equal(markServiceKey(prov(), u).providers[0].key_source, 'service');
  // the user saves their own key and another provider's key
  fs.writeFileSync(auth, JSON.stringify({ openrouter: { key: 'sk-or-v1-mine1234567890' }, anthropic: { key: 'sk-ant-x' } }));
  setDefaultKey(u); // a restart must not overwrite them
  assert.equal(read().openrouter.key, 'sk-or-v1-mine1234567890');
  assert.equal(ownKeyOf(u), 'sk-or-v1-mine1234567890');
  assert.equal(markServiceKey(prov(), u).providers[0].key_source, 'stored');
  // deleting the own key brings the service key back and keeps the other provider
  fs.writeFileSync(auth, JSON.stringify({ anthropic: { key: 'sk-ant-x' } }));
  setDefaultKey(u);
  assert.match(read().openrouter.key, /^gl-31337-/);
  assert.equal(read().anthropic.key, 'sk-ant-x');
});

test('public tier: only the three models, max_tokens capped, limits per token, IP and in total', () => {
  assert.equal(anonEstimate({ model: 'openai/gpt-6.1-sol' }, 1000), null);
  assert.equal(anonEstimate({ model: 'x/unknown' }, 1000), null);
  const e = anonEstimate({ model: 'anthropic/claude-haiku-5.5', max_tokens: 999999 }, 3000);
  assert.equal(e.out, 8192);
  assert.ok(e.usd > 0.02 && e.usd < 0.03, String(e.usd));
  assert.ok(anonEstimate({ model: 'anthropic/claude-sonnet-5.5' }, 30000).usd > anonEstimate({ model: 'deepseek/deepseek-v4.1-flash' }, 30000).usd * 5);
  const caps = { token: 0.05, ip: 0.08, total: 0.1 }, day = '2099-01-01';
  assert.ok(anonCharge('anon-a', '1.1.1.1', 0.03, caps, day));
  assert.ok(!anonCharge('anon-a', '1.1.1.1', 0.03, caps, day), 'per-token cap');
  assert.ok(anonCharge('anon-b', '1.1.1.1', 0.03, caps, day));
  assert.ok(!anonCharge('anon-c', '1.1.1.1', 0.03, caps, day), 'per-IP cap');
  assert.ok(anonCharge('anon-d', '2.2.2.2', 0.03, caps, day));
  assert.ok(!anonCharge('anon-e', '3.3.3.3', 0.03, caps, day), 'total cap');
});
