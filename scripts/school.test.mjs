import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSchool, gradeAttempt, quizStatus, normalizeQuestions, normalizeSettings } from './school.mjs';

const Q = [
  { id: 'q1', type: 'single_choice', prompt: 'a?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], grading: { correct_option_ids: ['a'], explanation: 'because' } },
  { id: 'q2', type: 'multiple_choice', prompt: 'b?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], grading: { correct_option_ids: ['a', 'b'] } },
  { id: 'q3', type: 'free_text', prompt: 'why?' },
];
const ans = (id, sel = [], text = '', status = 'answered') => ({ question_id: id, status, selected_option_ids: sel, text });

function setup() {
  let t = 1_000_000;
  const classes = { c1: { code: 'c1', title: '9б', teacher: 'T', students: { S1: {}, S2: {} } }, c2: { code: 'c2', title: '10а', teacher: 'T2', students: { S1: {} } } };
  const users = { T: { first_name: 'Teach' }, T2: { first_name: 'Other' }, S1: { first_name: 'Ann' }, S2: { first_name: 'Bob' } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-'));
  const s = createSchool({ dir, classes: () => classes, users: () => users, now: () => t, flushMs: 1e9, rnd: () => 0 });
  const T = { id: 'T', role: 'teacher' }, T2 = { id: 'T2', role: 'teacher' }, S1 = { id: 'S1', role: 'student' }, S2 = { id: 'S2', role: 'student' };
  const call = (me, m, p, body = {}, q = '') => s.handle(me, m, p, new URLSearchParams(q), body);
  return { s, call, T, T2, S1, S2, tick: (ms) => { t += ms; }, now: () => t, classes };
}
const mk = (env, extra = {}) => env.call(env.T, 'POST', '/hub/school/assignments', { class_codes: ['c1'], kind: 'quiz', title: 'Тест', deadline: env.now() + 3_600_000, quiz: { questions: Q, settings: { time_limit_sec: 60, attempts: 2 } }, ...extra }).body.assignments[0];

test('grading: exact set, open pending, skipped wrong', () => {
  const g = gradeAttempt(Q, [ans('q1', ['a']), ans('q2', ['a']), ans('q3', [], 'text')]);
  assert.deepEqual([g.score, g.max, g.pending], [1, 3, 1]);
  const g2 = gradeAttempt(Q, [ans('q1', ['a']), ans('q2', ['a', 'b']), ans('q3', [], '', 'skipped')]);
  assert.deepEqual([g2.score, g2.pending], [2, 0]);
  assert.equal(gradeAttempt(Q, [ans('q3', [], 'x')], { q3: true }).score, 1);
});

test('validation of questions and settings', () => {
  assert.throws(() => normalizeQuestions([]));
  assert.throws(() => normalizeQuestions([{ id: 'x', type: 'single_choice', prompt: 'p', options: [{ id: 'a', label: 'A' }] }]));
  assert.throws(() => normalizeQuestions([{ id: 'x', type: 'single_choice', prompt: 'p', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], grading: { correct_option_ids: ['z'] } }]));
  assert.deepEqual(normalizeSettings({}), { time_limit_sec: null, attempts: 1, show_answers: 'after_submit', shuffle_questions: false });
  assert.throws(() => normalizeSettings({ attempts: 0 }));
});

test('status rules', () => {
  const asg = { deadline: 100 };
  assert.equal(quizStatus(asg, [], 50).status, 'not_started');
  assert.equal(quizStatus(asg, [], 100).status, 'missed');
  assert.equal(quizStatus({ deadline: null }, [], 1e12).status, 'not_started');
  assert.equal(quizStatus(asg, [{ n: 1, submitted_at: 60, score: 2, max: 3, pending: 0 }], 500).status_label, 'Решил 2 из 3');
  assert.equal(quizStatus(asg, [{ n: 1, submitted_at: null, ends_at: 200 }], 150).status, 'in_progress');
});

test('authorization', () => {
  const e = setup();
  assert.throws(() => e.call(e.S1, 'POST', '/hub/school/assignments', { class_codes: ['c1'], kind: 'quiz', title: 't' }), /учитель/);
  assert.throws(() => e.call(e.T2, 'POST', '/hub/school/assignments', { class_codes: ['c1'], kind: 'material', title: 't', material: { name: 'a', text: 'x' } }), /не ваш/);
  const a = mk(e);
  assert.throws(() => e.call(e.T2, 'GET', `/hub/school/assignments/${a.id}/results`), /не ваше/);
  assert.throws(() => e.call(e.T2, 'DELETE', `/hub/school/assignments/${a.id}`));
  assert.throws(() => e.call(e.S1, 'GET', `/hub/school/assignments/${a.id}/results`));
  const only = mk(e, { student_ids: ['S1'] });
  assert.equal(e.call(e.S2, 'GET', '/hub/school/my').body.items.length, 1);
  assert.throws(() => e.call(e.S2, 'POST', `/hub/school/assignments/${only.id}/start`), /не найдено/);
  assert.equal(e.call(e.S1, 'GET', '/hub/school/my').body.items.length, 2);
});

test('material create and read', () => {
  const e = setup();
  const r = e.call(e.T, 'POST', '/hub/school/assignments', { class_codes: ['c1', 'c2'.replace('c2', 'c1')], kind: 'material', title: 'Конспект', material: { name: 'n.md', mime: 'text/markdown', text: '# hi' } });
  assert.equal(r.body.assignments.length, 1);
  const id = r.body.assignments[0].id;
  assert.equal(e.call(e.S1, 'GET', `/hub/school/assignments/${id}/material`).body.text, '# hi');
  assert.throws(() => e.call(e.T, 'POST', '/hub/school/assignments', { class_codes: ['c1'], kind: 'material', title: 'x', material: { name: 'big', base64: Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64') } }), /3 МБ/);
});

test('attempt flow: start, resume, time limit, submit, attempts, statuses', () => {
  const e = setup();
  const a = mk(e), base = `/hub/school/assignments/${a.id}`;
  let st = e.call(e.T, 'GET', `${base}/results`).body.rows;
  assert.deepEqual(st.map((r) => r.status), ['not_started', 'not_started']);
  const s1 = e.call(e.S1, 'POST', `${base}/start`).body;
  assert.equal(s1.questions.length, 3);
  assert.ok(!s1.questions.some((q) => q.grading));
  assert.equal(s1.time_left_sec, 60);
  e.tick(10_000);
  assert.equal(e.call(e.S1, 'POST', `${base}/start`).body.attempt, 1); // resume
  assert.equal(e.call(e.S1, 'GET', '/hub/school/my').body.items[0].status, 'in_progress');
  const sub = e.call(e.S1, 'POST', `${base}/submit`, { answers: [ans('q1', ['a']), ans('q3', [], 'free')] }).body.attempt;
  assert.deepEqual([sub.score, sub.max, sub.pending, sub.duration_sec], [1, 3, 1, 10]);
  assert.equal(sub.results.find((r) => r.question_id === 'q1').explanation, 'because');
  assert.throws(() => e.call(e.S1, 'POST', `${base}/submit`, { answers: [] }), /активной/);
  e.call(e.S1, 'POST', `${base}/start`); // attempt 2
  e.call(e.S1, 'PUT', `${base}/draft`, { answers: [ans('q1', ['a']), ans('q2', ['a', 'b'])] });
  e.tick(61_000); // time over, student never submits: lazy auto-submit from draft
  const rows = e.call(e.T, 'GET', `${base}/results`).body.rows;
  const r1 = rows.find((r) => r.student.id === 'S1');
  assert.equal(r1.status, 'submitted'); assert.equal(r1.attempts_used, 2); assert.equal(r1.score, 2); assert.equal(r1.auto, true); assert.equal(r1.duration_sec, 60);
  assert.throws(() => e.call(e.S1, 'POST', `${base}/start`), /Попытки/);
  assert.equal(rows.find((r) => r.student.id === 'S2').status, 'not_started');
  // manual override of pending question on attempt 1 (best stays attempt 2 with score 2)
  const ov = e.call(e.T, 'PUT', `${base}/results/S1/1/score`, { question_id: 'q3', correct: true }).body.attempt;
  assert.equal(ov.score, 2); assert.equal(ov.pending, 0);
});

test('deadline: late start refused, missed status, timer capped by deadline', () => {
  const e = setup();
  const a = mk(e, { deadline: e.now() + 30_000 }), base = `/hub/school/assignments/${a.id}`;
  const s = e.call(e.S1, 'POST', `${base}/start`).body;
  assert.equal(s.time_left_sec, 30); // min(limit 60, deadline 30)
  e.call(e.S1, 'PUT', `${base}/draft`, { answers: [ans('q1', ['a'])] });
  e.tick(40_000); // past ends_at + grace: late answers are ignored, the draft is used
  const late = e.call(e.S1, 'POST', `${base}/submit`, { answers: [ans('q1', ['b']), ans('q2', ['a', 'b'])] }).body.attempt;
  assert.equal(late.score, 1); assert.equal(late.auto, true); assert.equal(late.duration_sec, 30);
});

test('late start after deadline and missed status', () => {
  const e = setup();
  const a = mk(e, { deadline: e.now() + 1000 }), base = `/hub/school/assignments/${a.id}`;
  e.tick(2000);
  assert.throws(() => e.call(e.S2, 'POST', `${base}/start`), (err) => err.code === 'deadline_passed');
  assert.equal(e.call(e.S2, 'GET', '/hub/school/my').body.items[0].status_label, 'Не выполнил до дедлайна');
});

test('show_answers never hides results; frozen questions after start; list limit', () => {
  const e = setup();
  const a = mk(e, { quiz: { questions: Q, settings: { show_answers: 'never' } } }), base = `/hub/school/assignments/${a.id}`;
  e.call(e.S1, 'POST', `${base}/start`);
  const sub = e.call(e.S1, 'POST', `${base}/submit`, { answers: [ans('q1', ['a'])] }).body.attempt;
  assert.deepEqual(sub.results, []); assert.equal(sub.score, 1);
  assert.throws(() => e.call(e.T, 'PUT', base, { quiz: { questions: Q } }), (err) => err.code === 'has_attempts');
  for (let i = 0; i < 6; i++) { e.tick(1); mk(e); }
  const c = e.call(e.T, 'GET', '/hub/school/assignments', {}, 'limit=5').body.classes[0];
  assert.equal(c.items.length, 5); assert.equal(c.total, 7);
});

test('resume from another device returns draft, position, remaining time, frozen order', () => {
  const e = setup();
  const a = mk(e, { quiz: { questions: Q, settings: { time_limit_sec: 600, attempts: 2, shuffle_questions: true } } }), base = `/hub/school/assignments/${a.id}`;
  const s1 = e.call(e.S1, 'POST', `${base}/start`).body;
  e.call(e.S1, 'PUT', `${base}/draft`, { answers: [ans('q1', ['b'])], position: 2 });
  e.tick(30_000);
  const again = e.call({ id: 'S1', role: 'student' }, 'POST', `${base}/start`).body; // new session / device
  assert.equal(again.started_at, s1.started_at);
  assert.deepEqual(again.answers.map((x) => x.question_id), ['q1']);
  assert.deepEqual(again.answers[0].selected_option_ids, ['b']);
  assert.equal(again.position, 2); assert.equal(again.time_left_sec, 570);
  assert.deepEqual(again.questions.map((q) => q.id), s1.questions.map((q) => q.id));
  assert.ok(again.questions.every((q) => !q.grading));
  const att = e.call(e.S1, 'GET', `${base}/attempts`).body;
  assert.equal(att.open.answers.length, 1); assert.deepEqual(att.attempts, []);
});

test('submitted attempt review respects show_answers and teacher manual scores', () => {
  const e = setup();
  const mkp = (show, dl) => mk(e, { deadline: dl, quiz: { questions: Q, settings: { show_answers: show, attempts: 3 } } });
  const run = (a) => { const b = `/hub/school/assignments/${a.id}`; e.call(e.S1, 'POST', `${b}/start`); e.call(e.S1, 'POST', `${b}/submit`, { answers: [ans('q1', ['a']), ans('q3', [], 'txt')] }); return b; };
  const bs = run(mkp('after_submit', e.now() + 1e6));
  let v = e.call(e.S1, 'GET', `${bs}/attempts`).body.attempts[0];
  assert.equal(v.questions.length, 3); assert.equal(v.answers.length, 2); assert.equal(v.results[0].correct_option_ids[0], 'a');
  assert.ok(v.questions.every((q) => !q.grading));
  const an = mkp('never', null), bn = run(an);
  v = e.call(e.S1, 'GET', `${bn}/attempts`).body.attempts[0];
  assert.deepEqual(v.results, []); assert.equal(v.answers.length, 2); assert.equal(v.questions.length, 3);
  const ad = mkp('after_deadline', e.now() + 1000), bd = run(ad);
  assert.deepEqual(e.call(e.S1, 'GET', `${bd}/attempts`).body.attempts[0].results, []);
  e.call(e.T, 'PUT', `${bd}/results/S1/1/score`, { question_id: 'q3', correct: true });
  e.tick(2000);
  v = e.call(e.S1, 'GET', `${bd}/attempts`).body.attempts[0];
  assert.equal(v.results.find((r) => r.question_id === 'q3').correct, true); assert.equal(v.score, 2);
});

test('unauthorized read of attempts/draft is refused', () => {
  const e = setup();
  const a = mk(e), base = `/hub/school/assignments/${a.id}`;
  e.call(e.S1, 'POST', `${base}/start`);
  e.call(e.S1, 'POST', `${base}/submit`, { answers: [] });
  const outsider = { id: 'S9', role: 'student' };
  for (const [m, p] of [['GET', `${base}/attempts`], ['POST', `${base}/start`], ['GET', `${base}/results/S1`]])
    assert.throws(() => e.call(outsider, m, p), (err) => [403, 404].includes(err.status));
  assert.throws(() => e.call(e.T2, 'GET', `${base}/results/S1`), (err) => err.status === 403);
  assert.throws(() => e.call(e.S2, 'GET', `${base}/results/S1`), (err) => err.status === 403);
  assert.equal(e.call(e.S2, 'GET', `${base}/attempts`).body.attempts.length, 0); // S2 only sees own
});
