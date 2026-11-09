import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
process.env.GRAPHY_HUB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
process.env.GRAPHY_USERS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'users-'));
process.env.MAX_BOT_TOKEN = process.env.MAX_BOT_TOKEN || 'test-bot-token';
const { validateInitData, writeNoFollow, execChown, makeTicket, readTicket, setDefaultKey, ownKeyOf, markServiceKey, anonCharge, anonEstimate, portFree, missingKillCap, llmAdmit, llmRecord, llmLog, notifyAdmins, userLabel, anonLabel, statsText, topText, whoText, ipText, limitsText, llmAdminCommand, llmStatsSnapshot, flushLlmStats, dbForTests, noteSuspicious, reportAuthFail, reportClaimFail, nameWithUsername, limitsOf, logText, readLlmLog, lastUserText, maskSecrets, chunkText, killUserProcesses, handleAgentReport, reportsText, detectTrustedProxies, resolveClientIp, sandboxListeners, scanSandboxListeners, sandboxOutbound, scanSandboxOutbound, agentShellScript, blockedMessage, sessionBlocked, handleHub } = await import('./max-hub.mjs');

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

test('portFree reflects what the OS really holds', async () => {
  const net = await import('node:net');
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  assert.equal(await portFree(port), false);
  await new Promise((r) => srv.close(r));
  assert.equal(await portFree(port), true);
});

test('missingKillCap detects a container without CAP_KILL', () => {
  // the capability set the hub container had before the fix (no bit 5) and after it
  assert.equal(missingKillCap('Name:\thub\nCapEff:\t00000000000000cb\n'), true);
  assert.equal(missingKillCap('Name:\thub\nCapEff:\t00000000000000eb\n'), false);
  assert.equal(missingKillCap('no capability line'), false);
});

// ---------- LLM guard ----------
// every test works on its own UTC day (stats reset on a new day) and its own ids, so tests do not influence each other
let baseNow = Date.now();
if (baseNow % 86_400_000 > 86_400_000 - 2_000_000) baseNow -= 3_600_000; // keep the spaced requests inside one UTC day
const dayAt = (k) => baseNow + k * 86_400_000;
const spaced = (k, i, gap = 1600) => dayAt(k) + i * gap; // 37 requests a minute: under the per-minute limit

test('per-user per-minute limit slides, answers 429 in Russian, raises an alert event', () => {
  const k = 1, uid = '9001';
  for (let i = 0; i < 40; i++) assert.equal(llmAdmit({ kind: 'user', uid, now: dayAt(k) + i }).ok, true);
  const r = llmAdmit({ kind: 'user', uid, now: dayAt(k) + 50 });
  assert.equal(r.ok, false); assert.equal(r.status, 429);
  assert.match(r.message, /за минуту/);
  assert.equal(r.events[0].key, `minute:${uid}`);
  assert.equal(llmAdmit({ kind: 'user', uid, now: dayAt(k) + 61_000 }).ok, true); // the window has moved on
});

test('daily per-user limit: 80% and 100% alerts, then 429; active-use alert fires once', () => {
  const k = 2, uid = '9002'; const keys = []; let denied;
  for (let i = 0; i < 401; i++) {
    const r = llmAdmit({ kind: 'user', uid, now: spaced(k, i) });
    if (i < 400) { assert.equal(r.ok, true, `request ${i}`); keys.push(...r.events.map((e) => e.key)); } else denied = r;
  }
  assert.ok(keys.includes(`uid80:${uid}:${new Date(dayAt(k)).toISOString().slice(0, 10)}`));
  assert.ok(keys.some((x) => x.startsWith(`uid100:${uid}`)));
  assert.equal(keys.filter((x) => x === `active:user:${uid}`).length >= 1, true);
  assert.equal(denied.ok, false); assert.equal(denied.status, 429); assert.match(denied.message, /Дневной лимит/);
});

test('admins are outside every limit; blocked users get 403; own-key traffic is never limited', () => {
  const k = 3; const db = dbForTests();
  db.admins.push('9003');
  for (let i = 0; i < 300; i++) assert.equal(llmAdmit({ kind: 'user', uid: '9003', now: dayAt(k) }).ok, true);
  assert.match(llmAdminCommand('block', '9003'), /нельзя/);
  assert.equal(db.blocked.includes('9003'), false);
  assert.match(llmAdminCommand('block', '9004'), /Заблокирован/);
  const r = llmAdmit({ kind: 'user', uid: '9004', now: dayAt(k) });
  assert.equal(r.status, 403);
  assert.match(llmAdminCommand('unblock', '9004'), /Разблокирован/);
  assert.equal(llmAdmit({ kind: 'user', uid: '9004', now: dayAt(k) }).ok, true);
  for (let i = 0; i < 300; i++) assert.equal(llmAdmit({ kind: 'own', id: 'own:abcd1234', now: dayAt(k) }).ok, true);
});

test('/llmoff pauses everyone except admins (503), /llmon lifts it, the flag is part of the saved db', () => {
  const k = 4; const db = dbForTests();
  assert.match(llmAdminCommand('llmoff'), /пауз/i);
  assert.equal(db.llmOff, true);
  const r = llmAdmit({ kind: 'user', uid: '9005', now: dayAt(k) });
  assert.equal(r.status, 503); assert.match(r.message, /приостановлены/);
  assert.equal(llmAdmit({ kind: 'anon', id: 'abcd1234', ip: '203.0.113.7', now: dayAt(k) }).status, 503);
  assert.equal(llmAdmit({ kind: 'user', uid: '9003', now: dayAt(k) }).ok, true); // admin
  assert.match(llmAdminCommand('llmon'), /снята/);
  assert.equal(db.llmOff, false);
  assert.equal(llmAdmit({ kind: 'user', uid: '9005', now: dayAt(k) }).ok, true);
});

