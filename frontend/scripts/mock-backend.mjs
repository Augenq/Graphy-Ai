import { createSkillsMock } from './skills-mock.mjs';
import { createStudyMock } from './study-mock.mjs';
import { createMemoryMock } from './memory-mock.mjs';
// Wire-format fixtures enter through fetch/EventSource, never through the UI store.
const widgetCode = '<svg width="100%" viewBox="0 0 680 180" role="img"><title>Умножение</title>' +
  '<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5"/></marker></defs>' +
  '<g class="c-blue node" onclick="sendPrompt(\'Объясни шаг со строкой A\')"><rect x="40" y="40" width="160" height="60" rx="4"/><text class="th" x="120" y="62" text-anchor="middle">Строка A</text><text class="ts" x="120" y="82" text-anchor="middle">1 2</text></g>' +
  '<g class="c-teal"><rect x="260" y="40" width="160" height="60" rx="4"/><text class="th" x="340" y="62" text-anchor="middle">Столбец B</text><text class="ts" x="340" y="82" text-anchor="middle">3 4</text></g>' +
  '<g class="c-amber"><rect x="480" y="40" width="160" height="60" rx="4"/><text class="th" x="560" y="62" text-anchor="middle">Элемент C</text><text class="ts" x="560" y="82" text-anchor="middle">11</text></g>' +
  '<path class="arr" d="M200 70 L258 70" marker-end="url(#arrow)"/><path class="arr" d="M420 70 L478 70" marker-end="url(#arrow)"/>' +
  '<text class="ts" x="340" y="150" text-anchor="middle">1·3 + 2·4 = 11</text></svg>' +
  '<label style="display:block;margin-top:12px">Параметр <input type="range" min="0" max="10" value="3" oninput="document.getElementById(\'v\').textContent=this.value"> <span id="v">3</span></label>';

