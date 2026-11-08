/**
 * School: assignments (materials and quizzes) shared by teachers with classes, student attempts and grading.
 * Pure logic + JSON storage; the hub passes class/user lookups. Contract: .orch/DESIGN-school.md
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const fail = (status, message, code = 'school_error') => Object.assign(new Error(message), { status, code });
const ID_RE = /^[\w-]+$/;
export const MAX_MATERIAL = 3 * 1024 * 1024;
const GRACE_MS = 5000;
const SHOW = ['after_submit', 'after_deadline', 'never'];

// ---------- pure logic ----------
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const int = (v, lo, hi, def) => { if (v == null || v === '') return def; const n = Math.floor(Number(v)); if (!Number.isFinite(n) || n < lo || n > hi) throw fail(400, `Значение вне диапазона (${lo}..${hi})`); return n; };

export function normalizeDeadline(v) {
  if (v == null || v === '' || v === 0) return null;
  const n = typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(n) || n <= 0) throw fail(400, 'Некорректный дедлайн');
  return Math.floor(n);
}

export function normalizeSettings(s = {}, old = {}) {
  const m = { ...old, ...s };
  const tl = m.time_limit_sec;
  return {
    time_limit_sec: tl == null || tl === '' || tl === 0 ? null : int(tl, 30, 28800, null),
    attempts: int(m.attempts, 1, 20, 1),
    show_answers: m.show_answers == null ? 'after_submit' : SHOW.includes(m.show_answers) ? m.show_answers : (() => { throw fail(400, 'Некорректный show_answers'); })(),
    shuffle_questions: !!m.shuffle_questions,
  };
}

export function normalizeQuestions(list) {
  if (!Array.isArray(list) || !list.length) throw fail(400, 'Добавьте хотя бы один вопрос');
  if (list.length > 100) throw fail(400, 'Не больше 100 вопросов');
  const seen = new Set();
  return list.map((q, i) => {
    const id = str(q?.id, 100) || `q${i + 1}`;
    if (!ID_RE.test(id) || seen.has(id)) throw fail(400, `Некорректный или повторяющийся id вопроса: ${id}`);
    seen.add(id);
    const type = q?.type;
    if (!['free_text', 'single_choice', 'multiple_choice'].includes(type)) throw fail(400, `Вопрос ${id}: неизвестный тип`);
    const prompt = str(q.prompt, 8000);
    if (!prompt) throw fail(400, `Вопрос ${id}: пустой текст`);
    const out = { id, type, prompt };
    if (type !== 'free_text') {
      const opts = Array.isArray(q.options) ? q.options : [];
      if (opts.length < 2 || opts.length > 8) throw fail(400, `Вопрос ${id}: нужно 2..8 вариантов`);
      const oids = new Set();
      out.options = opts.map((o, j) => {
        const oid = str(o?.id, 100) || String.fromCharCode(97 + j);
        const label = str(o?.label, 8000);
        if (!ID_RE.test(oid) || oids.has(oid) || !label) throw fail(400, `Вопрос ${id}: некорректный вариант`);
        oids.add(oid);
        return { id: oid, label };
      });
      if (q.allow_custom_answer != null) out.allow_custom_answer = !!q.allow_custom_answer;
      const correct = q.grading?.correct_option_ids;
      if (correct != null) {
        if (!Array.isArray(correct) || !correct.every((c) => oids.has(c))) throw fail(400, `Вопрос ${id}: правильный ответ не из вариантов`);
        if (type === 'single_choice' && correct.length > 1) throw fail(400, `Вопрос ${id}: один правильный ответ`);
        if (correct.length) out.grading = { correct_option_ids: [...new Set(correct)] };
      }
    }
    const ex = str(q.grading?.explanation, 8000), rb = str(q.grading?.rubric, 8000);
    if (ex || rb) out.grading = { ...(out.grading || {}), ...(ex ? { explanation: ex } : {}), ...(rb ? { rubric: rb } : {}) };
    return out;
  });
}

/** Grades answers. manual: { [question_id]: true|false } teacher verdicts for pending questions. */
export function gradeAttempt(questions, answers, manual = {}) {
  const byQ = new Map((Array.isArray(answers) ? answers : []).map((a) => [a?.question_id, a]));
  let score = 0, pending = 0;
  const results = questions.map((q) => {
    const a = byQ.get(q.id);
    const selected = Array.isArray(a?.selected_option_ids) ? a.selected_option_ids.map(String) : [];
    const text = str(a?.text, 8000);
    const answered = a?.status === 'answered' && (selected.length || text);
    let correct;
    if (!answered) correct = false;
    else if (q.type === 'free_text' || text || !q.grading?.correct_option_ids?.length) correct = null;
    else {
      const want = new Set(q.grading.correct_option_ids), got = new Set(selected);
      correct = want.size === got.size && [...want].every((x) => got.has(x));
    }
    const r = { question_id: q.id, correct };
    if (correct === null && manual[q.id] != null) { r.correct = !!manual[q.id]; r.manual = true; }
    if (r.correct === true) score++; else if (r.correct === null) pending++;
    return r;
  });
  return { score, max: questions.length, pending, results };
}