test('total daily ceiling for signed-in users: 50/80/100% events, then 429 for everyone', () => {
  const k = 5; const keys = [];
  let admitted = 0, last;
  for (let u = 0; u < 200 && !last; u++) {
    for (let i = 0; i < 30; i++) {
      const r = llmAdmit({ kind: 'user', uid: `95${String(u).padStart(3, '0')}`, now: dayAt(k) + i });
      if (r.ok) { admitted++; keys.push(...r.events.map((e) => e.key)); } else { last = r; break; }
    }
  }
  assert.equal(admitted, 6000);
  for (const pct of [50, 80, 100]) assert.ok(keys.some((x) => x.startsWith(`total${pct}:`)), `total${pct}`);
  const over = llmAdmit({ kind: 'user', uid: '95999', now: dayAt(k) });
  assert.equal(over.status, 429); assert.match(over.message, /Общий суточный/);
});

test('per-IP per-minute limit applies to real addresses, loopback (agents) is skipped', () => {
  const k = 6;
  for (let i = 0; i < 120; i++) assert.equal(llmAdmit({ kind: 'anon', id: `a${String(i).padStart(7, '0')}`, ip: '203.0.113.9', now: dayAt(k) + i }).ok, true);
  const r = llmAdmit({ kind: 'anon', id: 'zzzzzzzz', ip: '203.0.113.9', now: dayAt(k) + 500 });
  assert.equal(r.status, 429); assert.equal(r.events[0].key, 'ipminute:203.0.113.9');
  for (let i = 0; i < 300; i++) assert.equal(llmAdmit({ kind: 'anon', id: `b${String(i).padStart(7, '0')}`, ip: '127.0.0.1', now: dayAt(k) + i }).ok, true);
});

test('stats count requests, 4xx/5xx, 429 and last time per uid, per IP and for anon separately; saved and restorable', () => {
  const k = 7, now = dayAt(k);
  llmAdmit({ kind: 'user', uid: '9101', now }); // rolls to a fresh day
  llmRecord({ kind: 'user', id: '9101', ip: '198.51.100.4', path: '/llm/chat/completions', status: 200, ms: 10, bytes: 100, now });
  llmRecord({ kind: 'user', id: '9101', ip: '198.51.100.4', path: '/llm/chat/completions', status: 429, ms: 1, bytes: 100, now: now + 1000 });
  llmRecord({ kind: 'user', id: '9101', ip: '198.51.100.4', path: '/llm/chat/completions', status: 502, ms: 5, bytes: 100, now: now + 2000 });
  llmRecord({ kind: 'anon', id: 'ab12cd34', ip: '198.51.100.8', path: '/llm/chat/completions', status: 200, ms: 7, bytes: 50, now: now + 3000 });
  llmRecord({ kind: 'user', id: '9102', ip: '127.0.0.1', path: '/llm/models', status: 401, ms: 1, bytes: 0, now: now + 4000 });
  const st = llmStatsSnapshot();
  assert.deepEqual([st.uid['9101'].req, st.uid['9101'].e4, st.uid['9101'].e5, st.uid['9101'].denied], [3, 1, 1, 1]);
  assert.equal(st.uid['9101'].last, now + 2000);
  assert.equal(st.ip['198.51.100.4'].req, 3);
  assert.equal(st.ip['127.0.0.1'], undefined); // loopback is not an address worth tracking
  assert.equal(st.anon.total.req, 1); assert.equal(st.anon.id['ab12cd34'].req, 1); assert.equal(st.anon.ip['198.51.100.8'].req, 1);
  assert.equal(st.total.req, 5);
  flushLlmStats();
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.GRAPHY_HUB_DIR, 'llm-stats.json'), 'utf8'));
  assert.equal(saved.day, st.day); assert.equal(saved.uid['9101'].req, 3);
});

test('the JSONL log has the agreed fields, no secrets, and rotates at the size limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmlog-')); const file = path.join(dir, 'llm.log');
  llmLog({ t: '2026-11-09T00:00:00.000Z', kind: 'anon', id: 'ab12cd34', ip: '198.51.100.8', path: '/llm/chat/completions', status: 200, ms: 7, bytes: 50 }, file, 1000);
  const first = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.deepEqual(Object.keys(first), ['t', 'kind', 'id', 'ip', 'path', 'status', 'ms', 'bytes']);
  for (let i = 0; i < 20; i++) llmLog({ t: 'x', kind: 'user', id: String(i), ip: '1.2.3.4', path: '/p', status: 200, ms: 1, bytes: 1 }, file, 1000);
  assert.ok(fs.existsSync(file + '.1'), 'rotated file exists');
  assert.ok(fs.statSync(file).size <= 1000 && fs.statSync(file + '.1').size <= 1000);
  assert.ok(!/anon-[0-9a-f]{32}|gl-\d+-|sk-or-/.test(fs.readFileSync(file, 'utf8') + fs.readFileSync(file + '.1', 'utf8')));
});

test('admin alerts: one per event key per hour, sent to every admin', async () => {
  const sent = []; const db = dbForTests(); db.admins = ['1', '2'];
  const send = async (to, text) => sent.push([to, text]);
  assert.equal(notifyAdmins('k:test', 'hello', 1_000, send), true);
  assert.equal(notifyAdmins('k:test', 'hello', 1_000 + 30 * 60_000, send), false);
  assert.equal(notifyAdmins('k:other', 'hi', 1_000 + 30 * 60_000, send), true);
  assert.equal(notifyAdmins('k:test', 'again', 1_000 + 61 * 60_000, send), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.filter(([, x]) => x === 'hello').length, 2);
  assert.equal(sent.filter(([, x]) => x === 'again').length, 2);
});

test('users are shown like in MAX (name, @username, id, profile link); anon by IP and short id', () => {
  const db = dbForTests();
  db.users['7001'] = { id: '7001', first_name: 'Анна', last_name: 'Иванова', username: 'anna_i' };
  db.users['7002'] = { id: '7002', first_name: 'Борис', last_name: '', username: '' };
  assert.match(userLabel('7001'), /Анна Иванова \(@anna_i, 7001\)/);
  assert.match(userLabel('7001'), /https:\/\/max\.ru\/anna_i/);
  assert.equal(userLabel('7002'), 'Борис (id 7002)');
  assert.equal(userLabel('7999'), 'id 7999');
  assert.equal(anonLabel('ab12cd34', '198.51.100.8'), 'anon ab12cd34 (IP 198.51.100.8)');
});

