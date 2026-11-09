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
import net from 'node:net';
import os from 'node:os';
import https from 'node:https';
import { spawn, execFile } from 'node:child_process';
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

// The hub's data (hub.json, logs with learners' texts, stats, anonymous tokens) must never be readable from an agent sandbox: those run as other uids.
fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
try { fs.chmodSync(DATA, 0o700); for (const f of fs.readdirSync(DATA)) { const fp = path.join(DATA, f); try { if (fs.statSync(fp).isFile()) fs.chmodSync(fp, 0o600); } catch { /* ignore */ } } } catch { /* not ours to chmod (e.g. a mounted volume owned by someone else) */ }

// ---------- storage ----------
const dbFile = path.join(DATA, 'hub.json');
let db = { users: {}, classes: {}, nextUid: 20000, admins: [], allowed: [], pending: {}, open: false, blocked: [], llmOff: false, userLimits: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(dbFile, 'utf8')) }; } catch { /* first run */ }
if (!Array.isArray(db.reports)) db.reports = []; // messages the AI agents sent to the admin (report_to_admin), newest last, kept to 100
// writing the text of learners' requests into the log is an explicit, switchable choice (/prompts on|off); GRAPHY_LOG_PROMPTS=1 sets the initial value
if (typeof db.logPrompts !== 'boolean') db.logPrompts = env.GRAPHY_LOG_PROMPTS === '1';
let dirty = false;
const save = () => { dirty = true; };
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  try { fs.writeFileSync(dbFile + '.tmp', JSON.stringify(db), { mode: 0o600 }); fs.renameSync(dbFile + '.tmp', dbFile); } catch (e) { console.error('hub save failed', e.message); }
}, 1500).unref();
const secretFile = path.join(DATA, 'secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();

const school = createSchool({ dir: DATA, classes: () => db.classes, users: () => db.users });

// ---------- access control ----------
const isAdmin = (id) => db.admins.includes(String(id));
const isBlocked = (id) => (db.blocked || []).includes(String(id));
// an admin can never be locked out; a blocked id has no access even when access is open to everyone
const hasAccess = (id) => isAdmin(id) || (!isBlocked(id) && (db.open || db.allowed.includes(String(id))));
/** Test hook: the live hub state. */
export const dbForTests = () => db;
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
const userFromSessionId = (token) => { try { return String(JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString()).u); } catch { return ''; } };
/** What a blocked person is told (app, bot, models): clear, with the id to give to the administrator. */
export const blockedMessage = (uid) => `Ваш аккаунт заблокирован администратором. Если это ошибка, напишите ему и сообщите свой MAX id: ${uid}.`;
/** True when the session token is genuine and not expired but belongs to a blocked user (so he gets "blocked", not "log in again"). */
export const sessionBlocked = (token) => {
  const [v, body, sig] = String(token || '').split('.');
  if (v !== 'v1' || !body || !sig || !safeEq(hmac(SECRET, body, 'base64url'), sig)) return false;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.e > Date.now() && isBlocked(p.u) && !isAdmin(p.u); } catch { return false; }
};
const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
/** Name for lists a teacher or admin reads: "Имя Фамилия (@username)", only @username when there is no name. */
export const nameWithUsername = (u) => {
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ');
  return full ? (u.username ? `${full} (@${u.username})` : full) : (u.username ? `@${u.username}` : `id${u.id}`);
};
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
  const base = { code: c.code, title: c.title, created: c.created, invite: inviteLink(c.code), teacher: t ? { id: t.id, name: nameWithUsername(t), photo_url: t.photo_url } : null };
  if (!forTeacher) return base;
  return { ...base, students: Object.entries(c.students).map(([sid, s]) => {
    const u = db.users[sid];
    return { id: sid, name: u ? nameWithUsername(u) : sid, photo_url: u?.photo_url || '', joined: s.joined };
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
// ports whose process could not be stopped, or that something else already holds: never hand them out again
const stuckPorts = new Set();
const usedPorts = () => new Set([...agents.values()].map((a) => a.port).concat([...dyingPorts], [...stuckPorts]));
/** Ask the OS instead of trusting our own bookkeeping: an orphaned agent still holds its port even though no map entry knows about it. */
export const portFree = (port) => new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', () => resolve(false));
  srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
});
/** True when /proc/self/status shows no CAP_KILL (bit 5). Without it root cannot stop agents that run under other uids. */
export const missingKillCap = (status) => {
  const m = /^CapEff:\s*([0-9a-fA-F]+)/m.exec(String(status));
  return !!m && (BigInt('0x' + m[1]) & (1n << 5n)) === 0n;
};
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

/** Kill every process that runs under a user's sandbox uid (background servers, tunnels, anything started with nohup/setsid).
 *  Only real sandbox uids (>= 20000) are ever touched, never root and never the hub itself. Returns how many were killed. */
export function killUserProcesses(osuid, procDir = '/proc', kill = (pid) => process.kill(pid, 'SIGKILL'), except = new Set()) {
  if (!Number.isInteger(osuid) || osuid < 20000) return 0;
  let n = 0;
  let entries = []; try { entries = fs.readdirSync(procDir); } catch { return 0; }
  for (const d of entries) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const m = /^Uid:\s+(\d+)/m.exec(fs.readFileSync(path.join(procDir, d, 'status'), 'utf8'));
      if (m && Number(m[1]) === osuid && !except.has(Number(d))) { kill(Number(d)); n++; }
    } catch { /* the process is already gone */ }
  }
  return n;
}
const sweepIfGone = (id) => { if (AS_USER && !agents.has(id)) { const n = killUserProcesses(db.users[id]?.osuid); if (n) console.log(`[hub] killed ${n} leftover process(es) of user ${id}`); } };
const dyingPorts = new Set();
// stop an agent and keep its port reserved until the process has really exited (otherwise the next agent fails with EADDRINUSE)
function killAgent(id, a) {
  if (agents.get(id) === a) agents.delete(id);
  dyingPorts.add(a.port);
  return new Promise((resolve) => {
    const done = () => { dyingPorts.delete(a.port); sweepIfGone(id); resolve(); };
    if (a.proc.exitCode !== null || a.proc.signalCode) return done();
    a.proc.once('exit', () => { stuckPorts.delete(a.port); done(); });
    // kill() returns false when the signal could not be delivered (EPERM: the container lacks CAP_KILL). The process then lives on and keeps its port.
    if (!a.proc.kill('SIGTERM')) {
      console.error(`[hub] cannot signal agent pid ${a.proc.pid} on port ${a.port}: CAP_KILL missing? The port stays reserved.`);
      stuckPorts.add(a.port);
    }
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
/** Files a sandbox user creates are private (umask 077); a user cannot start more than 100 tasks or write a file over 2 GiB. */
export const agentShellScript = (asUser) => `umask 077; ${asUser ? 'ulimit -u 100; ulimit -f 2097152; ulimit -n 2048; ' : ''}exec "$0" "$@"`;
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
    for (let attempt = 0; ; attempt++) {
    let port = AGENT_PORT_BASE; while (usedPorts().has(port) || !(await portFree(port))) port++;
    const token = crypto.randomBytes(24).toString('hex');
    const dir = path.join(USERS_DIR, u.id);
    const childEnv = {
      PATH: env.PATH, PYTHONPATH: env.PYTHONPATH, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', HOME: path.join(dir, 'home'), TMPDIR: '/tmp',
      GRAPHY_SANDBOX: env.GRAPHY_SANDBOX || 'docker', GRAPHY_SERVICE_URL: 'off', GRAPHY_DIR: dir, GRAPHY_CORE_LIBRARY: env.GRAPHY_CORE_LIBRARY, GRAPHY_RESOURCE_DIR: env.GRAPHY_RESOURCE_DIR,
      GRAPHY_TOKEN: token, GRAPHY_API_TOKEN: token, SEARXNG_URL: env.SEARXNG_URL,
      // lets the agent tell the administrator about abuse (tool report_to_admin); also switches on its hosted-mode bash policy
      GRAPHY_REPORT_URL: `http://127.0.0.1:${env.GRAPHY_WEB_PORT || 5174}/hub/agent-report`, GRAPHY_REPORT_TOKEN: llmTokenFor(u.id),
      // locale and cache dirs for the document/computing tools (the root fs is read-only: caches go to /tmp)
      LANG: env.LANG || 'C.UTF-8', LC_ALL: env.LC_ALL || 'C.UTF-8', MPLBACKEND: env.MPLBACKEND || 'Agg', MPLCONFIGDIR: env.MPLCONFIGDIR || '/tmp/mplconfig',
      XDG_CACHE_HOME: env.XDG_CACHE_HOME || '/tmp/.cache', OMP_THREAD_LIMIT: env.OMP_THREAD_LIMIT || '1', PIP_NO_CACHE_DIR: '1',
      TEXMFVAR: env.TEXMFVAR || '/tmp/texmf-var', TEXMFCACHE: env.TEXMFCACHE || '/tmp/texmf-cache', TEXMFHOME: env.TEXMFHOME || '/tmp/texmf-home',
    };
    for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
    const proc = spawn('bash', ['-c', agentShellScript(AS_USER), 'python', '-m', 'graphy', 'serve', '--host', '127.0.0.1', '--port', String(port), '--cwd', path.join(WORK_DIR, u.id)],
      { env: childEnv, cwd: path.join(WORK_DIR, u.id), stdio: ['ignore', 'pipe', 'pipe'], ...(AS_USER ? { uid: u.osuid, gid: u.osuid } : {}) });
    let log = '';
    a = { port, token, proc, last: Date.now() };
    a.ready = new Promise((resolve, reject) => {
      const onData = (d) => { log = (log + d).slice(-4000); if (log.includes('"type":"ready"')) resolve(); };
      proc.stdout.on('data', onData); proc.stderr.on('data', onData);
      proc.on('exit', (code) => { if (agents.get(u.id)?.proc === proc) { agents.delete(u.id); setTimeout(() => sweepIfGone(u.id), 500).unref(); } reject(new Error(`agent exited ${code} uid=${u.id} port=${port}: ${log.slice(-400)}`)); });
      proc.on('error', reject);
      setTimeout(() => reject(new Error('agent start timeout')), 25_000).unref();
    });
    agents.set(u.id, a);
    try { await a.ready; } catch (e) {
      if (agents.get(u.id)?.proc === proc) agents.delete(u.id);
      proc.kill('SIGKILL');
      // something grabbed the port between our check and the bind: remember it as busy and try the next one
      if (attempt < 2 && /Address already in use/.test(String(e.message))) { stuckPorts.add(port); continue; }
      throw e;
    }
    return a;
    }
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
  try { fs.writeFileSync(anonFile + '.tmp', JSON.stringify({ day: today(), used: anonUsed }), { mode: 0o600 }); fs.renameSync(anonFile + '.tmp', anonFile); } catch { /* best effort */ }
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
/** Which peers may set X-Forwarded-For. Inside the docker container the reverse proxy reaches us from the bridge gateway (x.x.x.1);
 *  agent sandboxes come from 127.0.0.1 or the container's own address and must NOT be able to fake a client IP. */
export function detectTrustedProxies(environment = env, asUser = AS_USER, interfaces = os.networkInterfaces()) {
  const out = new Set();
  if (environment.GRAPHY_TRUSTED_PROXIES) { for (const x of environment.GRAPHY_TRUSTED_PROXIES.split(',')) if (x.trim()) out.add(x.trim()); return out; }
  if (asUser) {
    for (const list of Object.values(interfaces)) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) { const q = a.address.split('.'); out.add(`${q[0]}.${q[1]}.${q[2]}.1`); }
    return out;
  }
  return new Set(['127.0.0.1', '::1']); // local development behind a local proxy
}
const TRUSTED_PROXIES = detectTrustedProxies();
export const resolveClientIp = (peerRaw, forwardedFor, proxies = TRUSTED_PROXIES) => {
  const peer = String(peerRaw || '').replace(/^::ffff:/, '');
  return (proxies.has(peer) && String(forwardedFor || '').split(',')[0].trim()) || peer;
};
const clientIp = (req) => resolveClientIp(req.socket.remoteAddress, req.headers['x-forwarded-for']);
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
    if (db.logPrompts) promptOf.set(res, { text: lastUserText(body), model: String(body?.model || '') });
    if (!est) return send(res, 403, { error: { message: 'Эта модель недоступна в бесплатном режиме.' } });
    delete body.plugins; delete body.web_search_options; delete body.transforms; delete body.route;
    body.max_tokens = est.out; delete body.max_completion_tokens;
    if (!anonCharge(id, ip, est.usd)) return send(res, 429, { error: { message: 'Лимит бесплатного режима на сегодня исчерпан. Попробуйте завтра или подключите свой ключ OpenRouter.' } });
    upstream('POST', '/chat/completions', JSON.stringify(body), (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  });
}

// ---------- LLM guard: JSONL log, daily stats, limits, block list, kill switch, admin alerts ----------
const LLM_DAILY_TOTAL = Number(env.GRAPHY_DAILY_LLM_TOTAL || 6000); // all signed-in users together, per UTC day
const LLM_PER_MIN = Number(env.GRAPHY_LLM_PER_MIN || 40); // per signed-in user, sliding minute
const LLM_IP_PER_MIN = Number(env.GRAPHY_LLM_IP_PER_MIN || 120); // per client IP, sliding minute (loopback is skipped: agents reach us from 127.0.0.1)
const ACTIVE_REQ = Number(env.GRAPHY_ACTIVE_ALERT_REQUESTS || 100); // "actively using the agent": this many requests ...
const ACTIVE_MS = Number(env.GRAPHY_ACTIVE_ALERT_MINUTES || 15) * 60_000; // ... within this window
const ALERT_EVERY_MS = 60 * 60_000; // one alert per event key per hour
const llmLogFile = path.join(DATA, 'llm.log');
const LLM_LOG_MAX = 5 * 1024 * 1024;
const llmStatsFile = path.join(DATA, 'llm-stats.json');
const dayOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 10); // UTC
const blankStat = () => ({ req: 0, e4: 0, e5: 0, denied: 0, last: 0, used: 0 });
const freshStats = (day) => ({ day, total: blankStat(), userUsed: 0, uid: {}, ip: {}, own: blankStat(), anon: { total: blankStat(), id: {}, ip: {} } });
let llmStats = freshStats(dayOf());
try {
  const j = JSON.parse(fs.readFileSync(llmStatsFile, 'utf8'));
  if (j.day === dayOf()) { const f = freshStats(j.day); llmStats = { ...f, ...j, anon: { ...f.anon, ...(j.anon || {}) } }; }
} catch { /* first run or another day */ }
let llmStatsDirty = false;
export function flushLlmStats() {
  if (!llmStatsDirty) return; llmStatsDirty = false;
  try { fs.writeFileSync(llmStatsFile + '.tmp', JSON.stringify(llmStats), { mode: 0o600 }); fs.renameSync(llmStatsFile + '.tmp', llmStatsFile); } catch { /* best effort */ }
}
setInterval(flushLlmStats, 20_000).unref();
const rollDay = (now) => { const d = dayOf(now); if (llmStats.day !== d) { llmStats = freshStats(d); llmStatsDirty = true; } };
export const llmStatsSnapshot = () => llmStats;