export function normalizeAnswers(questions, answers) {
  if (!Array.isArray(answers)) throw fail(400, 'answers должен быть массивом');
  const qs = new Map(questions.map((q) => [q.id, q]));
  const seen = new Set(), out = [];
  for (const a of answers) {
    const q = qs.get(a?.question_id);
    if (!q || seen.has(q.id)) continue; // unknown or duplicate answers are ignored
    seen.add(q.id);
    const status = ['answered', 'skipped', 'dont_know'].includes(a.status) ? a.status : 'answered';
    let selected = Array.isArray(a.selected_option_ids) ? a.selected_option_ids.map(String) : [];
    const opts = new Set((q.options || []).map((o) => o.id));
    selected = [...new Set(selected.filter((x) => opts.has(x)))];
    if (q.type === 'single_choice') selected = selected.slice(0, 1);
    if (q.type === 'free_text') selected = [];
    let text = str(a.text, 8000);
    if (q.type !== 'free_text' && q.allow_custom_answer === false) text = '';
    if (q.type !== 'free_text' && text) selected = [];
    out.push({ question_id: q.id, status: status === 'answered' && !selected.length && !text ? 'skipped' : status, selected_option_ids: status === 'answered' ? selected : [], text: status === 'answered' ? text : '' });
  }
  return out;
}