test('admin command texts: /stats, /top, /who, /ip, /limits', () => {
  const k = 8, now = dayAt(k); const db = dbForTests();
  db.users['7001'] = { id: '7001', first_name: 'Анна', last_name: 'Иванова', username: 'anna_i' };
  llmAdmit({ kind: 'user', uid: '7001', now });
  llmRecord({ kind: 'user', id: '7001', ip: '198.51.100.4', path: '/llm/chat/completions', status: 200, ms: 3, bytes: 9, now });
  llmRecord({ kind: 'anon', id: 'ab12cd34', ip: '198.51.100.8', path: '/llm/chat/completions', status: 429, ms: 3, bytes: 9, now });
  const stats = statsText(now);
  assert.match(stats, /Запросов к моделям: 2/); assert.match(stats, /Анна Иванова \(@anna_i, 7001\)/);
  assert.match(stats, /Жюри \(анонимные токены\): 1 запр\./); assert.match(stats, /Пауза LLM: нет/); assert.match(stats, /UTC.*03:00 по Москве/);
  const top = topText();
  assert.match(top, /Топ-20 по пользователям/); assert.match(top, /Топ-10 по IP/); assert.match(top, /198\.51\.100\.4/); assert.match(top, /198\.51\.100\.8/);
  assert.match(whoText('7001'), /Анна Иванова/); assert.match(whoText('7001'), /Суточный лимит: 1 из 400/);
  assert.match(ipText('198.51.100.4'), /Залогиненные: 1 запр\./);
  assert.match(ipText('198.51.100.8'), /Анонимные: 1 запр\./);
  assert.match(limitsText(), /GRAPHY_LLM_PER_MIN: 40/); assert.match(limitsText(), /GRAPHY_DAILY_LLM_TOTAL: 6000/);
  assert.match(llmAdminCommand('who', 'abc'), /числовой id/);
  assert.match(llmAdminCommand('ip', 'not an ip'), /IP-адрес/);
  assert.equal(llmAdminCommand('adduser', '1'), null); // not an LLM command: left to the existing handler
});

// ---------- suspicious activity ----------
test('noteSuspicious fires exactly when the threshold is crossed, and the window slides', () => {
  const now = 5_000_000_000_000;
  const fired = []; for (let i = 1; i <= 6; i++) fired.push(noteSuspicious('t:a', 3, 60_000, now + i));
  assert.deepEqual(fired, [false, false, true, false, false, false]); // once, not on every later request
  assert.equal(noteSuspicious('t:a', 3, 60_000, now + 10 * 60_000), false); // old hits dropped: count restarts
});

test('forged logins from one address: alert at 10 in 10 minutes, loopback ignored', () => {
  const now = 5_100_000_000_000; const ip = '203.0.113.50'; const out = [];
  for (let i = 0; i < 12; i++) out.push(reportAuthFail(ip, 'неверный токен', now + i * 1000));
  assert.equal(out.filter(Boolean).length, 1);
  const ev = out[9]; assert.ok(ev); assert.equal(ev.key, `susp-auth:${ip}`); assert.match(ev.text, /203\.0\.113\.50/); assert.match(ev.text, /подбор/);
  for (let i = 0; i < 30; i++) assert.equal(reportAuthFail('127.0.0.1', 'x', now + i), null); // agents calling from inside the container
});

test('wrong /claim code: alert at the third attempt within an hour', () => {
  const now = 5_200_000_000_000; const out = [];
  for (let i = 0; i < 4; i++) out.push(reportClaimFail('Иван (@ivan, id 42)', '42', now + i * 1000));
  assert.deepEqual(out.map(Boolean), [false, false, true, false]);
  assert.match(out[2].text, /Иван \(@ivan, id 42\)/); assert.match(out[2].text, /кода администратора/);
});

test('many anonymous tokens from one IP raise an alert; repeats of the same token do not count', () => {
  const k = 20, ip = '203.0.113.60'; const keys = [];
  for (let i = 0; i < 7; i++) keys.push(...llmAdmit({ kind: 'anon', id: `tok${i}xxxxx`, ip, now: dayAt(k) + i }).events.map((e) => e.key));
  for (let r = 0; r < 5; r++) keys.push(...llmAdmit({ kind: 'anon', id: 'tok0xxxxx', ip, now: dayAt(k) + 100 + r }).events.map((e) => e.key));
  assert.equal(keys.includes(`susp-anon:${ip}`), false, 'seven tokens are still fine');
  const ev = llmAdmit({ kind: 'anon', id: 'tok7xxxxx', ip, now: dayAt(k) + 200 }).events.find((e) => e.key === `susp-anon:${ip}`);
  assert.ok(ev); assert.match(ev.text, /8 разных анонимных токенов/);
  assert.equal(llmAdmit({ kind: 'anon', id: 'tok8xxxxx', ip, now: dayAt(k) + 300 }).events.some((e) => e.key === `susp-anon:${ip}`), false); // fires once
  for (let i = 0; i < 20; i++) assert.equal(llmAdmit({ kind: 'anon', id: `lo${i}xxxxxx`, ip: '127.0.0.1', now: dayAt(k) + i }).events.some((e) => e.key.startsWith('susp-anon')), false);
});

test('a user who keeps hitting the limits gets flagged; a blocked user who keeps trying too', () => {
  const k = 21, uid = '9301'; const keys = [];
  for (let i = 0; i < 40; i++) llmAdmit({ kind: 'user', uid, now: dayAt(k) + i });
  for (let i = 0; i < 8; i++) keys.push(...llmAdmit({ kind: 'user', uid, now: dayAt(k) + 100 + i }).events.map((e) => e.key));
  assert.equal(keys.filter((x) => x === `susp-limit:u:${uid}`).length, 1);
  const db = dbForTests(); db.blocked.push('9302');
  const kb = []; for (let i = 0; i < 7; i++) kb.push(...llmAdmit({ kind: 'user', uid: '9302', now: dayAt(k) + i }).events.map((e) => e.key));
  assert.equal(kb.filter((x) => x === 'susp-blocked:9302').length, 1);
  db.blocked = db.blocked.filter((x) => x !== '9302');
});