const loopback = (ip) => !ip || /^(127\.|::1$)/.test(ip);
const hits = new Map(); // `u:<kind>:<id>` | `i:<ip>` -> times of admitted requests inside the activity window
const slide = (key, now) => { const a = (hits.get(key) || []).filter((t) => now - t < ACTIVE_MS); hits.set(key, a); return a; };
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.length || now - a[a.length - 1] > ACTIVE_MS) hits.delete(k); }, 5 * 60_000).unref();

// ----- how a user is shown to the admin: name, @username, id and (when there is a username) a max.ru profile link
export function userLabel(id) {
  id = String(id);
  const u = db.users[id];
  if (!u) return `id ${id}`;
  const name = displayName(u);
  return u.username ? `${name} (@${u.username}, ${id}) https://max.ru/${u.username}` : `${name} (id ${id})`;
}
export const anonLabel = (shortId, ip) => `anon ${shortId}${ip && !loopback(ip) ? ` (IP ${ip})` : ''}`;
const principalLabel = (kind, id, ip) => (kind === 'anon' ? anonLabel(id, ip) : String(id).startsWith('own:') ? `свой ключ ${String(id).slice(4)}` : userLabel(id));

// ----- admin alerts in MAX, at most one per event key per hour
const alertAt = new Map();
export function notifyAdmins(key, text, now = Date.now(), sender = (...a) => sendTo(...a), everyMs = ALERT_EVERY_MS) {
  const last = alertAt.get(key);
  if (last !== undefined && now - last < everyMs) return false;
  if (alertAt.size > 2000) alertAt.clear();
  alertAt.set(key, now);
  for (const a of db.admins) Promise.resolve().then(() => sender(a, text)).catch((e) => console.error('alert failed', a, e.message));
  return true;
}

