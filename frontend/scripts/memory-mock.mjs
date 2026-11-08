// In-memory fixture of the strategy-memory API (backend/docs/protocol.md, «Strategy memory»).
export function createMemoryMock() {
  const label = { analogy: 'Объяснение через аналогию', worked_example: 'Объяснение через пример', socratic: 'Наводящие вопросы' };
  const line = (id, form, outcome, topic, text) => ({ id, text, tag: '', status: 'active', form, form_label: label[form], topic, outcome, style: 'structured_reference', time: 1.78e9, included: true,
    source: { session: 'fixture-matrix', course_id: 'fixture-algebra', message: `m-${id}`, assessment: id.replace('obs-', '') } });
  const profile = (form, hint) => ({ preferred_style: null, preferred_form: form, hint_start: hint, step_size: null, evidence: form ? { preferred_form: `${label[form]}: 4 из 4 раз без подсказок` } : {} });
  const state = {
    settings: { adaptive: true },
    observations: [
      line('obs-a0', 'worked_example', 'independent', 'Матрицы', 'Объяснение через пример: задача решена без подсказок (тема: Матрицы)'),
      line('obs-a1', 'worked_example', 'independent', 'Матрицы', 'Объяснение через пример: задача решена без подсказок (тема: Матрицы)'),
      line('obs-a2', 'analogy', 'gap', 'Определитель', 'Объяснение через аналогию: в решении осталась ошибка (тема: Определитель)'),
      line('obs-a3', 'worked_example', 'with_hints', 'Определитель', 'Объяснение через пример: задача решена с подсказками (тема: Определитель)'),
    ],
    versions: [
      { version: 1, profile: profile('analogy', null), reason: 'Объяснение через аналогию: 4 из 4 раз без подсказок', created: 1.78e9, kind: 'auto' },
      { version: 2, profile: profile('worked_example', 'late'), reason: 'Объяснение через пример: 4 из 4 раз без подсказок; Без подсказок решено 5 из 6 задач', created: 1.781e9, kind: 'auto' },
    ],
  };
  const current = () => state.versions[state.versions.length - 1];
  const view = () => ({ settings: state.settings, strategy: current(), versions: [...state.versions].reverse(), observations: state.observations, rules: { min_samples: 4, half_life_days: 45 } });
  const ok = body => ({ status: 200, body });
  const fail = (status, message) => ({ status, body: { error: { code: 'invalid', message } } });
  return (method, path, body) => {
    if (!path.startsWith('/memory')) return null;
    if (window.__memoryFail) return fail(400, 'fixture failure');
    if (method === 'GET' && path === '/memory') return ok(view());
    if (method === 'PUT' && path === '/memory/settings') { Object.assign(state.settings, body); return ok(state.settings); }
    if (method === 'POST' && path === '/memory/rescan') return ok({ added: 0, sessions: 3 });
    if (method === 'POST' && path === '/memory/rollback') {
      const v = state.versions.find(x => x.version === body.version);
      if (!v) return fail(400, 'Unknown strategy version');
      state.versions.push({ version: current().version + 1, profile: v.profile, reason: `Откат к версии ${v.version}`, created: 1.782e9, kind: 'rollback' });
      return ok(current());
    }
    const m = /^\/memory\/observations\/(.+)$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const o = state.observations.find(x => x.id === id);
      if (!o) return fail(404, 'Observation not found');
      if (method === 'PATCH') { o.orig ??= o.text; if (body.text !== undefined) o.text = body.text; if (body.tag !== undefined) o.tag = body.tag; o.status = 'edited'; if (body.text !== undefined && body.text !== o.orig) o.included = false; return ok({ ok: true }); }
      if (method === 'DELETE') { state.observations = state.observations.filter(x => x !== o); return ok({ deleted: true }); }
    }
    return fail(404, 'Not Found');
  };
}