test('nameWithUsername: name and @username, only @username, or just the name', () => {
  assert.equal(nameWithUsername({ id: '1', first_name: 'Анна', last_name: 'Иванова', username: 'anna_i' }), 'Анна Иванова (@anna_i)');
  assert.equal(nameWithUsername({ id: '2', first_name: 'Борис', last_name: '', username: '' }), 'Борис');
  assert.equal(nameWithUsername({ id: '3', first_name: '', last_name: '', username: 'nick' }), '@nick');
  assert.equal(nameWithUsername({ id: '4' }), 'id4');
});

// ---------- /setlimit ----------
test('/setlimit changes a user daily and per-minute limit, takes effect at once, is saved and can be reset', () => {
  const k = 30, uid = '9401'; const db = dbForTests();
  db.users[uid] = { id: uid, first_name: 'Лена', last_name: '', username: 'lena' };
  const keys = [];
  assert.match(llmAdminCommand('setlimit', `${uid} 5`), /5 запросов в сутки/);
  assert.deepEqual(db.userLimits[uid], { daily: 5 });
  assert.equal(limitsOf(uid).daily, 5); assert.equal(limitsOf(uid).perMin, 40); assert.equal(limitsOf(uid).custom, true);
  for (let i = 0; i < 5; i++) { const r = llmAdmit({ kind: 'user', uid, now: spaced(k, i) }); assert.equal(r.ok, true); keys.push(...r.events.map((e) => e.key)); }
  assert.ok(keys.some((x) => x.startsWith(`uid80:${uid}`)), '80% of 5 is the 4th request');
  assert.ok(keys.some((x) => x.startsWith(`uid100:${uid}`)));
  const denied = llmAdmit({ kind: 'user', uid, now: spaced(k, 6) });
  assert.equal(denied.status, 429);
  assert.match(llmAdminCommand('setlimit', `${uid} 50`), /50 запросов в сутки/); // raised: works at once
  assert.equal(llmAdmit({ kind: 'user', uid, now: spaced(k, 7) }).ok, true);
  assert.match(whoText(uid), /Суточный лимит: 6 из 50 \(индивидуальный\)/);
  assert.match(limitsText(), /Лена \(@lena, 9401\).*: 50 в сутки, 40 в минуту/);
  assert.match(llmAdminCommand('setlimit', `${uid} сброс`), /сброшен/);
  assert.equal(db.userLimits[uid], undefined); assert.equal(limitsOf(uid).daily, 400); assert.equal(limitsOf(uid).custom, false);
});

test('/setlimit per-minute override, validation and admin note', () => {
  const k = 31, uid = '9402';
  llmAdminCommand('setlimit', `${uid} 100 3`);
  assert.equal(limitsOf(uid).perMin, 3);
  for (let i = 0; i < 3; i++) assert.equal(llmAdmit({ kind: 'user', uid, now: dayAt(k) + i }).ok, true);
  const r = llmAdmit({ kind: 'user', uid, now: dayAt(k) + 10 });
  assert.equal(r.status, 429); assert.match(r.events[0].text, /3 запросов в минуту \(индивидуальный\)/);
  llmAdminCommand('setlimit', `${uid} reset`);
  for (const bad of ['abc 5', '9402', '9402 0', '9402 -3', '9402 1.5', '9402 200000', '9402 10 0', '9402 10 5000']) assert.match(llmAdminCommand('setlimit', bad), /Формат|целое число/, bad);
  assert.equal(dbForTests().userLimits[uid], undefined);
  dbForTests().admins.push('9403');
  assert.match(llmAdminCommand('setlimit', '9403 10'), /Он админ/);
  llmAdminCommand('setlimit', '9403 сброс');
});

// ---------- jury (anonymous tokens) vs MAX users, and /log ----------
test('/stats keeps anonymous tokens (the jury) apart from MAX users', () => {
  const k = 40, now = dayAt(k); const db = dbForTests();
  db.users['9501'] = { id: '9501', first_name: 'Ира', last_name: '', username: 'ira' };
  llmAdmit({ kind: 'user', uid: '9501', now }); // fresh day
  llmRecord({ kind: 'user', id: '9501', ip: '127.0.0.1', path: '/llm/chat/completions', status: 200, ms: 2000, bytes: 4096, now });
  llmRecord({ kind: 'anon', id: 'ab12cd34', ip: '198.51.100.8', path: '/llm/chat/completions', status: 200, ms: 3000, bytes: 8192, now: now + 1000 });
  llmRecord({ kind: 'anon', id: 'ab12cd34', ip: '198.51.100.8', path: '/llm/models', status: 200, ms: 100, bytes: 0, now: now + 2000 });
  llmRecord({ kind: 'anon', id: 'ee99ff00', ip: '203.0.113.2', path: '/llm/chat/completions', status: 429, ms: 5, bytes: 100, now: now + 3000 });
  const stats = statsText(now);
  assert.match(stats, /Ученики и учителя \(вход через MAX\): 1 запр\. от 1 польз\./);
  assert.match(stats, /Жюри \(анонимные токены\): 3 запр\. от 2 токенов/);
  assert.match(stats, /Топ-10 учеников и учителей:\n1\. Ира \(@ira, 9501\)/);
  assert.doesNotMatch(stats.split('Топ-10 учеников')[1], /ab12cd34/);
});

