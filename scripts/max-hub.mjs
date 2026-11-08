/**
 * MAX hub: turns the single-user Graphy web server into a multi-user MAX mini-app.
 *  - validates MAX WebApp initData (HMAC with the bot token) and issues session tokens;
 *  - keeps users, roles (student / teacher), classes, invites and class membership (JSON file);
 *  - runs one private agent process per user (own data dir, own OS uid) and proxies /api/* to it;
 *  - forwards LLM calls through /llm/* so the provider key never reaches the agent processes;
 *  - long-polls the MAX Bot API (/start, deep-link joins) and replies with an "open app" button.
 * Enabled only when MAX_BOT_TOKEN is set. No dependencies.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createSchool } from './school.mjs';

const env = process.env;
export const hubEnabled = () => !!env.MAX_BOT_TOKEN;

const BOT_TOKEN = env.MAX_BOT_TOKEN || '';
const DATA = env.GRAPHY_HUB_DIR || '/data/hub';
const USERS_DIR = env.GRAPHY_USERS_DIR || '/data/users';
const WORK_DIR = env.GRAPHY_WORK_DIR || '/workspace/users';
const SEED_DIR = env.GRAPHY_SEED_DIR || '/data/seed';
const API = env.MAX_API_URL || 'https://platform-api.max.ru';
const MAX_AGENTS = Number(env.GRAPHY_MAX_AGENTS || 3);
const IDLE_MS = Number(env.GRAPHY_AGENT_IDLE_MS || 6 * 60_000);
const DAILY_LLM = Number(env.GRAPHY_DAILY_LLM_REQUESTS || 400);
const LLM_UPSTREAM = env.GRAPHY_LLM_UPSTREAM || 'https://openrouter.ai/api/v1';
const LLM_KEY = env.GRAPHY_LLM_KEY || '';
const PUBLIC_URL = (env.GRAPHY_PUBLIC_URL || '').replace(/\/$/, '');
const AS_USER = process.getuid?.() === 0; // switch uid for agents only when we are allowed to
let botName = env.MAX_BOT_NAME || '';

fs.mkdirSync(DATA, { recursive: true });

// ---------- storage ----------
const dbFile = path.join(DATA, 'hub.json');
let db = { users: {}, classes: {}, nextUid: 20000, admins: [], allowed: [], pending: {}, open: false };
try { db = { ...db, ...JSON.parse(fs.readFileSync(dbFile, 'utf8')) }; } catch { /* first run */ }
let dirty = false;
const save = () => { dirty = true; };
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  try { fs.writeFileSync(dbFile + '.tmp', JSON.stringify(db)); fs.renameSync(dbFile + '.tmp', dbFile); } catch (e) { console.error('hub save failed', e.message); }
}, 1500).unref();
const secretFile = path.join(DATA, 'secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();

const school = createSchool({ dir: DATA, classes: () => db.classes, users: () => db.users });

// ---------- access control ----------
const isAdmin = (id) => db.admins.includes(String(id));
const hasAccess = (id) => db.open || isAdmin(id) || db.allowed.includes(String(id));
const CLAIM = env.MAX_ADMIN_CLAIM || '';
for (const id of (env.MAX_ADMIN_IDS || '').split(',').map((x) => x.trim()).filter(Boolean)) if (!db.admins.includes(id)) db.admins.push(id);
const addTo = (list, id) => { if (!list.includes(id)) list.push(id); delete db.pending[id]; save(); };
const delFrom = (list, id) => { const i = list.indexOf(id); if (i >= 0) list.splice(i, 1); save(); };

// ---------- permanent login links (bot -> browser), used when the mini-app URL is not registered in MAX ----------
// Stateless and signed: never expires, can be opened any number of times, survives hub restarts.
// Access is still checked on every use (removing a user from the allowlist stops the link working).
const hmacRaw = (key, msg, enc) => crypto.createHmac('sha256', key).update(msg).digest(enc);
export function makeTicket(uid, start = '') {
  const body = Buffer.from(JSON.stringify({ u: String(uid), s: start || '' })).toString('base64url');
  return `${body}.${hmacRaw(SECRET, `ticket:${body}`, 'base64url')}`;
}
export function readTicket(code) {
  const [body, sig] = String(code || '').split('.');
  if (!body || !sig || !safeEq(hmacRaw(SECRET, `ticket:${body}`, 'base64url'), sig)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return { uid: String(p.u), start: String(p.s || '') }; } catch { return null; }
}

// ---------- auth ----------
const hmac = (key, msg, enc) => crypto.createHmac('sha256', key).update(msg).digest(enc);
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Verifies WebApp.initData per https://dev.max.ru/docs/webapps/validation. Returns the parsed fields or null. */
export function validateInitData(initData, token = BOT_TOKEN, maxAgeSec = 24 * 3600) {
  if (typeof initData !== 'string' || !initData || initData.length > 8192) return null;
  let raw = initData;
  if (raw.includes('WebAppData=') && !raw.includes('hash=')) raw = new URLSearchParams(raw.replace(/^#/, '')).get('WebAppData') || raw;
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash || params.getAll('hash').length !== 1) return null;
  params.delete('hash');
  const launch = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = hmac('WebAppData', token);
  if (!safeEq(hmac(secret, launch, 'hex'), hash)) return null;
  const auth = Number(params.get('auth_date'));
  if (!auth || Date.now() / 1000 - auth > maxAgeSec || auth - Date.now() / 1000 > 60) return null;
  try { return { user: JSON.parse(params.get('user') || 'null'), start: params.get('start_param') || '' }; } catch { return null; }
}
const b64 = (s) => Buffer.from(s).toString('base64url');
const sessionFor = (uid) => { const body = b64(JSON.stringify({ u: String(uid), e: Date.now() + 7 * 864e5 })); return `v1.${body}.${hmac(SECRET, body, 'base64url')}`; };
const userFromSession = (token) => {
  const [v, body, sig] = String(token || '').split('.');
  if (v !== 'v1' || !body || !sig || !safeEq(hmac(SECRET, body, 'base64url'), sig)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.e > Date.now() && hasAccess(p.u) ? db.users[p.u] || null : null; } catch { return null; }
};
const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
const displayName = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `id${u.id}`;
const publicUser = (u) => ({ id: u.id, first_name: u.first_name, last_name: u.last_name, username: u.username, photo_url: u.photo_url, language: u.language, role: u.role, name: displayName(u) });

function upsertUser(info) {
  const id = String(info.id);
  const old = db.users[id];
  const u = db.users[id] = {
    role: null, created: Date.now(), osuid: db.nextUid++, ...old,
    id, first_name: info.first_name || '', last_name: info.last_name || '', username: info.username || '', photo_url: info.photo_url || '',
    language: info.language_code || 'ru', seen: Date.now(),
  };
  if (!old) save(); else dirty = true;
  return u;
}

// ---------- http helpers ----------
function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Слишком большой запрос'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(size ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(Object.assign(new Error('Некорректный JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const fail = (status, message, code = 'hub_error') => Object.assign(new Error(message), { status, code });

// ---------- classes ----------
const newCode = () => crypto.randomBytes(5).toString('hex'); // 10 chars, payload-safe
const inviteLink = (code) => (botName ? `https://max.ru/${botName}?startapp=j_${code}` : '');
const classOf = (code) => { const c = db.classes[String(code)]; if (!c) throw fail(404, 'Класс не найден'); return c; };
const teacherOnly = (u, c) => { if (c.teacher !== u.id) throw fail(403, 'Это не ваш класс'); };

const classCard = (c, forTeacher) => {
  const t = db.users[c.teacher];
  const base = { code: c.code, title: c.title, created: c.created, invite: inviteLink(c.code), teacher: t ? { id: t.id, name: displayName(t), photo_url: t.photo_url } : null };
  if (!forTeacher) return base;
  return { ...base, students: Object.entries(c.students).map(([sid, s]) => {
    const u = db.users[sid];
    return { id: sid, name: u ? displayName(u) : sid, photo_url: u?.photo_url || '', joined: s.joined };
  }) };
};
function joinClass(u, code) {
  const c = classOf(code);
  if (c.teacher === u.id) throw fail(400, 'Это ваш собственный класс');
  if (!c.students[u.id]) { c.students[u.id] = { joined: Date.now() }; save(); }
  return c;
}

// ---------- per-user agents ----------
const agents = new Map(); // user id -> { port, token, proc, last, ready }
const starting = new Map(); // user id -> in-flight start promise (prevents parallel starts/EADDRINUSE)
const usedPorts = () => new Set([...agents.values()].map((a) => a.port).concat([...dyingPorts]));
const AGENT_PORT_BASE = Number(env.GRAPHY_AGENT_PORT_BASE || 9100);

function prepareUserDir(u) {
  const dir = path.join(USERS_DIR, u.id), work = path.join(WORK_DIR, u.id);
  // the agent owns these dirs: never let a planted symlink redirect a root-level write or chown
  for (const d of [dir, path.join(dir, 'home'), work]) { try { if (fs.lstatSync(d).isSymbolicLink()) fs.unlinkSync(d); } catch { /* absent */ } fs.mkdirSync(d, { recursive: true }); }
  // provider config is seeded once: models point at the hub's /llm proxy, the real key stays in this process
  const models = path.join(dir, 'models.json');
  dropLink(models); dropLink(path.join(dir, 'settings.json')); dropLink(path.join(dir, 'auth.json'));
  if (!fs.existsSync(models) && fs.existsSync(path.join(SEED_DIR, 'models.json'))) {
    fs.copyFileSync(path.join(SEED_DIR, 'models.json'), models);
    for (const f of ['settings.json']) if (fs.existsSync(path.join(SEED_DIR, f))) fs.copyFileSync(path.join(SEED_DIR, f), path.join(dir, f));
  }
  // the provider URL is enforced on every start: the agent must talk to the hub's /llm proxy, never to the real provider
  const sf = path.join(dir, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch { /* new user */ }
  settings.providers = { ...(settings.providers || {}), openrouter: { ...(settings.providers?.openrouter || {}), base_url: `http://127.0.0.1:${env.GRAPHY_WEB_PORT || 5174}/llm` } };
  writeNoFollow(sf, JSON.stringify(settings), 0o600);
  const auth = path.join(dir, 'auth.json');
  setDefaultKey(u);
  if (AS_USER) for (const d of [dir, path.join(dir, 'home'), work]) { try { execChown(d, u.osuid); } catch (e) { console.error('chown', e.message); } }
}
function dropLink(f) { try { if (fs.lstatSync(f).isSymbolicLink()) fs.unlinkSync(f); } catch { /* absent */ } }
export function writeNoFollow(f, data, mode) {
  const fd = fs.openSync(f, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, mode);
  try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
}
const userDir = (u) => path.join(USERS_DIR, u.id);
/** The user's own OpenRouter key (anything that is not the hub's token), or ''. */
export function ownKeyOf(u) {
  try { const k = JSON.parse(fs.readFileSync(path.join(userDir(u), 'auth.json'), 'utf8'))?.openrouter?.key; return typeof k === 'string' && k && !k.startsWith('gl-') ? k : ''; } catch { return ''; }
}
/** Default: the agent talks to the hub's /llm proxy with a personal token, the service key never leaves the hub. A key the user saved themselves is kept; other providers' keys are kept too. */
export function setDefaultKey(u) {
  const auth = path.join(userDir(u), 'auth.json');
  dropLink(auth);
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(auth, 'utf8')) || {}; } catch { /* new user */ }
  if (!ownKeyOf(u)) cur.openrouter = { ...(cur.openrouter || {}), key: llmTokenFor(u.id) };
  writeNoFollow(auth, JSON.stringify(cur), 0o600);
  if (AS_USER) { try { fs.lchownSync(auth, u.osuid, u.osuid); } catch { /* ignore */ } }
}
export function execChown(dir, uid) {
  if (fs.lstatSync(dir).isSymbolicLink()) return; // lchown semantics: never follow links planted by an agent
  fs.chownSync(dir, uid, uid); fs.chmodSync(dir, 0o700);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) execChown(p, uid); else { try { fs.lchownSync(p, uid, uid); } catch { /* ignore */ } }
  }
}
const llmTokenFor = (uid) => `gl-${uid}-${hmac(SECRET, `llm:${uid}`, 'hex').slice(0, 32)}`;

