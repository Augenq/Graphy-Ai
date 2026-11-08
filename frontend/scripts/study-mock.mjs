// In-memory fixture of the study API (backend/docs/protocol.md, «Учёба»): a few answered tasks, due reviews, events.
export function createStudyMock() {
  const DAY = 86400;
  const now = () => Date.now() / 1000;
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const inDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
  const item = (id, question, outcome, topic, due, extra = {}) => ({ id, course_id: 'fixture-algebra', course: 'Линейная алгебра', topic, session_id: 's1', question,
    answer: 'Ответ ученика', feedback: 'Разбор: ход верный.', outcome, used_hints: outcome === 'with_hints', error_type: '', time: now() - 2 * DAY, attempts: 2,
    history: [], due_at: due, stage: 1, interval_days: 3, tags: [], note: '', suspended: false, ...extra });
  const items = [
    item('T1', 'Найдите определитель матрицы [[2, 1], [5, 3]]', 'gap', 'Определитель', now() - 3600, { error_type: 'знак' }),
    item('T2', 'Найдите обратную матрицу для [[1, 2], [3, 4]]', 'with_hints', 'Обратная матрица', now() - 60),
    item('T3', 'Решите систему методом Гаусса', 'independent', 'Системы уравнений', now() + 2 * DAY, { interval_days: 7 }),
    item('T4', 'Вычислите ранг матрицы 3x3', 'independent', 'Ранг', now() + 9 * DAY, { interval_days: 16 }),
  ];
  const events = [{ id: 'E1', kind: 'exam', date: ymd(inDays(12)), title: 'Экзамен по линейной алгебре', course_id: 'fixture-algebra' }];
  const state = { events, items };
  const dayOf = t => ymd(new Date(t * 1000));
  const calendar = (from, to) => {
    const today = ymd(new Date());
    const map = new Map();
    for (const i of items.filter(x => !x.suspended)) {
      const d = i.due_at <= now() ? today : dayOf(i.due_at);
      if (d < from || d > to) continue;
      const row = map.get(d) ?? { date: d, reviews: { count: 0, topics: [] }, events: [] };
      row.reviews.count++;
      const t = row.reviews.topics.find(x => x.topic === i.topic);
      t ? t.count++ : row.reviews.topics.push({ course_id: i.course_id, topic: i.topic, count: 1 });
      map.set(d, row);
    }
    for (const e of events) {
      if (e.date < from || e.date > to) continue;
      const row = map.get(e.date) ?? { date: e.date, reviews: { count: 0, topics: [] }, events: [] };
      row.events.push(e);
      map.set(e.date, row);
    }
    const exam_countdown = events.filter(e => e.kind === 'exam' && e.date >= today).map(e => ({ id: e.id, title: e.title, date: e.date, course_id: e.course_id,
      days_left: Math.round((new Date(e.date) - new Date(today)) / (DAY * 1000)), reviews_before: items.filter(i => i.due_at <= new Date(e.date).getTime() / 1000 + DAY).length }));
    return { today, from, to, days: [...map.values()].sort((a, b) => a.date.localeCompare(b.date)), exam_countdown };
  };
  const facets = rows => {
    const count = (key, f) => Object.entries(rows.reduce((m, i) => { for (const k of [].concat(f(i))) if (k) m[k] = (m[k] ?? 0) + 1; return m; }, {})).map(([k, n]) => ({ [key]: k, count: n }));
    return { courses: [{ id: 'fixture-algebra', name: 'Линейная алгебра', count: rows.length }], topics: count('topic', i => i.topic), outcomes: count('outcome', i => i.outcome),
      tags: count('tag', i => i.tags), error_types: count('error_type', i => i.error_type) };
  };
  return function study(method, path, body) {
    if (!path.startsWith('/study/')) return null;
    const [route, search] = path.replace('/study/', '').split('?');
    const q = new URLSearchParams(search ?? window.__studyQuery ?? '');
    const ok = value => ({ status: 200, body: value });
    if (method === 'GET' && route === 'bank') {
      const state_ = q.get('state') || 'active';
      let rows = items.filter(i => (state_ === 'active' ? !i.suspended : state_ === 'suspended' ? i.suspended : true));
      for (const [k, f] of [['outcome', i => i.outcome], ['topic', i => i.topic], ['tag', i => i.tags], ['error_type', i => i.error_type]]) if (q.get(k)) rows = rows.filter(i => [].concat(f(i)).includes(q.get(k)));
      if (q.get('q')) rows = rows.filter(i => i.question.toLowerCase().includes(q.get('q').toLowerCase()));
      return ok({ items: rows, total: rows.length, truncated: false, facets: facets(items) });
    }
    if (method === 'GET' && route === 'due') {
      const due = items.filter(i => !i.suspended && i.due_at <= now());
      return ok({ now: now(), total_due: due.length, items: due, upcoming_week: 1,
        topics: due.map(i => ({ topic: i.topic, course_id: i.course_id, course: i.course, due_at: i.due_at, due_count: 1, weak: 1, total: 1 })) });
    }
    if (method === 'GET' && route === 'calendar') return ok(calendar(q.get('from'), q.get('to')));
    if (method === 'GET' && route === 'calendar/ics') return ok({ filename: 'graphy-study.ics', content_type: 'text/calendar', content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' });
    if (method === 'POST' && route === 'events') { const e = { id: `E${events.length + 1}`, ...body }; events.push(e); return { status: 201, body: e }; }
    if (method === 'DELETE' && route.startsWith('events/')) { const i = events.findIndex(e => e.id === route.slice(7)); if (i >= 0) events.splice(i, 1); return ok({}); }
    if (method === 'PATCH' && route.startsWith('items/')) {
      const i = items.find(x => x.id === route.slice(6));
      if (i) { if (body.tags) i.tags = body.tags; if (body.note !== undefined) i.note = body.note; if (body.suspended !== undefined) i.suspended = body.suspended; if (body.deleted) items.splice(items.indexOf(i), 1); }
      return ok({ id: route.slice(6), updated: true });
    }
    if (method === 'POST' && route === 'review/next') return ok({ course_id: 'fixture-algebra', count: 2, prompt: 'Давай освежим…', items: items.slice(0, 2) });
    return { status: 404, body: { error: { code: 'not_found', message: 'fixture' } } };
  };
}