test('/log shows the recent requests of a MAX id, of an anonymous token and of an IP', () => {
  const now = Date.now(); const db = dbForTests();
  db.users['9601'] = { id: '9601', first_name: 'Олег', last_name: '', username: '' };
  for (let i = 0; i < 4; i++) llmRecord({ kind: 'user', id: '9601', ip: '127.0.0.1', path: '/llm/chat/completions', status: i === 3 ? 502 : 200, ms: 1500 + i, bytes: 2048 * (i + 1), now: now + i * 1000 });
  llmRecord({ kind: 'anon', id: 'cafe1234', ip: '198.51.100.99', path: '/llm/chat/completions', status: 200, ms: 900, bytes: 100, now: now + 5000 });
  llmRecord({ kind: 'user', id: '9602', ip: '198.51.100.99', path: '/llm/chat/completions', status: 200, ms: 800, bytes: 100, now: now + 6000 });
  const u = logText('9601');
  assert.match(u, /^Олег \(id 9601\)/); assert.match(u, /Тип: ученик\/учитель \(вход через MAX\)/);
  assert.match(u, /Последние 4 из 4 запросов/); assert.match(u, /\/chat\/completions 502 1\.5с 8 КБ/);
  assert.equal(u.split('\n').filter((l) => /\/chat\/completions \d{3}/.test(l)).length, 4);
  const a = logText('cafe1234');
  assert.match(a, /anon cafe1234 \(IP 198\.51\.100\.99\)/); assert.match(a, /Тип: жюри \(анонимный токен\)/);
  assert.match(logText('cafe'), /Тип: жюри/, 'a prefix of at least 4 characters finds the token');
  const ip = logText('198.51.100.99');
  assert.match(ip, /^IP 198\.51\.100\.99/); assert.match(ip, /\[anon cafe1234\]/); assert.match(ip, /\[user 9602\]/);
  assert.match(logText('9601', 2), /Последние 2 из 4/);
  assert.match(logText('not valid!'), /Нужен MAX id/);
  assert.match(logText('9999999'), /В логе запросов нет/);
  assert.match(llmAdminCommand('log', '9601 1'), /Последние 1 из 4/);
  assert.equal(llmAdminCommand('jury', ''), null, 'there is no /jury command');
  assert.match(whoText('9601'), /Последние запросы: \/log 9601/);
});

test('readLlmLog reads the rotated file too and skips broken lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-')); const f = path.join(dir, 'llm.log');
  fs.writeFileSync(f + '.1', JSON.stringify({ t: 'a', kind: 'user', id: '7', ip: '1.1.1.1', path: '/p', status: 200, ms: 1, bytes: 1 }) + '\nnot json\n');
  fs.writeFileSync(f, JSON.stringify({ t: 'b', kind: 'user', id: '7', ip: '1.1.1.1', path: '/p', status: 200, ms: 1, bytes: 1 }) + '\n');
  const r = readLlmLog('7', 10, [f + '.1', f]);
  assert.deepEqual(r.rows.map((x) => x.t), ['a', 'b']); assert.equal(r.total, 2);
});