// ----- suspicious activity: each detector returns an alert event { key, text } exactly when its threshold is crossed (or null)
const SUSP_AUTH_FAILS = Number(env.GRAPHY_SUSPICIOUS_AUTH_FAILS || 10); // forged tokens / login data from one IP within 10 min
const SUSP_ANON_TOKENS = Number(env.GRAPHY_SUSPICIOUS_ANON_TOKENS || 8); // distinct anonymous install tokens from one IP within an hour
const SUSP_LIMIT_HITS = Number(env.GRAPHY_SUSPICIOUS_LIMIT_HITS || 5); // refusals by the limits for one principal within 10 min
const SUSP_BLOCKED_HITS = Number(env.GRAPHY_SUSPICIOUS_BLOCKED_HITS || 5); // attempts of a blocked user within 10 min
const SUSP_CLAIM_FAILS = Number(env.GRAPHY_SUSPICIOUS_CLAIM_FAILS || 3); // wrong /claim codes from one user within an hour
const TEN_MIN = 10 * 60_000, HOUR = 60 * 60_000;
const suspicion = new Map(); // detector key -> times
const anonByIp = new Map(); // ip -> Map(anon id -> last seen)
/** True exactly when the count inside the window reaches `limit` (so a continuing burst alerts once, not on every request). */
export function noteSuspicious(key, limit, windowMs, now = Date.now()) {
  const a = (suspicion.get(key) || []).filter((t) => now - t < windowMs);
  a.push(now); suspicion.set(key, a);
  return a.length === limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of suspicion) if (!a.length || now - a[a.length - 1] > HOUR) suspicion.delete(k);
  for (const [ip, m] of anonByIp) { for (const [id, t] of m) if (now - t > HOUR) m.delete(id); if (!m.size) anonByIp.delete(ip); }
}, 5 * 60_000).unref();
/** Forged or wrong credentials (bad /llm token, bad login ticket or MAX data) from one address. Loopback is ignored. */
export function reportAuthFail(ip, what = 'неверные данные входа', now = Date.now()) {
  if (loopback(ip) || !noteSuspicious(`auth:${ip}`, SUSP_AUTH_FAILS, TEN_MIN, now)) return null;
  return { key: `susp-auth:${ip}`, text: `Подозрительная активность: с IP ${ip} ${SUSP_AUTH_FAILS} раз за 10 минут пришли неверные данные входа (${what}). Похоже на подбор или подделку токенов.` };
}
/** A wrong /claim code: someone may be guessing the admin code. */
export function reportClaimFail(label, uid, now = Date.now()) {
  if (!noteSuspicious(`claim:${uid}`, SUSP_CLAIM_FAILS, HOUR, now)) return null;
  return { key: `susp-claim:${uid}`, text: `Подозрительная активность: ${label} ${SUSP_CLAIM_FAILS} раза за час ввёл неверный код /claim. Возможен подбор кода администратора.` };
}
/** Many different anonymous install tokens from one address: a way around the per-token cap. */
function noteAnonToken(ip, id, now) {
  if (loopback(ip)) return null;
  let m = anonByIp.get(ip); if (!m) anonByIp.set(ip, (m = new Map()));
  for (const [k, t] of m) if (now - t > HOUR) m.delete(k);
  const had = m.has(id); m.set(id, now);
  if (!had && m.size === SUSP_ANON_TOKENS) return { key: `susp-anon:${ip}`, text: `Подозрительная активность: с IP ${ip} за час пришло ${SUSP_ANON_TOKENS} разных анонимных токенов. Возможно, обход лимита на токен.` };
  return null;
}

// ----- individual limits set by an admin with /setlimit (hub.json: db.userLimits[uid] = { daily?, perMin? })
// Users who registered after this moment get the smaller NEW_USER_DAILY limit (default 40 requests a day), until an admin changes it with /setlimit.
const NEW_USER_DAILY = Number(env.GRAPHY_NEW_USER_DAILY || 40);
if (!db.newUsersSince) { db.newUsersSince = Date.now(); save(); }
export const limitsOf = (uid) => {
  const o = (db.userLimits || {})[String(uid)] || {};
  const u = db.users[String(uid)];
  const isNew = !!(u && u.created >= db.newUsersSince);
  return { daily: o.daily ?? (isNew ? (db.newUserDaily ?? NEW_USER_DAILY) : DAILY_LLM), perMin: o.perMin ?? LLM_PER_MIN, custom: !!(o.daily || o.perMin), isNew };
};

// ----- decide whether a /llm request may pass. Returns { ok, status, message, events } (events are admin alerts to send)
export function llmAdmit({ kind, uid = '', id = '', ip = '', now = Date.now() }) {
  rollDay(now);
  const events = [];
  const deny = (status, message) => ({ ok: false, status, message, events });
  if (kind === 'own') return { ok: true, events }; // the user's own OpenRouter key: their account, not ours
  const admin = kind === 'user' && isAdmin(uid);
  if (kind === 'user' && !admin && isBlocked(uid)) {
    if (noteSuspicious(`blocked:${uid}`, SUSP_BLOCKED_HITS, TEN_MIN, now)) events.push({ key: `susp-blocked:${uid}`, text: `Подозрительная активность: заблокированный ${userLabel(uid)} продолжает слать запросы к моделям (${SUSP_BLOCKED_HITS}+ за 10 минут).` });
    return deny(403, blockedMessage(uid));
  }
  if (admin) return { ok: true, events }; // admins are outside every limit and the pause
  if (db.llmOff) return deny(503, 'Модели временно приостановлены администратором. Попробуйте позже.');
  const who = kind === 'user' ? uid : id;
  const lim = kind === 'user' ? limitsOf(uid) : { daily: DAILY_LLM, perMin: LLM_PER_MIN };
  const uh = slide(`u:${kind}:${who}`, now);
  const ikey = loopback(ip) ? '' : `i:${ip}`;
  const ih = ikey ? slide(ikey, now) : [];
  const lastMinute = (a) => a.filter((t) => now - t < 60_000).length;
  const st = llmStats;
  const limitHit = (pk, label) => { if (noteSuspicious(`limit:${pk}`, SUSP_LIMIT_HITS, TEN_MIN, now)) events.push({ key: `susp-limit:${pk}`, text: `Подозрительная активность: ${label} ${SUSP_LIMIT_HITS} раз за 10 минут упёрся в лимиты запросов и продолжает.` }); };
  if (kind === 'user' && lastMinute(uh) >= lim.perMin) {
    events.push({ key: `minute:${uid}`, text: `Сработал лимит ${lim.perMin} запросов в минуту${lim.custom ? ' (индивидуальный)' : ''}: ${userLabel(uid)}.` });
    limitHit(`u:${uid}`, userLabel(uid));
    return deny(429, 'Слишком много запросов за минуту. Подождите немного и повторите.');
  }
  if (ikey && lastMinute(ih) >= LLM_IP_PER_MIN) {
    events.push({ key: `ipminute:${ip}`, text: `Сработал лимит ${LLM_IP_PER_MIN} запросов в минуту с IP ${ip}${kind === 'anon' ? ` (${anonLabel(id, ip)})` : ''}.` });
    limitHit(`i:${ip}`, `IP ${ip}`);
    return deny(429, 'С вашего адреса слишком много запросов. Подождите минуту и повторите.');
  }
  if (kind === 'user') {
    if ((st.uid[uid]?.used || 0) >= lim.daily) return deny(429, 'Дневной лимит запросов к модели исчерпан. Попробуйте завтра или подключите свой ключ OpenRouter в настройках.');
    if (st.userUsed >= LLM_DAILY_TOTAL) return deny(429, 'Общий суточный лимит запросов к моделям исчерпан. Попробуйте завтра.');
  }
  uh.push(now); if (ikey) ih.push(now); // admitted
  if (kind === 'anon') { const ev = noteAnonToken(ip, id, now); if (ev) events.push(ev); }
  if (kind === 'user') {
    const s = (st.uid[uid] ||= blankStat());
    s.used++; st.userUsed++; llmStatsDirty = true;
    const at80 = Math.ceil(lim.daily * 0.8);
    if (s.used === at80 && at80 < lim.daily) events.push({ key: `uid80:${uid}:${st.day}`, text: `${userLabel(uid)} израсходовал 80% суточного лимита (${s.used} из ${lim.daily} запросов${lim.custom ? ', лимит индивидуальный' : ''}).` });
    if (s.used === lim.daily) events.push({ key: `uid100:${uid}:${st.day}`, text: `${userLabel(uid)} исчерпал суточный лимит (${lim.daily} запросов). Дальше он получает отказ 429 до конца суток по UTC.` });
    for (const pct of [50, 80, 100]) {
      if (Math.ceil((LLM_DAILY_TOTAL * pct) / 100) === st.userUsed) events.push({ key: `total${pct}:${st.day}`, text: `Общий расход запросов за сутки: ${pct}% лимита (${st.userUsed} из ${LLM_DAILY_TOTAL}).` });
    }
  }
  if (uh.filter((t) => now - t < ACTIVE_MS).length === ACTIVE_REQ) {
    events.push({ key: `active:${kind}:${who}`, text: `Активное использование агента: ${principalLabel(kind, who, ip)}, ${ACTIVE_REQ} запросов за ${Math.round(ACTIVE_MS / 60_000)} мин.` });
  }
  return { ok: true, events };
}