const dyingPorts = new Set();
// stop an agent and keep its port reserved until the process has really exited (otherwise the next agent fails with EADDRINUSE)
function killAgent(id, a) {
  if (agents.get(id) === a) agents.delete(id);
  dyingPorts.add(a.port);
  return new Promise((resolve) => {
    const done = () => { dyingPorts.delete(a.port); resolve(); };
    if (a.proc.exitCode !== null || a.proc.signalCode) return done();
    a.proc.once('exit', done);
    a.proc.kill('SIGTERM');
    setTimeout(() => { try { a.proc.kill('SIGKILL'); } catch { /* gone */ } }, 3000).unref();
    setTimeout(done, 6000).unref();
  });
}
async function evictOne() {
  // never evict an agent with an open request or SSE stream: that would cut another user's answer mid-flight
  const idle = [...agents.entries()].filter(([, a]) => !a.streams).sort((a, b) => a[1].last - b[1].last)[0];
  if (!idle) return false;
  await killAgent(idle[0], idle[1]);
  return true;
}
async function agentFor(u) {
  let a = agents.get(u.id);
  if (a) { a.last = Date.now(); await a.ready; return a; }
  const inflight = starting.get(u.id);
  if (inflight) { await inflight.catch(() => {}); a = agents.get(u.id); if (a) { a.last = Date.now(); await a.ready; return a; } }
  const start = (async () => {
    a = agents.get(u.id);
    if (a) { a.last = Date.now(); await a.ready; return a; }
    for (let waited = 0; agents.size >= MAX_AGENTS; ) {
      if (await evictOne()) continue;
      if ((waited += 500) > 30000) throw Object.assign(new Error('Сервер занят, повторите через минуту'), { status: 503 });
      await new Promise((r) => setTimeout(r, 500));
    }
    prepareUserDir(u);
    let port = AGENT_PORT_BASE; while (usedPorts().has(port)) port++;
    const token = crypto.randomBytes(24).toString('hex');
    const dir = path.join(USERS_DIR, u.id);
    const childEnv = {
      PATH: env.PATH, PYTHONPATH: env.PYTHONPATH, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', HOME: path.join(dir, 'home'), TMPDIR: '/tmp',
      GRAPHY_SANDBOX: env.GRAPHY_SANDBOX || 'docker', GRAPHY_SERVICE_URL: 'off', GRAPHY_DIR: dir, GRAPHY_CORE_LIBRARY: env.GRAPHY_CORE_LIBRARY, GRAPHY_RESOURCE_DIR: env.GRAPHY_RESOURCE_DIR,
      GRAPHY_TOKEN: token, GRAPHY_API_TOKEN: token, SEARXNG_URL: env.SEARXNG_URL,
      // locale and cache dirs for the document/computing tools (the root fs is read-only: caches go to /tmp)
      LANG: env.LANG || 'C.UTF-8', LC_ALL: env.LC_ALL || 'C.UTF-8', MPLBACKEND: env.MPLBACKEND || 'Agg', MPLCONFIGDIR: env.MPLCONFIGDIR || '/tmp/mplconfig',
      XDG_CACHE_HOME: env.XDG_CACHE_HOME || '/tmp/.cache', OMP_THREAD_LIMIT: env.OMP_THREAD_LIMIT || '1', PIP_NO_CACHE_DIR: '1',
      TEXMFVAR: env.TEXMFVAR || '/tmp/texmf-var', TEXMFCACHE: env.TEXMFCACHE || '/tmp/texmf-cache', TEXMFHOME: env.TEXMFHOME || '/tmp/texmf-home',
    };
    for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
    const proc = spawn('python', ['-m', 'graphy', 'serve', '--host', '127.0.0.1', '--port', String(port), '--cwd', path.join(WORK_DIR, u.id)],
      { env: childEnv, cwd: path.join(WORK_DIR, u.id), stdio: ['ignore', 'pipe', 'pipe'], ...(AS_USER ? { uid: u.osuid, gid: u.osuid } : {}) });
    let log = '';
    a = { port, token, proc, last: Date.now() };
    a.ready = new Promise((resolve, reject) => {
      const onData = (d) => { log = (log + d).slice(-4000); if (log.includes('"type":"ready"')) resolve(); };
      proc.stdout.on('data', onData); proc.stderr.on('data', onData);
      proc.on('exit', (code) => { if (agents.get(u.id)?.proc === proc) agents.delete(u.id); reject(new Error(`agent exited ${code} uid=${u.id} port=${port}: ${log.slice(-400)}`)); });
      proc.on('error', reject);
      setTimeout(() => reject(new Error('agent start timeout')), 25_000).unref();
    });
    agents.set(u.id, a);
    try { await a.ready; } catch (e) { if (agents.get(u.id)?.proc === proc) agents.delete(u.id); proc.kill('SIGKILL'); throw e; }
    return a;
  })();
  starting.set(u.id, start);
  try { return await start; } finally { if (starting.get(u.id) === start) starting.delete(u.id); }
}
setInterval(() => {
  for (const [id, a] of agents) if (Date.now() - a.last > IDLE_MS && !a.streams) killAgent(id, a);
}, 30_000).unref();