export function installMockBackend() {
  const origin = 'http://graphy-regression.invalid';
  const requests = [];
  const unexpected = [];
  const streams = new Set();
  const settings = {
    anti_slop_enabled: true, explanation_depth: 'adaptive', explanation_presentation: 'adaptive', skills_enabled: true, auto_compact: true, block_images: false, sandbox: true,
    default_model: 'fixture/model', default_thinking: 'off', default_style: 'structured_reference', web_provider: 'searxng', web_key_set: false,
    tools: ['read', 'bash', 'web_search', 'web_read'], available_tools: ['read', 'bash', 'web_search', 'web_read'],
  };
  const models = [{ id: 'fixture/model', provider: 'fixture', name: 'Fixture model', context: 128000, vision: false,
    tools: true, reasoning: true, thinking_levels: ['off', 'low', 'high'], metadata_estimated: false }];
  const providers = [{ name: 'fixture', kind: 'custom', api: 'chat', base_url: origin, key_env: '',
    configured: true, key_source: 'stored', models: 1 }];
  const assistant = (id, content, calls = []) => ({ id, role: 'assistant', content, thinking: '', calls, stop: 'stop' });
  const question = {
    batch_id: 'fixture-quiz', title: 'Проверка определителя', step: 0, answers: [],
    questions: Array.from({ length: 5 }, (_, i) => ({ id: `q${i + 1}`, type: i === 1 ? 'free_text' : 'single_choice',
      prompt: `Вопрос ${i + 1}: чему равен определитель единичной матрицы?`,
      ...(i === 1 ? {} : { options: [{ id: 'one', label: '1' }, { id: 'zero', label: '0' }] }) })),
  };
  const snapshot = (id, name, quiz = null) => ({
    id, name, created: 1793358000, modified: 1793358000, said: 1,
    model: 'fixture/model', thinking: 'off', explanation_style: 'structured_reference', mode: 'explain', quiz_kind: 'check', deadline: null, busy: false, seq: 0, queued: 0, warning: '', needs_continuation: false,
    learning: { goal: 'Разобраться с матрицами', phase: 'teaching', steps: [{ id: 's1', title: 'Матрицы' }, { id: 's2', title: 'Определитель' }],
      current_index: 1, finished: false, summary: '', next_step: '' },
    context: { used: 1200, limit: 128000, percent: 1 }, usage: { input: 4200, output: 1800, cache_read: 38000, cache_write: 2100, cost: 0.0421, unknown_cost: false }, question: quiz, resolved_questions: {},
    messages: [
      { id: `${id}-user`, role: 'user', content: 'Объясни матрицы' },
      assistant(`${id}-answer`, 'Единичная матрица имеет определитель 1.\n\n```python\nimport numpy as np\nprint(np.eye(2))\n```\n\n' +
        Array.from({ length: 18 }, (_, i) => `Шаг ${i + 1}. Умножение матриц складывает произведения элементов строки и столбца.`).join('\n\n'),
        quiz ? [{ id: quiz.batch_id, name: 'ask_questions', arguments: quiz }] : []),
    ],
  });
  const sessions = {
    'fixture-matrix': snapshot('fixture-matrix', 'Матрицы'),
    'fixture-det': snapshot('fixture-det', 'Определитель', question),
  };
  // Files the agent presented (present_file): id -> { name, mime, bytes }
  const presented = new Map();
  const summary = s => Object.fromEntries(['id', 'name', 'created', 'modified', 'said', 'model', 'thinking', 'explanation_style', 'mode', 'quiz_kind', 'deadline', 'busy'].map(k => [k, s[k]]));
  const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  const emit = (id, event) => {
    const s = sessions[id];
    const payload = { ...event, session_id: id, seq: ++s.seq };
    for (const stream of streams) stream.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) }));
  };
  // GET /usage fixture: deterministic days counted back from today, so the charts always have a "now"
  const usageOverview = (range) => {
    const keep = { '7d': 7, '30d': 30, all: 70 }[range] ?? 30;
    const pad = n => String(n).padStart(2, '0');
    const key = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const row = (i, n, scale) => {
      const input = Math.round(scale * (4000 + 900 * ((i * 7) % 5))), output = Math.round(scale * (1200 + 400 * ((i * 3) % 4)));
      const cache_read = Math.round(scale * 18000 * (1 + (i % 3))), cache_write = Math.round(scale * 900);
      const unknown = i % 9 === 4;
      return { input, output, cache_read, cache_write, tokens: input + output + cache_read + cache_write,
        cost: unknown ? 0 : +(0.004 * scale * (1 + (i % 4))).toFixed(4), known_cost: !unknown, unknown_cost: unknown, calls: n };
    };
    const days = [];
    for (let i = 69; i >= 0; i--) {
      if (i % 7 === 3 || i % 11 === 5) continue; // rest days
      const d = new Date(today); d.setDate(d.getDate() - i);
      days.push({ day: key(d), lessons: 1 + (i % 3), ...row(i, 2 + (i % 4), 1 + (i % 5) / 4) });
    }
    const inRange = days.filter(d => d.day >= key(new Date(today.getFullYear(), today.getMonth(), today.getDate() - keep + 1)));
    const sum = (rows) => rows.reduce((a, r) => ({ input: a.input + r.input, output: a.output + r.output, cache_read: a.cache_read + r.cache_read, cache_write: a.cache_write + r.cache_write,
      tokens: a.tokens + r.tokens, cost: +(a.cost + r.cost).toFixed(4), known_cost: a.known_cost || r.known_cost, unknown_cost: a.unknown_cost || r.unknown_cost, calls: a.calls + r.calls }),
      { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0, known_cost: false, unknown_cost: false, calls: 0 });
    const t = sum(inRange);
    const part = (share, extra) => { const r = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * share * 1e4) / 1e4 : v])); return { ...r, ...extra }; };
    const from = range === 'all' ? inRange[0]?.day ?? key(today) : key(new Date(today.getFullYear(), today.getMonth(), today.getDate() - keep + 1));
    return { range, today: key(today), from, days: inRange, heatmap: days,
      totals: { ...t, lessons: inRange.length ? Math.ceil(inRange.length / 2) : 0, cache_hit: t.tokens ? t.cache_read / (t.input + t.cache_read + t.cache_write) : null },
      models: inRange.length ? [part(0.6, { model: 'fixture/model' }), part(0.28, { model: 'openrouter/anthropic/claude-sonnet' }), part(0.12, { model: '?', known_cost: false, unknown_cost: true, cost: 0 })] : [],
      sessions: inRange.length ? [part(0.2, { id: 's1', name: 'Определитель и обратная матрица' }), part(0.1, { id: 's2', name: 'Present perfect' })] : [] };
  };
  const skillsApi = createSkillsMock();
  const studyApi = createStudyMock();
  const memoryApi = createMemoryMock();
  let teacherRole = false;
  const teachingApi = (method, path, body) => path === '/teaching/role' ? { status: 200, body: method === 'PUT' ? { teacher: (teacherRole = !!body?.teacher) } : { teacher: teacherRole } } : null;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    if (String(input) === "/graphy-config.json") return json({ url: origin, token: "regression-only" });
    if (String(input).startsWith(origin + "/api/v1/attachments?")) {
      window.__uploadedBytes = init.body.size;
      return json({ path: "/fixture/uploads/sketch.png" });
    }
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    if (url.origin !== origin) {
      if (url.origin === location.origin && !url.pathname.startsWith('/api/')) return nativeFetch(input, init);
      unexpected.push(url.href);
      throw Error(`Unexpected network request: ${url.href}`);
    }
    const method = init.method ?? 'GET';
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method, path, search: url.search, query: url.search, body });
    const skillsReply = skillsApi(method, path, body) ?? studyApi(method, path + url.search, body) ?? memoryApi(method, path, body) ?? teachingApi(method, path, body);
    if (skillsReply) return new Response(JSON.stringify(skillsReply.body), { status: skillsReply.status, headers: { 'Content-Type': 'application/json' } });
    if (method === 'GET' && path === '/bootstrap') return json({ version: 'fixture', cwd: '/fixture/workspace', root: '/fixture/state',
      models, providers, settings, ready: true });
    if (method === 'GET' && path === '/sessions') return json({ sessions: Object.values(sessions).map(summary) });
    if (method === 'GET' && path.startsWith('/usage')) {
      const range = url.searchParams.get('range') ?? '30d';
      if (window.__mockBackend.usageFail) return new Response(JSON.stringify({ error: { code: 'invalid', message: 'fixture failure' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      return json(window.__mockBackend.usageEmpty ? { ...usageOverview(range), days: [], heatmap: [], totals: { ...usageOverview(range).totals, tokens: 0 } } : usageOverview(range));
    }
    if (method === 'GET' && path === '/models') return json({ models });
    if (method === 'POST' && path === '/models/refresh') return json({ models });
    if (method === 'GET' && path === '/providers') return json({ providers });
    if (method === 'GET' && path === '/settings') return json(settings);
    if (method === 'PATCH' && path === '/settings') return json(Object.assign(settings, body));
    if (method === 'POST' && path === '/sessions') {
      // a new chat already has one exchange so that it is listed
      const id = 'fixture-quick-' + (Object.keys(sessions).length + 1);
      sessions[id] = { ...snapshot(id, 'Быстрый вопрос про дроби'), learning: null, question: null,
        messages: [{ id: id + '-u', role: 'user', content: 'Как сложить дроби?' }, assistant(id + '-a', 'Приведите к общему знаменателю.')] };
      return new Response(JSON.stringify(sessions[id]), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    const file = path.match(/^\/presented\/([0-9a-f]{32})$/);
    if (method === 'GET' && file) {
      const f = presented.get(file[1]);
      if (!f) return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      return new Response(f.bytes, { headers: { 'Content-Type': f.mime } });
    }
    const match = path.match(/^\/sessions\/([^/]+)(.*)$/);
    const s = match && sessions[match[1]];
    const tail = match?.[2];
    if (s && method === 'GET' && !tail) return json(s);
    if (s && method === 'PATCH' && !tail) {
      s.name = body.name;
      emit(s.id, { type: 'session_updated', session: summary(s) });
      return json(summary(s));
    }
    if (s && method === 'PUT' && tail === '/mode') {
      Object.assign(s, { mode: body.mode, quiz_kind: body.quiz_kind ?? 'check', deadline: body.deadline ?? null });
      emit(s.id, { type: 'session_updated', session: summary(s) });
      return json(summary(s));
    }
    if (s && method === 'PUT' && tail === '/style') {
      if ('explanation_style' in body) s.explanation_style = body.explanation_style;
      emit(s.id, { type: 'session_updated', session: summary(s) });
      return json(summary(s));
    }
    if (s && method === 'PUT' && tail === '/questions/fixture-quiz/draft') {
      Object.assign(s.question, body);
      return json({ ok: true });
    }
    if (s && method === 'POST' && ['/questions/fixture-quiz/submit', '/questions/fixture-quiz/cancel'].includes(tail)) {
      const status = tail.endsWith('cancel') ? 'cancelled' : 'submitted';
      s.resolved_questions[question.batch_id] = { block: structuredClone(s.question), status, answers: body.answers ?? [] };
      s.question = null;
      emit(s.id, { type: 'question_resolved', batch_id: question.batch_id, status });
      emit(s.id, { type: 'busy', busy: false, needs_continuation: false });
      return json({ ok: true });
    }
    if (s && method === 'POST' && tail === '/messages') return new Response(JSON.stringify({ started: true, queued: false }), { status: 202, headers: { 'Content-Type': 'application/json' } });
    if (s && method === 'POST' && tail === '/abort') return json({ aborted: true });
    if (s && method === 'POST' && tail === '/stall/wait') return json({ waiting: true });
    if (s && method === 'POST' && tail === '/queue/edit') {
      if (window.__mockBackend.queueGone) return new Response(JSON.stringify({ error: { code: 'queue_item_gone', message: 'Это сообщение уже отправлено агенту или возвращено в поле ввода.' } }), { status: 409, headers: { 'Content-Type': 'application/json' } });
      return json({ changed: true });
    }
    unexpected.push(`${method} ${path}`);
    throw Error(`Unhandled fixture request: ${method} ${path}`);
  };
  window.EventSource = class {
    constructor(url) {
      if (new URL(url).origin !== origin) throw Error('Refusing a real event stream');
      streams.add(this);
      queueMicrotask(() => { if (streams.has(this)) this.onopen?.(new Event('open')); });
    }
    close() { streams.delete(this); }
  };
  window.__mockBackend = {
    requests, unexpected,
    usageFail: false, usageEmpty: false,
    emitEvent(id, event) { emit(id, event); },
    emitUsage(id, usage) { emit(id, { type: 'usage', usage }); },
    emitAnswer(id, usage) { emit(id, { type: 'message_end', message: { ...assistant(`${id}-live`, 'Ещё один ответ'), usage } }); },
    /** The agent presents a file: the bytes become fetchable by id and the tool call arrives like the backend's. */
    emitPresented(id, { name, mime, bytes, title }) {
      const fileId = Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
      const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
      presented.set(fileId, { name, mime, bytes: data });
      const call = { id: 'present-' + fileId.slice(0, 6), name: 'present_file', arguments: { path: name, ...(title ? { title } : {}) } };
      const file = { id: fileId, name, title: title ?? null, mime, size: data.length };
      emit(id, { type: 'tool_start', call });
      emit(id, { type: 'tool_end', call, result: { content: JSON.stringify({ ok: true, file }) } });
      return { fileId, call };
    },
    presented,
    sessionRef: id => sessions[id],
    snapshotMessages: id => structuredClone(sessions[id].messages),
    emitWidget() {
      const s = sessions['fixture-matrix'];
      const read = { id: 'fixture-read-me', name: 'visualize_read_me', arguments: { modules: ['diagram'] } };
      const call = { id: 'fixture-widget', name: 'show_widget', arguments: { title: 'matrix_multiply_steps', widget_code: widgetCode } };
      const broken = { id: 'fixture-widget-broken', name: 'show_widget', arguments: { title: 'broken', widget_code: '<p>broken</p>' } };
      const results = [
        { id: 'fixture-read-me-result', role: 'tool', call_id: read.id, name: read.name, content: 'guidelines' },
        { id: 'fixture-widget-result', role: 'tool', call_id: call.id, name: call.name, content: 'shown' },
        { id: 'fixture-widget-broken-result', role: 'tool', call_id: broken.id, name: broken.name, content: 'Call visualize_read_me first', error: true },
      ];
      s.messages.push(assistant('fixture-widgets', '', [read, call, broken]), ...results);
      for (const [i, c] of [read, call, broken].entries()) {
        emit(s.id, { type: 'tool_start', call: c });
        emit(s.id, { type: 'tool_end', call: c, result: results[i] });
      }
    },
    emitTools() {
      const calls = ['read', 'bash', 'web_search', 'web_read'].map((name, i) => ({ id: `fixture-tool-${i}`, name, arguments: { path: 'notes.md', command: 'pwd', query: 'матрицы', url: 'https://example.com' } }));
      const s = sessions['fixture-matrix'];
      const results = calls.map(call => ({ id: `${call.id}-result`, role: 'tool', call_id: call.id, name: call.name, content: 'Готово', ms: 500 }));
      s.messages.push(assistant('fixture-tools', '', calls), ...results);
      for (const [i, call] of calls.entries()) {
        emit(s.id, { type: 'tool_start', call });
        emit(s.id, { type: 'tool_end', call, result: results[i] });
      }
    },
  };
}