// ----- JSONL log with rotation (llm.log -> llm.log.1 at 5 MB). Never contains tokens or keys.
const logSizes = new Map();
export function llmLog(entry, file = llmLogFile, max = LLM_LOG_MAX) {
  try {
    const line = JSON.stringify(entry) + '\n';
    let size = logSizes.get(file);
    if (size === undefined) { try { size = fs.statSync(file).size; } catch { size = 0; } }
    if (size + Buffer.byteLength(line) > max) { try { fs.renameSync(file, file + '.1'); } catch { /* nothing to rotate */ } size = 0; }
    fs.appendFileSync(file, line, { mode: 0o600 });
    logSizes.set(file, size + Buffer.byteLength(line));
  } catch { /* logging must never break a request */ }
}

// ----- the learner's own words, for the log (only when db.logPrompts is on). Secrets pasted into a message are masked.
const SECRET_RE = /\b(?:sk-[\w-]{16,}|gl-\d+-[0-9a-f]{32}|anon-[0-9a-f]{32}|ghp_\w{20,}|github_pat_\w{20,}|AIza[\w-]{30,})|Bearer\s+[\w.~+/=-]{20,}/g;
export const maskSecrets = (t) => String(t).replace(SECRET_RE, '[скрыто]');
/** Text of the last user message of a chat request: the learner's part of the app wrapper, one line, masked, at most `max` characters. */
export function lastUserText(body, max = 600) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]; if (m?.role !== 'user') continue;
    let c = m.content;
    if (Array.isArray(c)) c = c.filter((x) => x?.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n');
    if (typeof c !== 'string') continue;
    const learner = /<learner_message>\n?([\s\S]*?)\n?<\/learner_message>/.exec(c);
    if (learner) c = learner[1];
    c = maskSecrets(c.replace(/\s+/g, ' ').trim());
    if (!c || c === 'Tool image result:') continue;
    return c.length > max ? c.slice(0, max) + '…' : c;
  }
  return '';
}
const promptOf = new WeakMap(); // response -> { text, model } captured while the request was forwarded
/** Split a long admin reply into MAX-sized messages at line breaks. */
export function chunkText(t, n = 3500) {
  const out = []; let cur = '';
  for (const line of String(t).split('\n')) {
    if (cur && cur.length + line.length + 1 > n) { out.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + (line.length > n ? line.slice(0, n) : line);
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

// ----- record the finished request: log line + daily stats
export function llmRecord({ kind, id, ip, path: p, status, ms, bytes, text = '', model = '', now = Date.now() }) {
  rollDay(now);
  llmLog({ t: new Date(now).toISOString(), kind, id, ip, path: p, status, ms, bytes, ...(model ? { model } : {}), ...(text ? { text } : {}) });
  const st = llmStats;
  const bump = (s) => { s.req++; if (status === 429) s.denied++; if (status >= 400 && status < 500) s.e4++; else if (status >= 500) s.e5++; s.last = now; };
  const into = (map, key) => {
    bump((map[key] ||= blankStat()));
    const keys = Object.keys(map);
    if (keys.length > 2000) delete map[keys.sort((x, y) => map[x].last - map[y].last)[0]]; // keep memory bounded: drop the stalest
  };
  bump(st.total);
  if (kind === 'anon') { bump(st.anon.total); into(st.anon.id, id); if (!loopback(ip)) into(st.anon.ip, ip); }
  else { if (kind === 'own') bump(st.own); if (id && id !== '-') into(st.uid, id); if (!loopback(ip)) into(st.ip, ip); }
  llmStatsDirty = true;
}

// ----- texts for the admin commands
const fmtTime = (ms) => { if (!ms) return '—'; try { return new Date(ms).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }) + ' МСК'; } catch { return new Date(ms).toISOString().slice(11, 16) + ' UTC'; } };
const statLine = (s) => `${s.req} запр.${s.e4 ? `, 4xx: ${s.e4}` : ''}${s.e5 ? `, 5xx: ${s.e5}` : ''}${s.denied ? `, отказов 429: ${s.denied}` : ''}, последний: ${fmtTime(s.last)}`;
const topOf = (map, n) => Object.entries(map).sort((a, b) => b[1].req - a[1].req).slice(0, n);
const anonSpent = () => anonUsed[`${today()}:total`] || 0;
const RESET_NOTE = 'Сутки считаются по UTC и сбрасываются в 03:00 по Москве.';
export function statsText(now = Date.now()) {
  rollDay(now);
  const st = llmStats;
  const kidIds = Object.keys(st.uid).filter((id) => !id.startsWith('own:'));
  const kids = kidIds.reduce((a, id) => { a.req += st.uid[id].req; return a; }, { req: 0 });
  const okIds = kidIds.filter((id) => !isBlocked(id)); const badIds = kidIds.filter((id) => isBlocked(id));
  const top = topOf(Object.fromEntries(okIds.map((id) => [id, st.uid[id]])), 10).map(([id, s], i) => `${i + 1}. ${principalLabel('user', id)}: ${statLine(s)}`);
  const blockedRows = topOf(Object.fromEntries(badIds.map((id) => [id, st.uid[id]])), 10).map(([id, s]) => `${principalLabel('user', id)}: ${statLine(s)}`);
  return [
    `Статистика за сутки (${st.day}, UTC)`,
    `Запросов к моделям: ${st.total.req}, отказов 429: ${st.total.denied}, ошибок 4xx: ${st.total.e4}, 5xx: ${st.total.e5}`,
    '',
    `Ученики и учителя (вход через MAX): ${kids.req} запр. от ${kidIds.length} польз., ${st.userUsed} из ${LLM_DAILY_TOTAL} в общем суточном лимите`,
    `Жюри (анонимные токены): ${st.anon.total.req} запр. от ${Object.keys(st.anon.id).length} токенов, расход ${anonSpent().toFixed(2)} из ${ANON_CAP.total} USD.`,
    ...(st.own.req ? [`Со своим ключом OpenRouter: ${st.own.req} запр.`] : []),
    '',
    `Пауза LLM: ${db.llmOff ? 'ВКЛЮЧЕНА (/llmon чтобы снять)' : 'нет'}`,
    `Текст запросов в логе: ${db.logPrompts ? 'пишется (/prompts off чтобы выключить)' : 'не пишется (/prompts on чтобы включить)'}`,
    'Топ-10 учеников и учителей:', ...(top.length ? top : ['пока никого']), ...(blockedRows.length ? ['', '🚫 Заблокированные (за сутки):', ...blockedRows] : []), '', RESET_NOTE,
  ].join('\n');
}
export function topText() {
  const st = llmStats;
  const pick = (want) => Object.fromEntries(Object.entries(st.uid).filter(([id]) => isBlocked(id) === want));
  const blockedUsers = topOf(pick(true), 20).map(([id, s]) => `${principalLabel('user', id)}: ${s.req} запр., 4xx ${s.e4}, 5xx ${s.e5}, 429: ${s.denied}`);
  const users = topOf(pick(false), 20).map(([id, s], i) => `${i + 1}. ${principalLabel('user', id)}: ${s.req} запр., 4xx ${s.e4}, 5xx ${s.e5}, 429: ${s.denied}`);
  const ips = topOf(st.ip, 10).map(([ip, s], i) => `${i + 1}. ${ip}: ${s.req} запр., 4xx ${s.e4}, 5xx ${s.e5}, 429: ${s.denied}`);
  const anon = topOf(st.anon.ip, 10).map(([ip, s], i) => `${i + 1}. ${ip}: ${s.req} запр., 4xx ${s.e4}, 5xx ${s.e5}, 429: ${s.denied}`);
  return [`Топ за сутки (${st.day}, UTC)`, '', 'Топ-20 по пользователям:', ...(users.length ? users : ['пока никого']), ...(blockedUsers.length ? ['', '🚫 Заблокированные:', ...blockedUsers] : []), '', 'Топ-10 по IP:', ...(ips.length ? ips : ['пока никого']), '', 'Анонимные (по IP):', ...(anon.length ? anon : ['пока никого']), '', RESET_NOTE].join('\n');
}

const KIND_NAME = { user: 'ученик/учитель (вход через MAX)', anon: 'жюри (анонимный токен)', own: 'свой ключ OpenRouter' };
const logTime = (iso) => { try { return new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return iso; } };
/** Last `n` log lines matching an id (MAX id, short anonymous token id) or an IP, oldest first. Reads llm.log.1 then llm.log. */
export function readLlmLog(query, n = 20, files = [llmLogFile + '.1', llmLogFile]) {
  const q = String(query).trim().toLowerCase(); const out = []; let total = 0;
  for (const f of files) {
    let text = ''; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (String(e.id).toLowerCase() === q || String(e.ip).toLowerCase() === q || (e.kind === 'anon' && String(e.id).toLowerCase().startsWith(q) && q.length >= 4)) { total++; out.push(e); if (out.length > n) out.shift(); }
    }
  }
  return { rows: out, total };
}
export function logText(query, n = 20) {
  const q = String(query).trim();
  if (!/^[0-9a-fA-F:.\-]{3,45}$/.test(q)) return 'Нужен MAX id, id анонимного токена (8 символов) или IP-адрес, например /log 12345 или /log 203.0.113.5';
  const { rows, total } = readLlmLog(q, n);
  const kind = rows[rows.length - 1]?.kind;
  const isIp = /[.:]/.test(q);
  const head = isIp ? `IP ${q}` : kind === 'anon' ? anonLabel(q.slice(0, 8), rows[rows.length - 1]?.ip) : /^\d+$/.test(q) ? userLabel(q) : q;
  const lines = rows.flatMap((e) => [
    `${logTime(e.t)} ${e.path.replace(/^\/llm/, '')} ${e.status} ${(e.ms / 1000).toFixed(1)}с ${e.bytes ? `${Math.max(1, Math.round(e.bytes / 1024))} КБ` : '-'}${e.model ? ` ${e.model}` : ''}${isIp ? ` [${KIND_NAME[e.kind] ? e.kind : '?'} ${e.id}]` : ''}`,
    ...(e.text ? [`   » ${e.text.length > 300 ? e.text.slice(0, 300) + '…' : e.text}`] : []),
  ]);
  return [
    head,
    kind ? `Тип: ${KIND_NAME[kind] || kind}` : isIp ? 'Тип: по IP (в списке указан id)' : 'Тип: не найден в логе',
    rows.length ? `Последние ${rows.length} из ${total} запросов в логе (время МСК, путь, статус, длительность, размер):` : 'В логе запросов нет (лог хранит последние ~10 МБ).',
    ...(rows.length && !rows.some((e) => e.text) ? [db.logPrompts ? 'Текста запросов в этих строках нет (он пишется только с момента включения).' : 'Текст запросов сейчас не пишется: включить /prompts on'] : []),
    ...lines,
    ...(/^\d+$/.test(q) && !isIp ? ['', 'Итоги за сутки:', whoText(q).split('\n').filter((l) => /^(Сегодня|Суточный)/.test(l)).join('\n') || 'запросов к моделям сегодня не было'] : []),
  ].join('\n');
}
export function whoText(id) {
  id = String(id);
  const u = db.users[id], s = llmStats.uid[id];
  const flags = [isAdmin(id) && 'админ', db.allowed.includes(id) && 'в списке доступа', isBlocked(id) && 'ЗАБЛОКИРОВАН', db.pending[id] && 'просился'].filter(Boolean);
  return [
    userLabel(id),
    u ? `Роль: ${u.role || 'не выбрана'}, последний вход: ${u.seen ? new Date(u.seen).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—'}` : 'В базе хаба такого пользователя нет.',
    `Статус: ${flags.join(', ') || 'нет в списке'}`,
    s ? `Сегодня: ${statLine(s)}\nСуточный лимит: ${s.used || 0} из ${limitsOf(id).daily}${limitsOf(id).custom ? ' (индивидуальный)' : ''}` : 'Сегодня запросов к моделям не было.',
    `Последние запросы: /log ${id}`,
    limitsOf(id).isNew && !limitsOf(id).custom ? `Новый пользователь: ${limitsOf(id).daily} в сутки (общий для новых). Изменить: /setlimit ${id} <в сутки>` : '',
    limitsOf(id).custom ? `Индивидуальные лимиты: ${limitsOf(id).daily} в сутки, ${limitsOf(id).perMin} в минуту. Сбросить: /setlimit ${id} сброс` : limitsOf(id).isNew ? '' : `Лимиты: общие (${DAILY_LLM} в сутки, ${LLM_PER_MIN} в минуту). Изменить: /setlimit ${id} <в сутки> [в минуту]`,
  ].join('\n');
}
export function ipText(ip) {
  const s = llmStats.ip[ip], a = llmStats.anon.ip[ip];
  return [`IP ${ip}`, s ? `Залогиненные: ${statLine(s)}` : 'Залогиненные: запросов нет', a ? `Анонимные: ${statLine(a)}` : 'Анонимные: запросов нет', RESET_NOTE].join('\n');
}
export const limitsText = () => [
  'Текущие лимиты (из env):',
  `GRAPHY_LLM_PER_MIN: ${LLM_PER_MIN} запросов в минуту на пользователя`,
  `GRAPHY_LLM_IP_PER_MIN: ${LLM_IP_PER_MIN} запросов в минуту на IP`,
  `GRAPHY_DAILY_LLM_REQUESTS: ${DAILY_LLM} запросов в сутки на пользователя (старые)`,
  `GRAPHY_NEW_USER_DAILY: ${db.newUserDaily ?? NEW_USER_DAILY} запросов в сутки на новых (зарегистрированных после ${new Date(db.newUsersSince).toISOString().slice(0, 16).replace('T', ' ')} UTC). Изменить: /setlimit new <число>`,
  `GRAPHY_DAILY_LLM_TOTAL: ${LLM_DAILY_TOTAL} запросов в сутки на всех залогиненных`,
  `GRAPHY_ANON_USD_TOKEN / IP / TOTAL: ${ANON_CAP.token} / ${ANON_CAP.ip} / ${ANON_CAP.total} USD в сутки`,
  `GRAPHY_ACTIVE_ALERT_REQUESTS: алерт при ${ACTIVE_REQ} запросах за ${Math.round(ACTIVE_MS / 60_000)} мин`,
  ...(() => { const row = ([id, o]) => `${userLabel(id)}: ${o.daily ?? DAILY_LLM} в сутки, ${o.perMin ?? LLM_PER_MIN} в минуту`; const all = Object.entries(db.userLimits || {}); const ok = all.filter(([id]) => !isBlocked(id)); const bad = all.filter(([id]) => isBlocked(id)); return [...(ok.length ? ['Индивидуальные лимиты:', ...ok.map(row)] : ['Индивидуальных лимитов нет (задать: /setlimit <id> <в сутки> [в минуту])']), ...(bad.length ? ['🚫 Заблокированные:', ...bad.map(row)] : [])]; })(),
  'Админы вне лимитов и вне паузы. Алерты: не чаще раза в час на событие.',
  `Пауза LLM: ${db.llmOff ? 'включена' : 'нет'}`,
].join('\n');
/** Handles the LLM-related admin commands. Returns the reply text, or null when `cmd` is not one of them. */
export function llmAdminCommand(cmd, arg) {
  if (cmd === 'stats') return statsText();
  if (cmd === 'top') return topText();
  if (cmd === 'reports') return reportsText(arg);
  if (cmd === 'prompts') {
    const a = arg.trim().toLowerCase();
    if (a === 'on' || a === 'off') { db.logPrompts = a === 'on'; save(); }
    return `Текст запросов в логе: ${db.logPrompts ? 'ВКЛЮЧЁН (пишутся сообщения учеников и анонимных токенов, до 600 символов, ключи скрываются). Выключить: /prompts off' : 'выключен. Включить: /prompts on'}${a === 'on' ? '\nПишется с этого момента, более ранних запросов в логе без текста. Смотреть: /log <id>' : ''}`;
  }
  if (cmd === 'log') { const [q, n] = arg.split(/\s+/); return logText(q || '', Math.min(50, Math.max(1, Number(n) || 20))); }
  if (cmd === 'limits') return limitsText();
  if (cmd === 'llmoff' || cmd === 'llmon') {
    db.llmOff = cmd === 'llmoff'; save();
    return db.llmOff ? 'LLM поставлен на паузу для всех, кроме админов. Снять: /llmon' : 'Пауза LLM снята.';
  }
  if (cmd === 'who') return /^\d{1,20}$/.test(arg) ? whoText(arg) : 'Нужен числовой id, например /who 12345';
  if (cmd === 'ip') return /^[0-9a-fA-F:.]{3,45}$/.test(arg) ? ipText(arg) : 'Нужен IP-адрес, например /ip 203.0.113.5';
  if (cmd === 'setlimit') {
    const [id, a1, a2] = arg.split(/\s+/);
    const usage = 'Формат: /setlimit <id> <запросов в сутки> [в минуту], /setlimit <id> сброс или /setlimit new <число> (для новых пользователей)';
    if (id === 'new') {
      const n = Number(a1);
      if (!Number.isInteger(n) || n < 1 || n > 100000) return `Лимит для новых: целое число от 1 до 100000. ${usage}`;
      db.newUserDaily = n; save();
      return `Лимит для новых пользователей (зарегистрированных после ${new Date(db.newUsersSince).toISOString().slice(0, 16).replace('T', ' ')} UTC): ${n} запросов в сутки. Старые пользователи не затронуты.`;
    }
    if (!/^\d{1,20}$/.test(id || '')) return usage;
    db.userLimits ||= {};
    if (/^(сброс|reset|default|общий)$/i.test(a1 || '')) { delete db.userLimits[id]; save(); return `Лимит сброшен до общего (${DAILY_LLM} в сутки, ${LLM_PER_MIN} в минуту): ${userLabel(id)}`; }
    const daily = Number(a1), perMin = a2 === undefined ? undefined : Number(a2);
    if (!Number.isInteger(daily) || daily < 1 || daily > 100000) return `Лимит в сутки: целое число от 1 до 100000. ${usage}`;
    if (perMin !== undefined && (!Number.isInteger(perMin) || perMin < 1 || perMin > 1000)) return `Лимит в минуту: целое число от 1 до 1000. ${usage}`;
    db.userLimits[id] = { daily, ...(perMin !== undefined ? { perMin } : {}) }; save();
    return `Лимит для ${userLabel(id)}: ${daily} запросов в сутки, ${perMin ?? LLM_PER_MIN} в минуту (общий: ${DAILY_LLM} / ${LLM_PER_MIN}).${isAdmin(id) ? ' Он админ, поэтому лимиты на него не действуют.' : ''} Действует сразу, сброс: /setlimit ${id} сброс`;
  }
  if (cmd === 'block' || cmd === 'unblock') {
    if (!/^\d{1,20}$/.test(arg)) return `Нужен числовой id, например /${cmd} 12345`;
    if (cmd === 'block') {
      if (isAdmin(arg)) return 'Администратора заблокировать нельзя.';
      if (!isBlocked(arg)) db.blocked.push(arg);
      save();
      const a = agents.get(arg); if (a) void killAgent(arg, a); // stop his agent right away
      return `Заблокирован: ${userLabel(arg)}. Доступ и запросы к моделям закрыты (403).`;
    }
    const i = db.blocked.indexOf(arg); if (i >= 0) db.blocked.splice(i, 1); save();
    return `Разблокирован: ${userLabel(arg)}`;
  }
  return null;
}