const LOCAL_ENDPOINT_MSG = 'В этом режиме нельзя указывать свой адрес API: подключите провайдера по ключу.';
/** The service key is never shown: a provider that runs on it is reported as key_source "service". */
export function markServiceKey(json, u) {
  if (ownKeyOf(u)) return json;
  const list = Array.isArray(json) ? json : json?.providers;
  if (Array.isArray(list)) for (const p of list) if (p?.name === 'openrouter' && p.configured) p.key_source = 'service';
  return json;
}
function proxyToAgent(req, res, a, incoming, u) {
  a.streams = (a.streams || 0) + 1; // keep the agent alive while a request or SSE stream is open
  const target = new URL(`http://127.0.0.1:${a.port}`);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  target.searchParams.delete('token');
  const p = incoming.pathname;
  const listing = req.method === 'GET' && /^\/api\/v1\/(bootstrap|providers)\/?$/.test(p);
  const dropsKey = req.method === 'DELETE' && p === '/api/v1/providers/openrouter';
  const guardBody = (req.method === 'PUT' || req.method === 'POST') && /^\/api\/v1\/providers(\/|$)/.test(p);
  const headers = { ...req.headers, host: target.host, authorization: `Bearer ${a.token}` };
  delete headers.origin; delete headers.cookie; if (listing) delete headers['accept-encoding'];
  const up = http.request(target, { method: req.method, headers }, (r) => {
    if (listing) {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        let out = Buffer.concat(chunks);
        try { out = Buffer.from(JSON.stringify(markServiceKey(JSON.parse(out.toString('utf8')), u))); } catch { /* pass through */ }
        const h = { ...r.headers, 'cache-control': 'no-store', 'content-length': out.length }; delete h['transfer-encoding'];
        res.writeHead(r.statusCode, h); res.end(out);
      });
      return;
    }
    if (dropsKey && r.statusCode < 400) { try { setDefaultKey(u); } catch (e) { console.error('restore key', e.message); } }
    res.writeHead(r.statusCode, { ...r.headers, 'cache-control': 'no-store' }); r.pipe(res);
  });
  const done = () => { if (a.streams > 0) { a.streams--; a.last = Date.now(); } };
  res.on('close', () => { up.destroy(); done(); });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'agent_unavailable', message: 'Нет связи с агентом' } })); });
  if (!guardBody) { req.pipe(up); return; }
  const chunks = []; let size = 0;
  req.on('data', (c) => { size += c.length; if (size > 65_536) { req.destroy(); up.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    let j = null; try { j = JSON.parse(raw.toString('utf8')); } catch { /* not json: let the agent reject it */ }
    if (j && typeof j === 'object' && (Object.hasOwn(j, 'base_url') || Object.hasOwn(j, 'api'))) { send(res, 400, { error: { code: 'invalid', message: LOCAL_ENDPOINT_MSG } }); up.destroy(); return; }
    up.end(raw);
  });
}