export function shuffled(arr, rnd = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export const attemptEnd = (a, quiz, deadline) => {
  const lim = quiz.settings.time_limit_sec ? a.started_at + quiz.settings.time_limit_sec * 1000 : Infinity;
  const end = Math.min(lim, deadline ?? Infinity);
  return Number.isFinite(end) ? end : null;
};

const bestOf = (attempts) => attempts.filter((a) => a.submitted_at).reduce((b, a) => (!b || a.score >= b.score ? a : b), null);

/** status of one student for a quiz given their (already finalized) attempts */
export function quizStatus(asg, attempts, now) {
  const open = attempts.find((a) => !a.submitted_at && (a.ends_at == null || a.ends_at > now));
  const best = bestOf(attempts);
  if (open) return { status: 'in_progress', status_label: 'Выполняется' };
  if (best) return { status: 'submitted', status_label: `Решил ${best.score} из ${best.max}${best.pending ? `; ${best.pending} на проверке` : ''}` };
  if (asg.deadline != null && asg.deadline <= now) return { status: 'missed', status_label: 'Не выполнил до дедлайна' };
  return { status: 'not_started', status_label: 'Пока не выполнил' };
}

const revealAllowed = (asg, att, now) => {
  const s = asg.quiz.settings.show_answers;
  if (s === 'never') return false;
  if (s === 'after_deadline' && asg.deadline != null) return asg.deadline <= now;
  return !!att.submitted_at;
};

// ---------- service ----------
/**
 * deps: { dir, classes: () => ({code: {code,title,teacher,students:{id:{}}}}), users: () => ({id: user}), now?: () => ms, rnd?, flushMs? }
 * handle(me, method, pathname, query(URLSearchParams), body) -> { status, body } | null when the path is not ours.
 */
export function createSchool(deps) {
  const now = deps.now || Date.now;
  const dir = deps.dir, file = path.join(dir, 'school.json'), filesDir = path.join(dir, 'school-files');
  fs.mkdirSync(filesDir, { recursive: true });
  let store = { assignments: {}, attempts: {} }; // attempts[aid][studentId] = [attempt]
  try { store = { ...store, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  let dirty = false;
  const save = () => { dirty = true; };
  const flush = () => { if (!dirty) return; dirty = false; try { fs.writeFileSync(file + '.tmp', JSON.stringify(store)); fs.renameSync(file + '.tmp', file); } catch (e) { console.error('school save failed', e.message); } };
  const timer = setInterval(flush, deps.flushMs ?? 1500); timer.unref?.();
  const byClass = new Map(); // class code -> Set(id)
  const indexAdd = (a) => { if (!byClass.has(a.class_code)) byClass.set(a.class_code, new Set()); byClass.get(a.class_code).add(a.id); };
  for (const a of Object.values(store.assignments)) indexAdd(a);

  const name = (id) => { const u = deps.users()[id]; return u ? ([u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `id${id}`) : String(id); };
  const cls = (code) => deps.classes()[code];
  const recipients = (a) => { const c = cls(a.class_code); if (!c) return []; const ids = Object.keys(c.students); return a.student_ids ? ids.filter((i) => a.student_ids.includes(i)) : ids; };
  const addressed = (a, uid) => recipients(a).includes(uid);
  const getAsg = (id) => { const a = store.assignments[id]; if (!a) throw fail(404, 'Задание не найдено', 'not_found'); return a; };
  const teacherAsg = (me, id) => {
    const a = getAsg(id); const c = cls(a.class_code);
    if (me.role !== 'teacher' || !c || c.teacher !== me.id) throw fail(403, 'Это не ваше задание', 'forbidden');
    return a;
  };
  const studentAsg = (me, id) => {
    const a = getAsg(id);
    if (!addressed(a, me.id)) throw fail(404, 'Задание не найдено', 'not_found');
    return a;
  };
  const attemptsOf = (aid, sid) => store.attempts[aid]?.[sid] || [];

  /** finalizes expired open attempts from the last draft */
  function finalize(a, att) {
    if (att.submitted_at || att.ends_at == null || att.ends_at > now()) return;
    submitAttempt(a, att, att.draft || [], att.ends_at, true);
  }
  function submitAttempt(a, att, answers, at, auto) {
    const ans = normalizeAnswers(a.quiz.questions, answers);
    const g = gradeAttempt(a.quiz.questions, ans, att.manual || {});
    Object.assign(att, { answers: ans, submitted_at: at, auto: !!auto, score: g.score, max: g.max, pending: g.pending, results: g.results });
    delete att.draft;
    save();
  }
  const finalizeAll = (a, sid) => { for (const att of attemptsOf(a.id, sid)) finalize(a, att); };

  const summary = (a) => {
    const c = cls(a.class_code);
    const s = { id: a.id, class_code: a.class_code, class_title: c?.title || '', kind: a.kind, title: a.title, description: a.description, deadline: a.deadline, created: a.created, updated: a.updated };
    if (a.material) s.material = { name: a.material.name, mime: a.material.mime, size: a.material.size };
    if (a.quiz) s.quiz = { question_count: a.quiz.questions.length, settings: a.quiz.settings };
    return s;
  };
  const teacherSummary = (a) => {
    const s = { ...summary(a), recipients_count: recipients(a).length };
    if (a.kind === 'quiz') {
      const st = { submitted: 0, in_progress: 0, missed: 0, not_started: 0, pending_review: 0 };
      for (const sid of recipients(a)) {
        finalizeAll(a, sid);
        const atts = attemptsOf(a.id, sid);
        st[quizStatus(a, atts, now()).status]++;
        const best = bestOf(atts); if (best?.pending) st.pending_review++;
      }
      s.stats = st;
    }
    return s;
  };
  const studentItem = (a, sid) => {
    const c = cls(a.class_code);
    const item = { ...summary(a), teacher_name: c ? name(c.teacher) : '' };
    if (a.kind === 'material') return { ...item, status: 'material', status_label: 'Материал' };
    finalizeAll(a, sid);
    const atts = attemptsOf(a.id, sid), t = now();
    Object.assign(item, quizStatus(a, atts, t));
    const used = atts.length;
    item.attempts_used = used;
    item.attempts_left = Math.max(0, a.quiz.settings.attempts - used);
    const open = atts.find((x) => !x.submitted_at);
    if (open) item.in_progress = { attempt: open.n, ends_at: open.ends_at, time_left_sec: open.ends_at == null ? null : Math.max(0, Math.ceil((open.ends_at - t) / 1000)) };
    const best = bestOf(atts);
    if (best) item.best = { attempt: best.n, score: best.score, max: best.max, pending: best.pending, submitted_at: best.submitted_at };
    return item;
  };
  /** frozen questions in the attempt's stable order, without the answer key */
  const orderedQuestions = (a, att) => (att.order || a.quiz.questions.map((x) => x.id)).map((id) => a.quiz.questions.find((x) => x.id === id)).filter(Boolean).map(({ grading, ...rest }) => rest);
  const timeLeft = (att, t) => (att.ends_at == null ? null : Math.max(0, Math.ceil((att.ends_at - t) / 1000)));
  /** state of an open attempt for any device: draft answers, position, server-side remaining time */
  const openView = (a, att, t) => ({ attempt: att.n, started_at: att.started_at, ends_at: att.ends_at, server_time: t, time_left_sec: timeLeft(att, t), questions: orderedQuestions(a, att), answers: att.draft || [], position: att.pos || 0, saved_at: att.draft_at || null });
  const attemptView = (a, att, forTeacher) => {
    const t = now();
    const v = { attempt: att.n, started_at: att.started_at, ends_at: att.ends_at, submitted_at: att.submitted_at || null, duration_sec: att.submitted_at ? Math.round((att.submitted_at - att.started_at) / 1000) : null, auto: !!att.auto, score: att.score ?? null, max: att.max ?? a.quiz.questions.length, pending: att.pending ?? 0 };
    if (forTeacher) {
      v.answers = att.answers || [];
      v.results = (att.results || []).map((r) => { const q = a.quiz.questions.find((x) => x.id === r.question_id); return { ...r, correct_option_ids: q?.grading?.correct_option_ids, explanation: q?.grading?.explanation }; });
    } else if (att.submitted_at && revealAllowed(a, att, t)) {
      v.answers = att.answers;
      v.questions = orderedQuestions(a, att);
      v.results = att.results.map((r) => { const q = a.quiz.questions.find((x) => x.id === r.question_id); return { ...r, correct_option_ids: q?.grading?.correct_option_ids, explanation: q?.grading?.explanation }; });
    } else { v.results = []; if (att.submitted_at) { v.answers = att.answers; v.questions = orderedQuestions(a, att); } }
    return v;
  };
  const detailFor = (me, a) => {
    if (me.role === 'teacher' && cls(a.class_code)?.teacher === me.id) {
      const d = teacherSummary(a);
      if (a.quiz) d.quiz = a.quiz;
      d.student_ids = a.student_ids;
      d.recipients = recipients(a).map((id) => ({ id, name: name(id) }));
      return d;
    }
    return studentItem(a, me.id);
  };

  function readMaterial(m) {
    if (!m || typeof m !== 'object') throw fail(400, 'Нужен материал {name, mime, text|base64}');
    const nm = str(m.name, 200), mime = str(m.mime, 100) || 'text/plain';
    if (!nm) throw fail(400, 'У материала нет имени');
    let buf, enc;
    if (typeof m.base64 === 'string') { buf = Buffer.from(m.base64, 'base64'); enc = 'base64'; }
    else if (typeof m.text === 'string') { buf = Buffer.from(m.text, 'utf8'); enc = 'text'; }
    else throw fail(400, 'Нужен text или base64');
    if (!buf.length) throw fail(400, 'Пустой материал');
    if (buf.length > MAX_MATERIAL) throw fail(413, 'Материал больше 3 МБ');
    return { meta: { name: nm, mime, size: buf.length, enc }, buf };
  }
  const writeMaterial = (id, buf) => { const f = path.join(filesDir, id); fs.writeFileSync(f + '.tmp', buf); fs.renameSync(f + '.tmp', f); };

  const ok = (body, status = 200) => ({ status, body });
  const need = (cond, status, msg, code) => { if (!cond) throw fail(status, msg, code); };

  function create(me, b) {
    need(me.role === 'teacher', 403, 'Задания создаёт учитель', 'forbidden');
    const kind = b.kind;
    need(kind === 'material' || kind === 'quiz', 400, 'kind: material или quiz');
    const title = str(b.title, 120); need(title, 400, 'Укажите название');
    const codes = [...new Set(Array.isArray(b.class_codes) ? b.class_codes.map(String) : b.class_code ? [String(b.class_code)] : [])];
    need(codes.length && codes.length <= 30, 400, 'Выберите класс');
    for (const code of codes) { const c = cls(code); need(c, 404, 'Класс не найден', 'not_found'); need(c.teacher === me.id, 403, 'Это не ваш класс', 'forbidden'); }
    let studentIds = null;
    if (Array.isArray(b.student_ids) && b.student_ids.length) {
      studentIds = [...new Set(b.student_ids.map(String))];
      for (const code of codes) for (const sid of studentIds) need(cls(code).students[sid], 400, 'Ученик не из этого класса');
    }
    const deadline = normalizeDeadline(b.deadline);
    const base = { kind, title, description: str(b.description, 2000), deadline, student_ids: studentIds, teacher: me.id };
    let mat = null, quiz = null;
    if (kind === 'material') mat = readMaterial(b.material);
    else quiz = { questions: normalizeQuestions(b.quiz?.questions), settings: normalizeSettings(b.quiz?.settings) };
    const made = [];
    for (const code of codes) {
      const id = crypto.randomBytes(6).toString('hex');
      const a = { id, class_code: code, ...base, created: now(), updated: now() };
      if (mat) { a.material = mat.meta; writeMaterial(id, mat.buf); } else a.quiz = quiz;
      store.assignments[id] = a; indexAdd(a); made.push(a);
    }
    save();
    return ok({ assignments: made.map(teacherSummary) }, 201);
  }

  function update(me, a, b) {
    if (b.title != null) { const t = str(b.title, 120); need(t, 400, 'Укажите название'); a.title = t; }
    if (b.description != null) a.description = str(b.description, 2000);
    if ('deadline' in b) a.deadline = normalizeDeadline(b.deadline);
    if ('student_ids' in b) {
      if (Array.isArray(b.student_ids) && b.student_ids.length) {
        const ids = [...new Set(b.student_ids.map(String))];
        for (const sid of ids) need(cls(a.class_code).students[sid], 400, 'Ученик не из этого класса');
        a.student_ids = ids;
      } else a.student_ids = null;
    }
    if (b.material) {
      need(a.kind === 'material', 400, 'Это не материал', 'not_material');
      const m = readMaterial(b.material); a.material = m.meta; writeMaterial(a.id, m.buf);
    }
    if (b.quiz) {
      need(a.kind === 'quiz', 400, 'Это не тест', 'not_quiz');
      if (b.quiz.questions != null) {
        need(!Object.keys(store.attempts[a.id] || {}).length, 409, 'Вопросы нельзя менять после начала прохождения', 'has_attempts');
        a.quiz.questions = normalizeQuestions(b.quiz.questions);
      }
      if (b.quiz.settings) a.quiz.settings = normalizeSettings(b.quiz.settings, a.quiz.settings);
    }
    a.updated = now(); save();
    return ok({ assignment: detailFor(me, a) });
  }

  function remove(a) {
    delete store.assignments[a.id]; delete store.attempts[a.id]; byClass.get(a.class_code)?.delete(a.id);
    try { fs.rmSync(path.join(filesDir, a.id), { force: true }); } catch { /* ignore */ }
    save();
    return ok({ deleted: true });
  }

  function listTeacher(me, q) {
    need(me.role === 'teacher', 403, 'Только для учителя', 'forbidden');
    const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 5)), offset = Math.max(0, Number(q.get('offset')) || 0);
    const only = q.get('class');
    const out = Object.values(deps.classes()).filter((c) => c.teacher === me.id && (!only || c.code === only)).map((c) => {
      const all = [...(byClass.get(c.code) || [])].map((id) => store.assignments[id]).filter(Boolean).sort((x, y) => y.created - x.created);
      return { code: c.code, title: c.title, total: all.length, items: all.slice(offset, offset + limit).map(teacherSummary) };
    });
    return ok({ classes: out });
  }

  function listStudent(me, q) {
    const only = q.get('class');
    const items = Object.values(store.assignments).filter((a) => (!only || a.class_code === only) && addressed(a, me.id)).sort((x, y) => y.created - x.created).map((a) => studentItem(a, me.id));
    return ok({ items });
  }

  function start(me, a) {
    need(a.kind === 'quiz', 400, 'Это не тест', 'not_quiz');
    const sid = me.id; finalizeAll(a, sid);
    const t = now(), atts = (store.attempts[a.id] ||= {})[sid] ||= [];
    let att = atts.find((x) => !x.submitted_at);
    if (!att) {
      need(a.deadline == null || a.deadline > t, 403, 'Дедлайн прошёл', 'deadline_passed');
      need(atts.length < a.quiz.settings.attempts, 403, 'Попытки закончились', 'no_attempts');
      att = { n: atts.length + 1, started_at: t, ends_at: null, submitted_at: null, draft: [] };
      att.ends_at = attemptEnd(att, a.quiz, a.deadline);
      const ids = a.quiz.questions.map((x) => x.id);
      att.order = a.quiz.settings.shuffle_questions ? shuffled(ids, deps.rnd) : ids;
      atts.push(att); save();
    }
    return ok(openView(a, att, t));
  }

  const openAttempt = (a, sid) => { finalizeAll(a, sid); const att = attemptsOf(a.id, sid).find((x) => !x.submitted_at); need(att, 409, 'Нет активной попытки (время вышло или тест не начат)', 'no_open_attempt'); return att; };

  function draft(me, a, b) {
    need(a.kind === 'quiz', 400, 'Это не тест', 'not_quiz');
    const att = openAttempt(a, me.id);
    att.draft = normalizeAnswers(a.quiz.questions, b.answers);
    if (Number.isInteger(b.position) && b.position >= 0 && b.position < a.quiz.questions.length) att.pos = b.position;
    att.draft_at = now(); save();
    return ok({ saved: true, saved_at: att.draft_at, server_time: att.draft_at, time_left_sec: timeLeft(att, att.draft_at) });
  }

  function submit(me, a, b) {
    need(a.kind === 'quiz', 400, 'Это не тест', 'not_quiz');
    const sid = me.id, t = now();
    const att = attemptsOf(a.id, sid).find((x) => !x.submitted_at);
    need(att, 409, 'Нет активной попытки', 'no_open_attempt');
    if (att.ends_at != null && t > att.ends_at + GRACE_MS) { finalize(a, att); return ok({ attempt: attemptView(a, att, false) }); }
    const late = att.ends_at != null && t > att.ends_at;
    submitAttempt(a, att, b.answers, late ? att.ends_at : t, att.ends_at != null && t >= att.ends_at - 1000 && !!b.auto);
    return ok({ attempt: attemptView(a, att, false) });
  }

  function results(a) {
    need(a.kind === 'quiz', 400, 'Это не тест', 'not_quiz');
    const t = now();
    const rows = recipients(a).map((sid) => {
      finalizeAll(a, sid);
      const atts = attemptsOf(a.id, sid), st = quizStatus(a, atts, t);
      const best = bestOf(atts) || atts[atts.length - 1] || null;
      return { student: { id: sid, name: name(sid) }, ...st, attempts_used: atts.length, attempts_left: Math.max(0, a.quiz.settings.attempts - atts.length),
        started_at: best?.started_at ?? null, submitted_at: best?.submitted_at ?? null, duration_sec: best?.submitted_at ? Math.round((best.submitted_at - best.started_at) / 1000) : null,
        score: best?.submitted_at ? best.score : null, max: a.quiz.questions.length, pending: best?.submitted_at ? best.pending : 0, auto: !!best?.auto };
    }).sort((x, y) => x.student.name.localeCompare(y.student.name, 'ru'));
    return ok({ assignment: teacherSummary(a), rows });
  }

  function override(a, sid, n, b) {
    need(a.kind === 'quiz', 400, 'Это не тест', 'not_quiz');
    need(recipients(a).includes(sid), 404, 'Ученик не найден', 'not_found');
    finalizeAll(a, sid);
    const att = attemptsOf(a.id, sid).find((x) => x.n === n && x.submitted_at);
    need(att, 404, 'Попытка не найдена', 'not_found');
    need(a.quiz.questions.some((x) => x.id === b.question_id), 400, 'Неизвестный вопрос');
    need(typeof b.correct === 'boolean', 400, 'correct: true или false');
    att.manual = { ...(att.manual || {}), [b.question_id]: b.correct };
    const g = gradeAttempt(a.quiz.questions, att.answers, att.manual);
    Object.assign(att, { score: g.score, pending: g.pending, results: g.results }); save();
    return ok({ attempt: attemptView(a, att, true) });
  }

  function material(a) {
    need(a.kind === 'material' && a.material, 400, 'Нет материала', 'not_material');
    const buf = fs.readFileSync(path.join(filesDir, a.id));
    const { name: nm, mime, enc } = a.material;
    return ok(enc === 'text' ? { name: nm, mime, text: buf.toString('utf8') } : { name: nm, mime, base64: buf.toString('base64') });
  }

  function handle(me, method, p, q, body) {
    if (!p.startsWith('/hub/school/')) return null;
    const teacher = me.role === 'teacher';
    let m;
    if (p === '/hub/school/my' && method === 'GET') return listStudent(me, q);
    if (p === '/hub/school/assignments' && method === 'POST') return create(me, body);
    if (p === '/hub/school/assignments' && method === 'GET') return listTeacher(me, q);
    if (!(m = /^\/hub\/school\/assignments\/([0-9a-f]{12})(?:\/(.*))?$/.exec(p))) throw fail(404, 'Не найдено', 'not_found');
    const id = m[1], sub = m[2] || '';
    const asTeacher = () => teacherAsg(me, id);
    if (sub === '') {
      if (method === 'GET') { const a = teacher && cls(getAsg(id).class_code)?.teacher === me.id ? asTeacher() : studentAsg(me, id); return ok({ assignment: detailFor(me, a) }); }
      if (method === 'PUT') return update(me, asTeacher(), body);
      if (method === 'DELETE') return remove(asTeacher());
    }
    if (sub === 'material' && method === 'GET') return material(teacher && cls(getAsg(id).class_code)?.teacher === me.id ? asTeacher() : studentAsg(me, id));
    if (sub === 'results' && method === 'GET') return results(asTeacher());
    let r;
    if ((r = /^results\/(\w+)$/.exec(sub)) && method === 'GET') {
      const a = asTeacher(); need(a.kind === 'quiz', 400, 'Это не тест', 'not_quiz');
      need(recipients(a).includes(r[1]), 404, 'Ученик не найден', 'not_found');
      finalizeAll(a, r[1]);
      return ok({ student: { id: r[1], name: name(r[1]) }, attempts: attemptsOf(id, r[1]).filter((x) => x.submitted_at).map((x) => attemptView(a, x, true)) });
    }
    if ((r = /^results\/(\w+)\/(\d+)\/score$/.exec(sub)) && method === 'PUT') return override(asTeacher(), r[1], Number(r[2]), body);
    if (sub === 'start' && method === 'POST') return start(me, studentAsg(me, id));
    if (sub === 'draft' && method === 'PUT') return draft(me, studentAsg(me, id), body);
    if (sub === 'submit' && method === 'POST') return submit(me, studentAsg(me, id), body);
    if (sub === 'attempts' && method === 'GET') {
      const a = studentAsg(me, id); need(a.kind === 'quiz', 400, 'Это не тест', 'not_quiz');
      finalizeAll(a, me.id);
      const open = attemptsOf(id, me.id).find((x) => !x.submitted_at);
      return ok({ attempts: attemptsOf(id, me.id).filter((x) => x.submitted_at).map((x) => attemptView(a, x, false)), open: open ? openView(a, open, now()) : null });
    }
    throw fail(404, 'Не найдено', 'not_found');
  }
  return { handle, flush, _store: store };
}