// ---------- messages from the AI agents to the administrator (tool report_to_admin) ----------
const REPORT_CATEGORIES = { abuse_attempt: 'попытка злоупотребить сервером', jailbreak: 'попытка обойти правила', unsafe_request: 'опасный или не учебный запрос', suspicious_user: 'подозрительное поведение', suggestion: 'предложение ИИ', other: 'другое' };
const REPORT_SEVERITY = { low: ['ℹ️', 'низкая'], medium: ['⚠️', 'средняя'], high: ['🚨', 'высокая'] };
const reportTimes = new Map(); // uid -> times of accepted reports
const REPORTS_PER_HOUR = Number(env.GRAPHY_REPORTS_PER_HOUR || 6);
const clean = (t, n) => maskSecrets(String(t ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, n);
/** Validate a report from an agent, store it and tell the admins. Returns { status, body, events } (events: alerts to send). */
export function handleAgentReport(uid, input, now = Date.now()) {
  const category = Object.hasOwn(REPORT_CATEGORIES, input?.category) ? input.category : 'other';
  const severity = Object.hasOwn(REPORT_SEVERITY, input?.severity) ? input.severity : 'medium';
  const reason = clean(input?.reason, 600), quote = clean(input?.quote, 400);
  if (reason.length < 3) return { status: 400, body: { error: { message: 'reason is required' } }, events: [] };
  const recent = (reportTimes.get(uid) || []).filter((t) => now - t < 3_600_000);
  if (recent.length >= REPORTS_PER_HOUR) { reportTimes.set(uid, recent); return { status: 429, body: { error: { message: 'too many reports, the administrator already knows' } }, events: [] }; }
  recent.push(now); reportTimes.set(uid, recent);
  const auto = input?.auto === true;
  db.reports.push({ t: now, uid, category, severity, reason, quote, auto });
  if (db.reports.length > 100) db.reports.splice(0, db.reports.length - 100);
  save();
  const [icon, sevRu] = REPORT_SEVERITY[severity];
  const text = [
    `${icon} Сообщение от ИИ-агента, важность: ${sevRu}`,
    `Пользователь: ${userLabel(uid)}`,
    `Категория: ${REPORT_CATEGORIES[category]}${auto ? ' (команда заблокирована автоматически)' : ''}`,
    `Причина: ${reason}`,
    ...(quote ? [`Цитата: «${quote}»`] : []),
    '', `/log ${uid}: запросы и тексты, /reports ${uid}: все сообщения о нём, /block ${uid}: заблокировать, /setlimit ${uid} 10: урезать лимит`,
  ].join('\n');
  const events = [{ key: `report:${uid}:${category}`, text, everyMs: severity === 'high' ? 10 * 60_000 : 60 * 60_000 }];
  const highs = db.reports.filter((r) => r.uid === uid && r.severity === 'high' && now - r.t < 3_600_000).length;
  if (highs === 3) events.push({ key: `report-escalate:${uid}`, text: `🚨 ${userLabel(uid)}: уже 3 сообщения высокой важности за час. Рекомендую заблокировать: /block ${uid}`, everyMs: 3_600_000 });
  if (highs >= Number(env.GRAPHY_AUTO_BLOCK_HIGH || 0) && Number(env.GRAPHY_AUTO_BLOCK_HIGH || 0) > 0 && !isAdmin(uid) && !isBlocked(uid)) {
    db.blocked.push(String(uid)); save(); const a = agents.get(String(uid)); if (a) void killAgent(String(uid), a);
    events.push({ key: `report-autoblock:${uid}`, text: `⛔ ${userLabel(uid)} заблокирован автоматически: ${highs} сообщений высокой важности за час. Вернуть: /unblock ${uid}`, everyMs: 3_600_000 });
  }
  return { status: 200, body: { ok: true }, events };
}
const uidFromLlmToken = (given) => { const m = /^gl-(\d+)-([0-9a-f]{32})$/.exec(given || ''); return m && safeEq(hmac(SECRET, `llm:${m[1]}`, 'hex').slice(0, 32), m[2]) ? m[1] : ''; };
async function agentReport(req, res) {
  const uid = uidFromLlmToken(bearer(req));
  if (!uid) return send(res, 401, { error: { message: 'bad token' } });
  let input; try { input = await readBody(req, 16 * 1024); } catch (e) { return send(res, e.status || 400, { error: { message: e.message } }); }
  const r = handleAgentReport(uid, input);
  for (const ev of r.events) notifyAdmins(ev.key, ev.text, Date.now(), undefined, ev.everyMs);
  return send(res, r.status, r.body);
}
export function reportsText(arg = '') {
  const [a, b] = String(arg).trim().split(/\s+/);
  const uid = /^\d{1,20}$/.test(a || '') ? a : '';
  const n = Math.min(30, Math.max(1, Number(uid ? b : a) || 10));
  const rows = db.reports.filter((r) => !uid || r.uid === uid).slice(-n);
  if (!rows.length) return uid ? `Сообщений от ИИ-агента о ${userLabel(uid)} нет.` : 'Сообщений от ИИ-агента пока нет.';
  return [`Сообщения от ИИ-агента (последние ${rows.length}${uid ? `, о ${userLabel(uid)}` : ''}):`, ...rows.map((r) => `${logTime(new Date(r.t).toISOString())} ${REPORT_SEVERITY[r.severity]?.[0] || ''} ${uid ? '' : `${userLabel(r.uid).split(' http')[0]}: `}${REPORT_CATEGORIES[r.category] || r.category}${r.auto ? ' (авто)' : ''}: ${r.reason}${r.quote ? ` «${r.quote.slice(0, 120)}»` : ''}`)].join('\n');
}

// ---------- sandbox watchers: servers a user leaves running, and disk usage ----------
/** Listening TCP sockets owned by sandbox uids (>= 20000), read from /proc/net/tcp{,6} (the uid column needs no extra rights). */
export function sandboxListeners(procNet = '/proc/net') {
  const out = [];
  for (const f of ['tcp', 'tcp6']) {
    let text = ''; try { text = fs.readFileSync(path.join(procNet, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length < 8 || c[3] !== '0A') continue; // 0A = LISTEN
      const uid = Number(c[7]); if (!(uid >= 20000)) continue;
      out.push({ uid, port: parseInt(c[1].split(':')[1], 16), addr: c[1] });
    }
  }
  return out;
}
const listenerSeen = new Map(); // `${uid}:${port}` -> first seen
const LISTENER_GRACE_MS = Number(env.GRAPHY_SANDBOX_LISTENER_GRACE_MS || 45_000);
/** One scan: a user process that keeps a server socket open longer than the grace period is killed (with everything else of that user
 *  except his agent) and the admins are told. The agent's own API port is not a violation. */
export function scanSandboxListeners({ now = Date.now(), procNet = '/proc/net', procDir = '/proc', kill, agentPorts = new Set(), agentPids = new Set(), osuidToUser = () => '' } = {}) {
  const acted = []; const present = new Set();
  for (const l of sandboxListeners(procNet)) {
    if (agentPorts.has(l.port)) continue;
    const key = `${l.uid}:${l.port}`; present.add(key);
    if (!listenerSeen.has(key)) { listenerSeen.set(key, now); continue; }
    if (now - listenerSeen.get(key) < LISTENER_GRACE_MS) continue;
    const killed = killUserProcesses(l.uid, procDir, kill, agentPids);
    acted.push({ uid: l.uid, osuid: l.uid, port: l.port, killed, user: osuidToUser(l.uid) });
    listenerSeen.delete(key);
  }
  for (const k of [...listenerSeen.keys()]) if (!present.has(k)) listenerSeen.delete(k);
  return acted;
}
/** Established TCP connections of sandbox uids to addresses outside the machine and the private ranges, read from /proc/net/tcp{,6}.
 *  An outbound-only reverse tunnel or proxy client opens no listening port, so the listener watcher cannot see it. */
export function sandboxOutbound(procNet = '/proc/net') {
  const out = [];
  const v4 = (hex) => [3, 2, 1, 0].map((i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)); // /proc prints an IPv4 address as little-endian hex
  const isPublic = ([a, b]) => !(a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127));
  for (const f of ['tcp', 'tcp6']) {
    let text = ''; try { text = fs.readFileSync(path.join(procNet, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length < 8 || c[3] !== '01') continue; // 01 = ESTABLISHED
      const uid = Number(c[7]); if (!(uid >= 20000)) continue;
      const [ra, rp] = c[2].split(':'); let ip;
      if (ra.length === 8) ip = v4(ra);
      else if (/^0{16}FFFF0000/i.test(ra)) ip = v4(ra.slice(24)); // IPv4-mapped IPv6
      else if (/^0{24}01000000$/i.test(ra) || /^0+$/.test(ra)) continue; // ::1, ::
      else ip = null; // real IPv6: counts as public
      if (ip && !isPublic(ip)) continue;
      out.push({ uid, remote: `${ip ? ip.join('.') : ra}:${parseInt(rp, 16)}`, local: c[1] });
    }
  }
  return out;
}
const outboundSeen = new Map(); // `${uid}|${local}|${remote}` -> first seen
const OUTBOUND_GRACE_MS = Number(env.GRAPHY_SANDBOX_OUTBOUND_GRACE_MS || 300_000);
/** One scan: a user process that keeps the same connection to the Internet open longer than the grace period (a tunnel, a proxy client,
 *  a reverse shell; ordinary downloads, pip and web requests finish sooner) is killed with everything else of that user except his agent. */
export function scanSandboxOutbound({ now = Date.now(), procNet = '/proc/net', procDir = '/proc', kill, agentPids = new Set(), osuidToUser = () => '' } = {}) {
  const acted = []; const present = new Set();
  for (const o of sandboxOutbound(procNet)) {
    const key = `${o.uid}|${o.local}|${o.remote}`; present.add(key);
    if (!outboundSeen.has(key)) { outboundSeen.set(key, now); continue; }
    if (now - outboundSeen.get(key) < OUTBOUND_GRACE_MS) continue;
    const killed = killUserProcesses(o.uid, procDir, kill, agentPids);
    acted.push({ osuid: o.uid, remote: o.remote, killed, user: osuidToUser(o.uid) });
    outboundSeen.delete(key);
  }
  for (const k of [...outboundSeen.keys()]) if (!present.has(k)) outboundSeen.delete(k);
  return acted;
}
function startSandboxWatchers() {
  if (!AS_USER) return;
  setInterval(() => {
    const acted = scanSandboxOutbound({ agentPids: new Set([...agents.values()].map((a) => a.proc.pid)), osuidToUser: (osuid) => Object.values(db.users).find((u) => u.osuid === osuid)?.id || '' });
    for (const x of acted) {
      console.log(`[hub] sandbox long outbound connection to ${x.remote} (uid ${x.osuid}): killed ${x.killed} process(es)`);
      const who = x.user ? userLabel(x.user) : `uid ${x.osuid}`;
      notifyAdmins(`outbound:${x.osuid}`, `🚨 Песочница: процесс пользователя ${who} держал соединение с ${x.remote} дольше ${Math.round(OUTBOUND_GRACE_MS / 60000)} мин (туннель, прокси или обратная оболочка). Все его фоновые процессы остановлены.\n/log ${x.user || ''}  /reports ${x.user || ''}  /block ${x.user || ''}`);
    }
  }, 30_000).unref();
  setInterval(() => {
    const osToUser = (osuid) => Object.values(db.users).find((u) => u.osuid === osuid)?.id || '';
    const acted = scanSandboxListeners({ agentPorts: new Set([...agents.values()].map((a) => a.port)), agentPids: new Set([...agents.values()].map((a) => a.proc.pid)), osuidToUser: osToUser });
    for (const x of acted) {
      console.log(`[hub] sandbox listener on port ${x.port} (uid ${x.osuid}): killed ${x.killed} process(es)`);
      const who = x.user ? userLabel(x.user) : `uid ${x.osuid}`;
      notifyAdmins(`listener:${x.osuid}`, `🚨 Песочница: процесс пользователя ${who} держал открытый порт ${x.port} дольше ${Math.round(LISTENER_GRACE_MS / 1000)} с (сервер, прокси или туннель). Все его фоновые процессы остановлены.\n/log ${x.user || ''}  /reports ${x.user || ''}  /block ${x.user || ''}`);
    }
  }, 20_000).unref();
  // disk: a user cannot fill the VPS unnoticed
  const DISK_MB = Number(env.GRAPHY_USER_DISK_MB || 1000);
  setInterval(() => {
    for (const u of Object.values(db.users)) {
      if (!u.id) continue;
      execFile('du', ['-sk', path.join(WORK_DIR, u.id), path.join(USERS_DIR, u.id)], { timeout: 60_000 }, (err, out) => {
        if (err && !out) return;
        const mb = Math.round(String(out).split('\n').reduce((a, l) => a + (parseInt(l, 10) || 0), 0) / 1024);
        if (mb > DISK_MB) notifyAdmins(`disk:${u.id}`, `💾 ${userLabel(u.id)} занимает ${mb} МБ на диске сервера (порог ${DISK_MB} МБ). Проверьте: /log ${u.id}`, Date.now(), undefined, 24 * 3_600_000);
      });
    }
  }, 10 * 60_000).unref();
  // /data and /workspace are volume roots: nobody but root may create files there
  for (const d of [path.dirname(USERS_DIR), path.dirname(WORK_DIR)]) { try { if (fs.statSync(d).mode & 0o002) fs.chmodSync(d, 0o755); } catch { /* not ours */ } }
}

// ---------- LLM proxy (key stays here) ----------
function llmProxy(req, res, incoming) {
  const given = bearer(req);
  const t0 = Date.now(), ip = clientIp(req);
  let kind = 'user', id = '-', uid = '';
  if (/^anon-[0-9a-f]{32}$/.test(given)) { kind = 'anon'; id = given.slice(5, 13); } // only a short prefix is ever logged
  else if (/^sk-or-[\w-]{10,}$/.test(given)) { kind = 'own'; id = 'own:' + crypto.createHash('sha256').update(given).digest('hex').slice(0, 8); }
  else {
    const m = /^gl-(\d+)-([0-9a-f]{32})$/.exec(given);
    if (m && safeEq(hmac(SECRET, `llm:${m[1]}`, 'hex').slice(0, 32), m[2])) { uid = m[1]; id = uid; }
  }
  const bytes = Number(req.headers['content-length'] || 0);
  let recorded = false;
  res.on('close', () => { // one log line and one stats entry per request, whatever the outcome
    if (recorded) return; recorded = true;
    const status = res.writableFinished || res.headersSent ? res.statusCode : 499;
    const cap = promptOf.get(res);
    llmRecord({ kind, id, ip, path: incoming.pathname, status, ms: Date.now() - t0, bytes, text: cap?.text, model: cap?.model });
  });
  if (kind === 'user' && !uid) {
    const ev = reportAuthFail(ip, 'неверный токен в запросе к моделям'); if (ev) notifyAdmins(ev.key, ev.text);
    return send(res, 401, { error: { message: 'bad token' } });
  }
  const gate = llmAdmit({ kind, uid, id, ip });
  for (const ev of gate.events) notifyAdmins(ev.key, ev.text);
  if (!gate.ok) return send(res, gate.status, { error: { message: gate.message } });
  if (kind === 'anon') return anonProxy(req, res, incoming, given);
  const ownKey = kind === 'own' ? given : '';
  if (Number(req.headers['content-length'] || 0) > 16 * 1024 * 1024) return send(res, 413, { error: { message: 'too large' } });
  if (!ownKey && !LLM_KEY) return send(res, 503, { error: { message: 'Модель не настроена на сервере' } });
  const target = new URL(LLM_UPSTREAM + incoming.pathname.replace(/^\/llm/, '') + incoming.search);
  const headers = { ...req.headers, host: target.host, authorization: `Bearer ${ownKey || LLM_KEY}` };
  delete headers.origin; delete headers.cookie; delete headers['accept-encoding'];
  const up = https.request(target, { method: req.method, headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  up.setTimeout(300_000, () => up.destroy());
  res.on('close', () => up.destroy());
  if (kind === 'user' && db.logPrompts) { // read the body first so the learner's text can go into the log, then forward it unchanged
    const chunks = []; let size = 0, dead = false;
    req.on('data', (c) => { size += c.length; if (size > 16 * 1024 * 1024) { dead = true; if (!res.headersSent) send(res, 413, { error: { message: 'too large' } }); req.destroy(); up.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (dead) return;
      const buf = Buffer.concat(chunks);
      try { const b = JSON.parse(buf.toString('utf8')); promptOf.set(res, { text: lastUserText(b), model: String(b?.model || '') }); } catch { /* not JSON: nothing to log */ }
      up.end(buf);
    });
    return;
  }
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
const HELP = 'Команды администратора:\n/users: список\n/pending: кто просился\n/adduser <id>\n/rmuser <id>\n/addadmin <id>\n/rmadmin <id>\n/open и /close: доступ для всех или только по списку\n/myid: ваш id\n\nМодели и нагрузка:\n/stats: сводка за сутки\n/top: топ пользователей и IP\n/log <id|токен|IP> [N]: последние запросы пользователя, токена или IP (с текстом, если включён)\n/prompts on|off: писать ли текст запросов в лог\n/reports [id]: сообщения ИИ-агента о подозрительных пользователях\n/who <id>: профиль и расход\n/ip <адрес>: расход IP\n/block <id> и /unblock <id>\n/limits: текущие лимиты\n/setlimit <id> <в сутки> [в минуту] или /setlimit <id> сброс: лимит пользователя\n/llmoff и /llmon: пауза моделей для всех, кроме админов';
const blockedMark = (id) => isBlocked(id) ? ' [заблокирован]' : '';
const nameOf = (id) => { const u = db.users[id]; const base = u ? `${[u.first_name, u.last_name].filter(Boolean).join(' ') || 'Без имени'} (${u.username ? `@${u.username}, ` : ''}${id})` : id; return base + blockedMark(id); };
/** Returns true when the message was a command handled here. */
async function adminCommand(user, uid, cmd, arg) {
  const reply = (t) => sendTo(user.user_id, t);
  if (cmd === 'myid') { await reply(`Ваш MAX id: ${uid}`); return true; }
  if (cmd === 'claim') {
    if (CLAIM && safeEq(arg, CLAIM)) { addTo(db.admins, uid); await reply('Вы администратор Graphy. /help: список команд.'); } else {
      await reply('Неверный код.');
      const who = `${[user.first_name, user.last_name].filter(Boolean).join(' ') || 'Пользователь'} (${user.username ? `@${user.username}, ` : ''}id ${uid})`;
      const ev = reportClaimFail(who, uid); if (ev) notifyAdmins(ev.key, ev.text);
    }
    return true;
  }
  if (!['help', 'users', 'pending', 'adduser', 'rmuser', 'addadmin', 'rmadmin', 'open', 'close', 'stats', 'top', 'who', 'ip', 'block', 'unblock', 'limits', 'llmoff', 'llmon', 'setlimit', 'log', 'prompts', 'reports'].includes(cmd)) return false;
  if (!isAdmin(uid)) return false;
  const llmReply = llmAdminCommand(cmd, arg);
  if (llmReply !== null) { for (const part of chunkText(llmReply)) await reply(part); return true; }
  const id = /^\d{1,20}$/.test(arg) ? arg : '';
  if (cmd === 'help') await reply(HELP);
  else if (cmd === 'users') await reply(`Доступ: ${db.open ? 'открыт всем' : 'по списку'}\nАдмины: ${db.admins.map(nameOf).join(', ') || '—'}\nПользователи: ${db.allowed.filter((id) => !isBlocked(id)).map(nameOf).join(', ') || '—'}\n🚫 Заблокированы: ${(db.blocked || []).map(nameOf).join(', ') || '—'}`);
  else if (cmd === 'pending') { const rows = Object.entries(db.pending).map(([k, v]) => [k, `${k} ${v.name}${v.username ? ` @${v.username}` : ''}`]); const ok = rows.filter(([k]) => !isBlocked(k)).map((r) => r[1]); const bad = rows.filter(([k]) => isBlocked(k)).map((r) => r[1]); await reply([...(ok.length ? ok : ['Никто не просился.']), ...(bad.length ? ['', '🚫 Заблокированные:', ...bad] : [])].join('\n')); }
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
    if (isBlocked(uid) && !isAdmin(uid)) { await sendTo(user.user_id, blockedMessage(uid)); return; }
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
      if (tu && isBlocked(tu.id) && !isAdmin(tu.id)) throw fail(403, blockedMessage(tu.id), 'blocked');
      if (!tu || !hasAccess(tu.id)) throw fail(401, 'Ссылка недействительна. Напишите боту /start, чтобы получить новую.', 'bad_ticket');
      return send(res, 200, { token: sessionFor(tu.id), user: publicUser(tu), start: tk.start, bot: botName });
    }
    const v = validateInitData(b.initData);
    if (!v?.user?.id) throw fail(401, 'Не удалось подтвердить вход через MAX. Откройте приложение из MAX.', 'bad_init_data');
    if (isBlocked(v.user.id) && !isAdmin(v.user.id)) throw fail(403, blockedMessage(v.user.id), 'blocked'); // blocked people do not go to the "waiting" list
    if (!hasAccess(v.user.id)) {
      db.pending[String(v.user.id)] = { name: [v.user.first_name, v.user.last_name].filter(Boolean).join(' '), username: v.user.username || '', at: Date.now() };
      save();
      throw fail(403, `Доступ к Graphy пока закрыт. Ваш MAX id: ${v.user.id}. Сообщите его администратору.`, 'not_allowed');
    }
    const u = upsertUser(v.user);
    return send(res, 200, { token: sessionFor(u.id), user: publicUser(u), start: v.start || b.start || '', bot: botName, invite_base: botName ? `https://max.ru/${botName}?startapp=` : '' });
  }
  const me = userFromSession(bearer(req));
  if (!me) { if (sessionBlocked(bearer(req))) throw fail(403, blockedMessage(userFromSessionId(bearer(req))), 'blocked'); throw fail(401, 'Требуется вход через MAX', 'unauthorized'); }
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
    if (p === '/hub/agent-report' && req.method === 'POST') { await agentReport(req, res); return true; }
    if (p === '/graphy-config.json') { send(res, 200, { url: '', token: '', hub: true, bot: botName }); return true; }
    if (p.startsWith('/hub/')) { await route(req, res, incoming); return true; }
    if (p.startsWith('/api/')) {
      const u = userFromSession(bearer(req) || incoming.searchParams.get('token'));
      if (!u) {
        const tk = bearer(req) || incoming.searchParams.get('token');
        if (sessionBlocked(tk)) send(res, 403, { error: { code: 'blocked', message: blockedMessage(userFromSessionId(tk)) } });
        else send(res, 401, { error: { code: 'unauthorized', message: 'Требуется вход через MAX' } });
        return true;
      }
      const a = await agentFor(u);
      proxyToAgent(req, res, a, incoming, u);
      return true;
    }
  } catch (e) {
    if (e.code === 'bad_ticket' || e.code === 'bad_init_data') { const ev = reportAuthFail(clientIp(req), e.code === 'bad_ticket' ? 'ссылка входа' : 'данные входа MAX'); if (ev) notifyAdmins(ev.key, ev.text); }
    if (!res.headersSent) send(res, e.status || 500, { error: { code: e.code || 'hub_error', message: e.status ? e.message : 'Ошибка сервера' } });
    if (!e.status) console.error('hub', p, e);
    return true;
  }
  return false;
}

export function startHub() {
  if (!hubEnabled()) return;
  if (!PUBLIC_URL) console.warn('GRAPHY_PUBLIC_URL is not set');
  if (AS_USER) {
    try { if (missingKillCap(fs.readFileSync('/proc/self/status', 'utf8'))) console.error('[hub] WARNING: CAP_KILL is missing. The hub cannot stop per-user agents, so stopped agents keep their ports and sign-in hangs ("Address already in use"). Start the container with --cap-add KILL.'); } catch { /* no /proc */ }
  }
  startSandboxWatchers();
  void pollBot();
  for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => { try { fs.writeFileSync(dbFile + '.tmp', JSON.stringify(db), { mode: 0o600 }); fs.renameSync(dbFile + '.tmp', dbFile); } catch { /* best effort */ } school.flush(); flushLlmStats(); for (const a of agents.values()) a.proc.kill('SIGTERM'); });
}