// ---------- public tier: the "Graphy" provider of locally installed apps ----------
// An install token (anon-<32 hex>, made by the app itself) may use three models through this server's OpenRouter key.
// Limits are by estimated worst-case cost per day: per token, per client IP and in total. GRAPHY_PUBLIC_LLM=off switches the tier off.
const PUBLIC_LLM = env.GRAPHY_PUBLIC_LLM !== 'off';
const ANON_MODELS = { 'deepseek/deepseek-v4.1-flash': [0.15, 0.6], 'anthropic/claude-haiku-5.5': [0.5, 2.5], 'anthropic/claude-sonnet-5.5': [2, 10] }; // USD per million tokens (in, out), rounded up
const ANON_CAP = { token: Number(env.GRAPHY_ANON_USD_TOKEN || 1), ip: Number(env.GRAPHY_ANON_USD_IP || 2.5), total: Number(env.GRAPHY_ANON_USD_TOTAL || 12) };
const ANON_MAX_TOKENS = 8192, ANON_BODY = 1_500_000;
const anonFile = path.join(DATA, 'anon-usage.json');
const today = () => new Date().toISOString().slice(0, 10);
let anonUsed = {};
try { const j = JSON.parse(fs.readFileSync(anonFile, 'utf8')); if (j.day === today()) anonUsed = j.used || {}; } catch { /* first run */ }
let anonDirty = false;
setInterval(() => {
  if (!anonDirty) return; anonDirty = false;
  try { fs.writeFileSync(anonFile + '.tmp', JSON.stringify({ day: today(), used: anonUsed })); fs.renameSync(anonFile + '.tmp', anonFile); } catch { /* best effort */ }
}, 20_000).unref();
export function anonCharge(id, ip, usd, caps = ANON_CAP, day = today()) {
  const kt = `${day}:t:${id}`, ki = `${day}:i:${ip}`, kg = `${day}:total`;
  if (Object.keys(anonUsed).some((k) => !k.startsWith(day))) anonUsed = Object.fromEntries(Object.entries(anonUsed).filter(([k]) => k.startsWith(day)));
  if ((anonUsed[kt] || 0) + usd > caps.token || (anonUsed[ki] || 0) + usd > caps.ip || (anonUsed[kg] || 0) + usd > caps.total) return false;
  anonUsed[kt] = (anonUsed[kt] || 0) + usd; anonUsed[ki] = (anonUsed[ki] || 0) + usd; anonUsed[kg] = (anonUsed[kg] || 0) + usd; anonDirty = true;
  return true;
}
export function anonEstimate(body, rawLength) {
  const price = ANON_MODELS[body?.model];
  if (!price) return null;
  const out = Math.min(Number(body.max_tokens || body.max_completion_tokens) || 4096, ANON_MAX_TOKENS);
  return { out, usd: ((rawLength / 3) * price[0] + out * price[1]) / 1e6 };
}
const clientIp = (req) => {
  const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const trusted = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$)/.test(peer);
  return (trusted && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || peer;
};
function anonProxy(req, res, incoming, id) {
  if (!PUBLIC_LLM || !LLM_KEY) return send(res, 503, { error: { message: 'Бесплатный режим сейчас недоступен. Попробуйте позже.' } });
  const sub = incoming.pathname.replace(/^\/llm/, '');
  const ip = clientIp(req);
  const upstream = (method, subpath, body, onResponse) => {
    const target = new URL(LLM_UPSTREAM + subpath);
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${LLM_KEY}`, accept: req.headers.accept || '*/*', host: target.host, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) };
    const up = https.request(target, { method, headers }, onResponse);
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    up.setTimeout(300_000, () => up.destroy());
    res.on('close', () => up.destroy());
    up.end(body);
  };
  if (req.method === 'GET' && sub === '/models') { // only the three models, with the provider's own metadata
    return upstream('GET', '/models', null, (r) => {
      const chunks = []; r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        let out = Buffer.concat(chunks);
        try { const j = JSON.parse(out.toString('utf8')); j.data = (j.data || []).filter((m) => ANON_MODELS[m.id]); out = Buffer.from(JSON.stringify(j)); } catch { /* pass through */ }
        res.writeHead(r.statusCode, { 'content-type': 'application/json', 'content-length': out.length }); res.end(out);
      });
    });
  }
  if (req.method !== 'POST' || sub !== '/chat/completions') return send(res, 404, { error: { message: 'not found' } });
  const chunks = []; let size = 0, dead = false;
  req.on('data', (c) => { size += c.length; if (size > ANON_BODY) { dead = true; send(res, 413, { error: { message: 'Слишком большой запрос' } }); req.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    if (dead) return;
    let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: { message: 'bad json' } }); }
    const est = anonEstimate(body, size);
    if (!est) return send(res, 403, { error: { message: 'Эта модель недоступна в бесплатном режиме.' } });
    delete body.plugins; delete body.web_search_options; delete body.transforms; delete body.route;
    body.max_tokens = est.out; delete body.max_completion_tokens;
    if (!anonCharge(id, ip, est.usd)) return send(res, 429, { error: { message: 'Лимит бесплатного режима на сегодня исчерпан. Попробуйте завтра или подключите свой ключ OpenRouter.' } });
    upstream('POST', '/chat/completions', JSON.stringify(body), (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  });
}

// ---------- LLM proxy (key stays here) ----------
const usage = new Map(); // `${uid}:${day}` -> count
function llmProxy(req, res, incoming) {
  const given = bearer(req);
  if (/^anon-[0-9a-f]{32}$/.test(given)) return anonProxy(req, res, incoming, given);
  const ownKey = /^sk-or-[\w-]{10,}$/.test(given) ? given : ''; // the user's own OpenRouter key: their account, their limits
  if (!ownKey) {
    const m = /^gl-(\d+)-([0-9a-f]{32})$/.exec(given);
    if (!m || !safeEq(hmac(SECRET, `llm:${m[1]}`, 'hex').slice(0, 32), m[2])) return send(res, 401, { error: { message: 'bad token' } });
    const key = `${m[1]}:${new Date().toISOString().slice(0, 10)}`;
    const n = (usage.get(key) || 0) + 1; usage.set(key, n);
    if (usage.size > 5000) usage.clear();
    if (n > DAILY_LLM) return send(res, 429, { error: { message: 'Дневной лимит запросов к модели исчерпан. Попробуйте завтра или подключите свой ключ OpenRouter в настройках.' } });
  }
  if (Number(req.headers['content-length'] || 0) > 16 * 1024 * 1024) return send(res, 413, { error: { message: 'too large' } });
  if (!ownKey && !LLM_KEY) return send(res, 503, { error: { message: 'Модель не настроена на сервере' } });
  const target = new URL(LLM_UPSTREAM + incoming.pathname.replace(/^\/llm/, '') + incoming.search);
  const headers = { ...req.headers, host: target.host, authorization: `Bearer ${ownKey || LLM_KEY}` };
  delete headers.origin; delete headers.cookie; delete headers['accept-encoding'];
  const up = https.request(target, { method: req.method, headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  up.setTimeout(300_000, () => up.destroy());
  res.on('close', () => up.destroy());
  req.pipe(up);
}

// ---------- dictation: WAV -> text through the local faster-whisper sidecar (stt/server.py) ----------
const STT_URL = env.GRAPHY_STT_URL || 'http://stt:8000';
async function transcribe(me, req, res, incoming) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 8 * 1024 * 1024) throw fail(413, 'Запись слишком длинная'); chunks.push(c); }
  if (!size) throw fail(400, 'Пустая запись');
  const lang = incoming.searchParams.get('lang') === 'en' ? 'en' : 'ru';
  let r;
  try { r = await fetch(`${STT_URL}/transcribe?lang=${lang}`, { method: 'POST', body: Buffer.concat(chunks), signal: AbortSignal.timeout(90_000) }); } catch { throw fail(503, 'Распознавание речи сейчас недоступно'); }
  const data = await r.json().catch(() => null);
  if (!r.ok) throw fail(502, data?.error || 'Не удалось распознать речь');
  return send(res, 200, { text: String(data?.text || '').trim() });
}

// ---------- bot ----------
async function botCall(method, pathname, body, query = '') {
  const r = await fetch(`${API}${pathname}${query}`, { method, headers: { Authorization: BOT_TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(100_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`MAX API ${method} ${pathname}: ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}
const appButton = (text, payload, uid) => (env.MAX_MINIAPP === '1'
  ? [{ type: 'open_app', text, web_app: botName, ...(payload ? { payload } : {}) }]
  : [{ type: 'link', text, url: `${PUBLIC_URL}/?t=${makeTicket(uid, payload || '')}` }]);
async function sendTo(userId, text, buttons) {
  const body = { text, ...(buttons ? { attachments: [{ type: 'inline_keyboard', payload: { buttons } }] } : {}) };
  await botCall('POST', '/messages', body, `?user_id=${userId}`);
}
const HELP = 'Команды администратора:\n/users: список\n/pending: кто просился\n/adduser <id>\n/rmuser <id>\n/addadmin <id>\n/rmadmin <id>\n/open и /close: доступ для всех или только по списку\n/myid: ваш id';
const nameOf = (id) => { const u = db.users[id]; return u ? `${displayName(u)} (${id})` : id; };
/** Returns true when the message was a command handled here. */
async function adminCommand(user, uid, cmd, arg) {
  const reply = (t) => sendTo(user.user_id, t);
  if (cmd === 'myid') { await reply(`Ваш MAX id: ${uid}`); return true; }
  if (cmd === 'claim') {
    if (CLAIM && safeEq(arg, CLAIM)) { addTo(db.admins, uid); await reply('Вы администратор Graphy. /help: список команд.'); } else await reply('Неверный код.');
    return true;
  }
  if (!['help', 'users', 'pending', 'adduser', 'rmuser', 'addadmin', 'rmadmin', 'open', 'close'].includes(cmd)) return false;
  if (!isAdmin(uid)) return false;
  const id = /^\d{1,20}$/.test(arg) ? arg : '';
  if (cmd === 'help') await reply(HELP);
  else if (cmd === 'users') await reply(`Доступ: ${db.open ? 'открыт всем' : 'по списку'}\nАдмины: ${db.admins.map(nameOf).join(', ') || '—'}\nПользователи: ${db.allowed.map(nameOf).join(', ') || '—'}`);
  else if (cmd === 'pending') await reply(Object.entries(db.pending).map(([k, v]) => `${k} ${v.name}${v.username ? ` @${v.username}` : ''}`).join('\n') || 'Никто не просился.');
  else if (cmd === 'open' || cmd === 'close') { db.open = cmd === 'open'; save(); await reply(db.open ? 'Доступ открыт всем.' : 'Доступ только по списку.'); }
  else if (!id) await reply('Нужен числовой id, например /adduser 12345');
  else if (cmd === 'adduser') { addTo(db.allowed, id); await reply(`Добавлен: ${nameOf(id)}`); }
  else if (cmd === 'rmuser') { delFrom(db.allowed, id); await reply(`Убран: ${id}`); }
  else if (cmd === 'addadmin') { addTo(db.admins, id); await reply(`Теперь администратор: ${nameOf(id)}`); }
  else if (cmd === 'rmadmin') { if (id === uid) await reply('Себя убрать нельзя.'); else { delFrom(db.admins, id); await reply(`Убран из админов: ${id}`); } }
  return true;
}
const STARTED = Date.now();
async function onUpdate(up) {
  const type = up.update_type;
  if (up.timestamp && up.timestamp < STARTED - 60_000) return; // never answer old backlog after a restart
  const user = up.user || up.message?.sender;
  if (!user || user.is_bot) return;
  if (type === 'bot_started' || type === 'message_created') {
    let payload = up.payload || '';
    if (type === 'message_created') {
      const text = up.message?.body?.text || '';
      const m = /^\/start\s+(\S+)/.exec(text);
      payload = m ? m[1] : '';
    }
    const uid = String(user.user_id);
    if (type === 'message_created') {
      const cmd = /^\/(\w+)(?:@\S+)?\s*(.*)$/s.exec((up.message?.body?.text || '').trim());
      if (cmd && await adminCommand(user, uid, cmd[1].toLowerCase(), cmd[2].trim())) return;
    }
    if (!hasAccess(uid)) {
      db.pending[uid] = { name: [user.first_name, user.last_name].filter(Boolean).join(' '), username: user.username || '', at: Date.now() }; save();
      await sendTo(user.user_id, `Доступ к Graphy пока закрыт. Ваш MAX id: ${uid}. Сообщите его администратору.`);
      return;
    }
    const m = /^j_([0-9a-f]{10})$/.exec(payload);
    let joined = null;
    const me = upsertUser({ id: user.user_id, first_name: user.first_name, last_name: user.last_name, username: user.username, photo_url: user.avatar_url || user.full_avatar_url || '' });
    if (m && db.classes[m[1]]) {
      const u = me;
      try { joined = joinClass(u, m[1]); } catch { /* own class */ }
    }
    const hello = String(user.first_name || '').trim();
    const text = joined
      ? `${hello ? `${hello}, добро` : 'Добро'} пожаловать в класс «${joined.title}»! 🎉 Откройте Graphy: всё, что учитель откроет для класса, появится там само, а ваш прогресс будет виден учителю.`
      : `${hello ? `Привет, ${hello}!` : 'Привет!'} 👋 Я Graphy, ваш ИИ-репетитор. Помогу разобраться с любой темой, подготовиться к уроку или проверить себя мини-тестом, а учителям — собрать материалы для класса. Откройте приложение кнопкой ниже: там один раз выберете, кто вы (ученик или учитель), и сразу начнём. Спрашивайте о чём угодно: глупых вопросов не бывает.`;
    await sendTo(user.user_id, text, [appButton('Открыть Graphy', joined ? `j_${joined.code}` : undefined, user.user_id)]);
  }
}
async function pollBot() {
  try { const me = await botCall('GET', '/me'); botName = botName || me.username; console.log(`MAX bot: @${botName}`); } catch (e) { console.error('MAX /me failed:', e.message); }
  let marker = null;
  for (;;) {
    try {
      const r = await botCall('GET', '/updates', null, `?timeout=30&limit=50&types=bot_started,message_created${marker ? `&marker=${marker}` : ''}`);
      if (r.marker != null) marker = r.marker;
      for (const up of r.updates || []) await onUpdate(up).catch((e) => console.error('bot update', e.message));
    } catch (e) { console.error('bot poll', e.message); await new Promise((r) => setTimeout(r, 5000)); }
  }
}

// ---------- routes ----------
async function route(req, res, incoming) {
  const p = incoming.pathname, method = req.method;
  if (p === '/hub/auth' && method === 'POST') {
    const b = await readBody(req, 16_384);
    if (b.ticket) {
      const tk = readTicket(b.ticket);
      const tu = tk ? db.users[tk.uid] : null;
      if (!tu || !hasAccess(tu.id)) throw fail(401, 'Ссылка недействительна. Напишите боту /start, чтобы получить новую.', 'bad_ticket');
      return send(res, 200, { token: sessionFor(tu.id), user: publicUser(tu), start: tk.start, bot: botName });
    }
    const v = validateInitData(b.initData);
    if (!v?.user?.id) throw fail(401, 'Не удалось подтвердить вход через MAX. Откройте приложение из MAX.', 'bad_init_data');
    if (!hasAccess(v.user.id)) {
      db.pending[String(v.user.id)] = { name: [v.user.first_name, v.user.last_name].filter(Boolean).join(' '), username: v.user.username || '', at: Date.now() };
      save();
      throw fail(403, `Доступ к Graphy пока закрыт. Ваш MAX id: ${v.user.id}. Сообщите его администратору.`, 'not_allowed');
    }
    const u = upsertUser(v.user);
    return send(res, 200, { token: sessionFor(u.id), user: publicUser(u), start: v.start || b.start || '', bot: botName, invite_base: botName ? `https://max.ru/${botName}?startapp=` : '' });
  }
  const me = userFromSession(bearer(req));
  if (!me) throw fail(401, 'Требуется вход через MAX', 'unauthorized');
  me.seen = Date.now();
  if (p === '/hub/me') return send(res, 200, { user: publicUser(me), bot: botName });
  if (p === '/hub/role' && method === 'PUT') {
    const b = await readBody(req, 1024);
    if (!['student', 'teacher'].includes(b.role)) throw fail(400, 'Роль: student или teacher');
    me.role = b.role; save();
    return send(res, 200, { user: publicUser(me) });
  }
  // teacher: classes
  if (p === '/hub/classes' && method === 'GET') {
    return send(res, 200, { classes: Object.values(db.classes).filter((c) => c.teacher === me.id).map((c) => classCard(c, true)) });
  }
  if (p === '/hub/classes' && method === 'POST') {
    if (me.role !== 'teacher') throw fail(403, 'Классы создаёт учитель');
    const b = await readBody(req, 4096);
    const title = String(b.title || '').trim().slice(0, 80);
    if (!title) throw fail(400, 'Укажите название класса');
    if (Object.values(db.classes).filter((c) => c.teacher === me.id).length >= 30) throw fail(400, 'Слишком много классов');
    const code = newCodeUnique();
    const c = db.classes[code] = { code, teacher: me.id, title, created: Date.now(), students: {} };
    save();
    return send(res, 201, { class: classCard(c, true) });
  }
  let m;
  if ((m = /^\/hub\/classes\/([0-9a-f]{10})$/.exec(p)) && method === 'DELETE') {
    const c = classOf(m[1]); teacherOnly(me, c); delete db.classes[c.code]; save(); return send(res, 200, { deleted: true });
  }
  if ((m = /^\/hub\/classes\/([0-9a-f]{10})\/students\/(\d+)$/.exec(p)) && method === 'DELETE') {
    const c = classOf(m[1]); teacherOnly(me, c); delete c.students[m[2]]; save(); return send(res, 200, { deleted: true });
  }
  if (p.startsWith('/hub/school/')) {
    const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(req, 6 * 1024 * 1024) : {};
    const r = school.handle(me, method, p, incoming.searchParams, body);
    if (r) return send(res, r.status, r.body);
  }
  if (p === '/hub/transcribe' && method === 'POST') return transcribe(me, req, res, incoming);
  // student
  if (p === '/hub/join' && method === 'POST') {
    const b = await readBody(req, 1024);
    const c = joinClass(me, String(b.code || '').replace(/^j_/, ''));
    return send(res, 200, { class: classCard(c, false) });
  }
  if (p === '/hub/student/classes' && method === 'GET') {
    return send(res, 200, { classes: Object.values(db.classes).filter((c) => c.students[me.id]).map((c) => classCard(c, false)) });
  }
  if ((m = /^\/hub\/classes\/([0-9a-f]{10})\/leave$/.exec(p)) && method === 'POST') {
    const c = classOf(m[1]); delete c.students[me.id]; save(); return send(res, 200, { left: true });
  }
  throw fail(404, 'Не найдено');
}
function newCodeUnique() { let c; do { c = newCode(); } while (db.classes[c]); return c; }

/** Returns true when the request was handled by the hub. */
export async function handleHub(req, res) {
  if (!hubEnabled()) return false;
  const incoming = new URL(req.url, 'http://localhost');
  const p = incoming.pathname;
  try {
    if (p.startsWith('/llm/')) { llmProxy(req, res, incoming); return true; }
    if (p === '/graphy-config.json') { send(res, 200, { url: '', token: '', hub: true, bot: botName }); return true; }
    if (p.startsWith('/hub/')) { await route(req, res, incoming); return true; }
    if (p.startsWith('/api/')) {
      const u = userFromSession(bearer(req) || incoming.searchParams.get('token'));
      if (!u) { send(res, 401, { error: { code: 'unauthorized', message: 'Требуется вход через MAX' } }); return true; }
      const a = await agentFor(u);
      proxyToAgent(req, res, a, incoming, u);
      return true;
    }
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: { code: e.code || 'hub_error', message: e.status ? e.message : 'Ошибка сервера' } });
    if (!e.status) console.error('hub', p, e);
    return true;
  }
  return false;
}

export function startHub() {
  if (!hubEnabled()) return;
  if (!PUBLIC_URL) console.warn('GRAPHY_PUBLIC_URL is not set');
  void pollBot();
  for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => { try { fs.writeFileSync(dbFile + '.tmp', JSON.stringify(db)); fs.renameSync(dbFile + '.tmp', dbFile); } catch { /* best effort */ } school.flush(); for (const a of agents.values()) a.proc.kill('SIGTERM'); });
}