// ---------- text of learners' requests in the log ----------
test('lastUserText takes the learner part of the last user message, one line, secrets masked, truncated', () => {
  assert.equal(lastUserText({ messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Привет,\n  как дела?' }] }), 'Привет, как дела?');
  const wrapped = '<application_state note="x">\n{"mode":"explain"}\n</application_state>\n\n<learner_message>\nобъясни дроби\n</learner_message>';
  assert.equal(lastUserText({ messages: [{ role: 'user', content: 'старое' }, { role: 'assistant', content: 'ответ' }, { role: 'user', content: wrapped }] }), 'объясни дроби');
  assert.equal(lastUserText({ messages: [{ role: 'user', content: [{ type: 'text', text: 'что на фото?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] }), 'что на фото?');
  assert.equal(lastUserText({ messages: [{ role: 'user', content: 'вопрос' }, { role: 'tool', content: 'результат инструмента' }] }), 'вопрос'); // tool output is not the learner
  assert.equal(lastUserText({ messages: [{ role: 'user', content: 'вопрос' }, { role: 'user', content: 'Tool image result:' }] }), 'вопрос');
  assert.equal(lastUserText({ messages: [{ role: 'assistant', content: 'a' }] }), ''); assert.equal(lastUserText(null), ''); assert.equal(lastUserText({}), '');
  const long = lastUserText({ messages: [{ role: 'user', content: 'я'.repeat(2000) }] });
  assert.equal(long.length, 601); assert.ok(long.endsWith('…'));
  const hidden = lastUserText({ messages: [{ role: 'user', content: 'мой ключ sk-or-v1-abcdef0123456789abcdef и gl-123-' + 'a'.repeat(32) + ' и anon-' + 'b'.repeat(32) + ' и ghp_' + 'c'.repeat(30) }] });
  assert.doesNotMatch(hidden, /sk-or-v1|gl-123|anon-b|ghp_c/); assert.match(hidden, /\[скрыто\]/);
  assert.match(maskSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'), /\[скрыто\]/);
});

test('chunkText splits long replies at line breaks', () => {
  const text = Array.from({ length: 100 }, (_, i) => `строка ${i} ${'x'.repeat(60)}`).join('\n');
  const parts = chunkText(text, 1000);
  assert.ok(parts.length > 5); assert.ok(parts.every((x) => x.length <= 1000)); assert.equal(parts.join('\n'), text);
  assert.deepEqual(chunkText('коротко'), ['коротко']);
});

test('/prompts switches the text log, /log shows the text and the model when it is there', () => {
  const db = dbForTests(); const now = Date.now() + 5000;
  const uid = '9701'; db.users[uid] = { id: uid, first_name: 'Ася', last_name: '', username: '' };
  assert.match(llmAdminCommand('prompts', ''), /выключен|ВКЛЮЧЁН/);
  assert.match(llmAdminCommand('prompts', 'on'), /ВКЛЮЧЁН/); assert.equal(db.logPrompts, true);
  llmRecord({ kind: 'user', id: uid, ip: '127.0.0.1', path: '/llm/chat/completions', status: 200, ms: 1200, bytes: 4096, text: 'объясни производную', model: 'anthropic/claude-haiku-5.5', now });
  llmRecord({ kind: 'user', id: uid, ip: '127.0.0.1', path: '/llm/chat/completions', status: 200, ms: 900, bytes: 4096, now: now + 1000 });
  const shown = logText(uid);
  assert.match(shown, /anthropic\/claude-haiku-5\.5/); assert.match(shown, /\n {3}» объясни производную/);
  assert.match(llmAdminCommand('prompts', 'off'), /выключен/); assert.equal(db.logPrompts, false);
  assert.match(statsText(now), /Текст запросов в логе: не пишется/);
  const noText = '9702'; llmRecord({ kind: 'user', id: noText, ip: '127.0.0.1', path: '/llm/chat/completions', status: 200, ms: 1, bytes: 1, now: now + 2000 });
  assert.match(logText(noText), /Текст запросов сейчас не пишется: включить \/prompts on/);
  llmAdminCommand('prompts', 'on'); assert.match(statsText(now), /Текст запросов в логе: пишется/);
  assert.match(logText(noText), /Текста запросов в этих строках нет/);
});

// ---------- containment of a sandbox user ----------
test('killUserProcesses kills only processes of that sandbox uid and never root or the hub', () => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-'));
  const mk = (pid, uid) => { fs.mkdirSync(path.join(proc, String(pid))); fs.writeFileSync(path.join(proc, String(pid), 'status'), `Name:\tx\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t0\t0\t0\t0\n`); };
  mk(100, 20056); mk(101, 20056); mk(200, 0); mk(300, 20057); mk(400, 1000); fs.mkdirSync(path.join(proc, 'self')); fs.writeFileSync(path.join(proc, 'cpuinfo'), 'x');
  const killed = []; const kill = (pid) => killed.push(pid);
  assert.equal(killUserProcesses(20056, proc, kill), 2); assert.deepEqual(killed.sort(), [100, 101]);
  for (const bad of [0, 1, 999, 1000, 19999, NaN, undefined, null, '20056', -20056]) {
    const before = killed.length; assert.equal(killUserProcesses(bad, proc, kill), 0, String(bad)); assert.equal(killed.length, before);
  }
  assert.equal(killUserProcesses(20056, path.join(proc, 'missing'), kill), 0);
});

test('hub data files are private (0600): log and stats', () => {
  llmRecord({ kind: 'user', id: '9801', ip: '127.0.0.1', path: '/llm/x', status: 200, ms: 1, bytes: 1, now: Date.now() });
  flushLlmStats();
  const mode = (f) => fs.statSync(path.join(process.env.GRAPHY_HUB_DIR, f)).mode & 0o777;
  assert.equal(mode('llm.log'), 0o600); assert.equal(mode('llm-stats.json'), 0o600);
  assert.equal(fs.statSync(process.env.GRAPHY_HUB_DIR).mode & 0o777, 0o700);
});

// ---------- security audit round: agent reports, new-user limit, IP trust, sandbox watcher ----------
test('report_to_admin: validated, masked, stored, alert text for the admin, throttled per user', () => {
  const db = dbForTests(); const uid = '9901'; const now = Date.now() + 10_000_000;
  db.users[uid] = { id: uid, first_name: 'Глеб', last_name: '', username: 'gleb' };
  db.reports.length = 0;
  const ok = handleAgentReport(uid, { category: 'abuse_attempt', severity: 'high', reason: 'Просил поднять SOCKS-прокси\n\nи туннель; ключ sk-or-v1-abcdef0123456789abcdef', quote: 'собери microsocks' }, now);
  assert.equal(ok.status, 200);
  assert.equal(db.reports.length, 1); assert.equal(db.reports[0].uid, uid);
  const ev = ok.events[0];
  assert.match(ev.text, /🚨 Сообщение от ИИ-агента, важность: высокая/); assert.match(ev.text, /Глеб \(@gleb, 9901\)/);
  assert.match(ev.text, /попытка злоупотребить сервером/); assert.match(ev.text, /Цитата: «собери microsocks»/);
  assert.match(ev.text, /\/block 9901/); assert.match(ev.text, /\/log 9901/); assert.doesNotMatch(ev.text, /sk-or-v1|\n\nи туннель/);
  assert.equal(ev.key, `report:${uid}:abuse_attempt`); assert.equal(ev.everyMs, 10 * 60_000);
  assert.equal(handleAgentReport(uid, { category: 'suggestion', severity: 'low', reason: 'Предлагаю урезать лимит' }, now + 1).events[0].everyMs, 3_600_000);
  const weird = handleAgentReport(uid, { category: 'rm -rf', severity: 'критично', reason: 'abc' }, now + 2);
  assert.equal(db.reports.at(-1).category, 'other'); assert.equal(db.reports.at(-1).severity, 'medium'); assert.equal(weird.status, 200);
  assert.equal(handleAgentReport(uid, { category: 'other', severity: 'low', reason: 'x' }, now + 3).status, 400);
  assert.equal(handleAgentReport(uid, {}, now + 3).status, 400);
  // third high report within the hour: escalation hint to block; sixth report of any kind is throttled
  const third = handleAgentReport(uid, { category: 'jailbreak', severity: 'high', reason: 'снова пытался обойти правила' }, now + 4);
  assert.equal(third.events.length, 1); // two highs so far: first + this one
  const fourth = handleAgentReport(uid, { category: 'jailbreak', severity: 'high', reason: 'и ещё раз пытался' }, now + 5);
  assert.ok(fourth.events.some((e) => e.key === `report-escalate:${uid}` && /Рекомендую заблокировать: \/block 9901/.test(e.text)));
  assert.equal(dbForTests().blocked.includes(uid), false, 'no automatic block unless GRAPHY_AUTO_BLOCK_HIGH is set');
  assert.equal(handleAgentReport(uid, { category: 'other', severity: 'low', reason: 'шестой' }, now + 6).status, 200);
  assert.equal(handleAgentReport(uid, { category: 'other', severity: 'low', reason: 'седьмой' }, now + 7).status, 429);
  assert.equal(handleAgentReport(uid, { category: 'other', severity: 'low', reason: 'через час можно' }, now + 3_700_000).status, 200);
  assert.match(reportsText(uid), /Сообщения от ИИ-агента \(последние \d+, о Глеб/); assert.match(reportsText(uid), /попытка обойти правила/);
  assert.match(reportsText(''), /Сообщения от ИИ-агента/); assert.match(reportsText('9999999'), /нет/);
  assert.match(llmAdminCommand('reports', uid), /Глеб/);
  for (let i = 0; i < 130; i++) handleAgentReport(`98${i}`, { category: 'other', severity: 'low', reason: `r${i}` }, now + 10_000 + i);
  assert.ok(db.reports.length <= 100);
});

test('new users get 40 requests a day, old users keep the general limit, /setlimit new changes it', () => {
  const db = dbForTests(); const since = db.newUsersSince; assert.ok(since > 0);
  db.users['9911'] = { id: '9911', first_name: 'Новый', created: since + 1000 };
  db.users['9912'] = { id: '9912', first_name: 'Старый', created: since - 1000 };
  assert.equal(limitsOf('9911').daily, 40); assert.equal(limitsOf('9911').isNew, true);
  assert.equal(limitsOf('9912').daily, 400); assert.equal(limitsOf('9912').isNew, false);
  assert.equal(limitsOf('unknown').daily, 400);
  const k = 50; const out = [];
  for (let i = 0; i < 41; i++) out.push(llmAdmit({ kind: 'user', uid: '9911', now: spaced(k, i) }));
  assert.equal(out.slice(0, 40).every((r) => r.ok), true); assert.equal(out[40].status, 429); assert.match(out[40].message, /Дневной лимит/);
  assert.match(whoText('9911'), /Новый пользователь: 40 в сутки/);
  assert.match(limitsText(), /GRAPHY_NEW_USER_DAILY: 40/);
  assert.match(llmAdminCommand('setlimit', 'new 25'), /25 запросов в сутки/); assert.equal(limitsOf('9911').daily, 25);
  assert.match(llmAdminCommand('setlimit', '9911 100'), /100 запросов/); assert.equal(limitsOf('9911').daily, 100); // a personal limit wins
  assert.match(llmAdminCommand('setlimit', 'new abc'), /целое число/); assert.match(llmAdminCommand('setlimit', 'new 0'), /целое число/);
  llmAdminCommand('setlimit', '9911 сброс'); llmAdminCommand('setlimit', 'new 40'); assert.equal(limitsOf('9911').daily, 40);
});

test('X-Forwarded-For is believed only from the real reverse proxy, never from a process inside the container', () => {
  const eth0 = { eth0: [{ family: 'IPv4', address: '172.18.0.4', internal: false }], lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] };
  const inContainer = detectTrustedProxies({}, true, eth0);
  assert.deepEqual([...inContainer], ['172.18.0.1']);
  assert.equal(resolveClientIp('::ffff:172.18.0.1', '203.0.113.5, 10.0.0.9', inContainer), '203.0.113.5');
  assert.equal(resolveClientIp('127.0.0.1', '203.0.113.5', inContainer), '127.0.0.1', 'agent sandbox on loopback cannot fake an address');
  assert.equal(resolveClientIp('172.18.0.4', '203.0.113.5', inContainer), '172.18.0.4', 'nor through the container own address');
  assert.equal(resolveClientIp('172.18.0.1', '', inContainer), '172.18.0.1');
  assert.deepEqual([...detectTrustedProxies({ GRAPHY_TRUSTED_PROXIES: '10.1.1.1, 10.1.1.2' }, true, eth0)], ['10.1.1.1', '10.1.1.2']);
  assert.deepEqual([...detectTrustedProxies({}, false, eth0)], ['127.0.0.1', '::1']); // local development
});

test('sandbox watcher: a user server socket held past the grace period is killed together with the rest of his processes, but not his agent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-')); const procNet = path.join(dir, 'net'); const proc = path.join(dir, 'proc');
  fs.mkdirSync(procNet); fs.mkdirSync(proc);
  const row = (i, addr, st, uid) => `   ${i}: ${addr} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000 ${String(uid).padStart(5)}        0 ${1000 + i} 1 0000000000000000 100 0 0 10 0`;
  const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
  fs.writeFileSync(path.join(procNet, 'tcp'), [head, row(0, '0100007F:0403', '0A', 20056), row(1, '0100007F:238C', '0A', 20056), row(2, '0100007F:1F96', '0A', 0), row(3, '0100007F:0050', '01', 20056)].join('\n'));
  fs.writeFileSync(path.join(procNet, 'tcp6'), [head, row(0, '00000000000000000000000001000000:0016', '0A', 20057)].join('\n'));
  const mk = (pid, uid) => { fs.mkdirSync(path.join(proc, String(pid))); fs.writeFileSync(path.join(proc, String(pid), 'status'), `Name:\tx\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`); };
  mk(500, 20056); mk(501, 20056); mk(502, 20056); mk(600, 20057); mk(1, 0);
  const l = sandboxListeners(procNet);
  assert.deepEqual(l.map((x) => [x.uid, x.port]).sort(), [[20056, 1027], [20056, 9100], [20057, 22]].sort());
  const killed = []; const opts = { procNet, procDir: proc, kill: (pid) => killed.push(pid), agentPorts: new Set([9100]), agentPids: new Set([500]), osuidToUser: (u) => (u === 20056 ? '10000001' : '') };
  const t0 = 9_000_000_000_000;
  assert.deepEqual(scanSandboxListeners({ ...opts, now: t0 }), []); // first sighting only
  assert.deepEqual(scanSandboxListeners({ ...opts, now: t0 + 10_000 }), []); // inside the grace period
  const acted = scanSandboxListeners({ ...opts, now: t0 + 50_000 });
  assert.deepEqual(acted.filter((x) => x.port === 1027).map((x) => [x.uid, x.user, x.killed]), [[20056, '10000001', 2]]);
  assert.deepEqual(killed.filter((p) => [501, 502].includes(p)).sort(), [501, 502]); // his other processes
  assert.equal(killed.includes(500), false, 'his agent is left alone'); assert.equal(killed.includes(1), false);
  assert.ok(acted.some((x) => x.port === 22 && x.uid === 20057)); // second user: the port 22 listener is judged on its own
});

test('sandbox watcher: a long outbound connection to the Internet (tunnel client) is killed, local and short ones are not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw2-')); const procNet = path.join(dir, 'net'); const proc = path.join(dir, 'proc');
  fs.mkdirSync(procNet); fs.mkdirSync(proc);
  const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
  const row = (i, loc, rem, uid) => `   ${i}: ${loc} ${rem} 01 00000000:00000000 00:00000000 00000000 ${String(uid).padStart(5)}        0 ${2000 + i} 1 0000000000000000 100 0 0 10 0`;
  fs.writeFileSync(path.join(procNet, 'tcp'), [head,
    row(0, '050012AC:C000', '184D3D4E:01BB', 20056), // 78.61.77.24:443 (any public address)
    row(1, '0100007F:C001', '0100007F:1F96', 20056), // loopback: the agent talking to the hub
    row(2, '0100007F:C002', '050012AC:1F90', 20056), // sibling container
    row(3, '0100007F:C003', '01010101:01BB', 0),      // not a sandbox uid
  ].join('\n'));
  fs.writeFileSync(path.join(procNet, 'tcp6'), [head, row(0, '00000000000000000000000001000000:C004', '00000000000000000000000001000000:1F96', 20056)].join('\n'));
  const mk = (pid, uid) => { fs.mkdirSync(path.join(proc, String(pid))); fs.writeFileSync(path.join(proc, String(pid), 'status'), `Name:\tx\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`); };
  mk(500, 20056); mk(501, 20056); mk(1, 0);
  const o = sandboxOutbound(procNet);
  assert.equal(o.length, 1); assert.equal(o[0].uid, 20056); assert.match(o[0].remote, /:443$/);
  const killed = []; const opts = { procNet, procDir: proc, kill: (pid) => killed.push(pid), agentPids: new Set([500]), osuidToUser: () => '10000001' };
  const t0 = 9_100_000_000_000;
  assert.deepEqual(scanSandboxOutbound({ ...opts, now: t0 }), []);
  assert.deepEqual(scanSandboxOutbound({ ...opts, now: t0 + 60_000 }), []); // still inside the grace period
  const acted = scanSandboxOutbound({ ...opts, now: t0 + 400_000 });
  assert.equal(acted.length, 1); assert.equal(acted[0].user, '10000001');
  assert.deepEqual(killed, [501]); // the agent (500) and root (1) stay
});

test('admin lists show blocked users in their own section (stats, top, limits)', () => {
  const db = dbForTests(); const prev = db.blocked; db.blocked = ['9961'];
  db.users['9961'] = { id: '9961', first_name: 'Плохой', last_name: '', username: '', role: 'student', osuid: 29961, created: 1 };
  db.users['9962'] = { id: '9962', first_name: 'Хороший', last_name: '', username: '', role: 'student', osuid: 29962, created: 1 };
  db.userLimits = { ...(db.userLimits || {}), 9961: { daily: 5 }, 9962: { daily: 7 } };
  try {
    const l = limitsText(); const [okPart, badPart] = l.split('🚫 Заблокированные:');
    assert.ok(okPart.includes('Хороший') && !okPart.includes('Плохой')); assert.ok(badPart.includes('Плохой') && !badPart.includes('Хороший'));
  } finally { db.blocked = prev; delete db.userLimits[9961]; delete db.userLimits[9962]; }
});

test('agents start through a wrapper with a private umask and process limits', () => {
  assert.equal(agentShellScript(true), 'umask 077; ulimit -u 100; ulimit -f 2097152; ulimit -n 2048; exec "$0" "$@"');
  assert.equal(agentShellScript(false), 'umask 077; exec "$0" "$@"'); // a developer machine: no process cap on his own account
});

// ---------- what a blocked person is told ----------
test('a blocked user is told so (403 "blocked") in the app, the models and the login, and is not put on the waiting list', async () => {
  const http = await import('node:http');
  const db = dbForTests(); const uid = '9951';
  db.users[uid] = { id: uid, first_name: 'Блок', last_name: '', username: 'blk', role: 'student', osuid: 29951, created: 1 };
  db.allowed.push(uid);
  const secret = fs.readFileSync(path.join(process.env.GRAPHY_HUB_DIR, 'secret'), 'utf8').trim();
  const mac = (m) => crypto.createHmac('sha256', secret).update(m).digest('base64url');
  const session = (u, exp = Date.now() + 60_000) => { const body = Buffer.from(JSON.stringify({ u, e: exp })).toString('base64url'); return `v1.${body}.${mac(body)}`; };
  const srv = http.createServer((q, r) => { handleHub(q, r).then((h) => { if (!h) { r.writeHead(404); r.end(); } }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (p, token) => { const r = await fetch(base + p, { headers: { authorization: `Bearer ${token}` } }); return [r.status, await r.json().catch(() => ({}))]; };
  try {
    assert.equal((await get('/hub/me', session(uid)))[0], 200); // fine while allowed
    db.blocked.push(uid);
    const me = await get('/hub/me', session(uid));
    assert.equal(me[0], 403); assert.equal(me[1].error.code, 'blocked'); assert.match(me[1].error.message, /заблокирован администратором/); assert.match(me[1].error.message, /9951/);
    const api = await get('/api/v1/bootstrap', session(uid));
    assert.equal(api[0], 403); assert.equal(api[1].error.code, 'blocked');
    assert.equal((await get('/hub/me', session('424242')))[0], 401, 'an unknown user is simply not logged in');
    assert.equal((await get('/hub/me', session(uid, Date.now() - 1000)))[0], 401, 'an expired session is not "blocked", it is "log in again"');
    assert.equal((await get('/hub/me', session(uid).slice(0, -3) + 'abc'))[0], 401, 'a forged session is not "blocked"');
    const ticket = makeTicket(uid);
    const au = await fetch(base + '/hub/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) });
    const aj = await au.json(); assert.equal(au.status, 403); assert.equal(aj.error.code, 'blocked');
    assert.equal(db.pending[uid], undefined, 'blocked people are not added to the waiting list');
    const llm = llmAdmit({ kind: 'user', uid, now: Date.now() }); assert.equal(llm.status, 403); assert.equal(llm.message, blockedMessage(uid));
    assert.equal(sessionBlocked(session(uid)), true); assert.equal(sessionBlocked(session('424242')), false); assert.equal(sessionBlocked('garbage'), false);
    db.blocked = db.blocked.filter((x) => x !== uid); // unblock: everything works again
    assert.equal((await get('/hub/me', session(uid)))[0], 200);
    db.admins.push('9952'); db.blocked.push('9952'); // an admin can never be locked out
    db.users['9952'] = { id: '9952', first_name: 'Адм', role: 'teacher', osuid: 29952, created: 1 };
    assert.equal(sessionBlocked(session('9952')), false);
    db.blocked = db.blocked.filter((x) => x !== '9952');
  } finally { srv.close(); }
});
