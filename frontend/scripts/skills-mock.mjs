// In-memory fixture of the skills library API (backend/docs/protocol.md). Mirrors the backend rules that
// matter to the UI: unique ids, 409 on conflicts, disabled skills stay listed, catalog drift.
export function createSkillsMock() {
  const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
  const hash = text => { let h = 5381; for (const c of text) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0; return h.toString(16).padStart(8, '0'); };
  const md = (name, description, body, tags = []) => `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n${tags.length ? `tags: ${tags.join(', ')}\n` : ''}---\n\n${body}\n`;
  const files = {
    'socratic-tutor': { content: md('socratic-tutor', 'Ведёт ученика наводящими вопросами и не даёт готовых ответов.', 'Задавай по одному вопросу.', ['диалог']), enabled: true, source: 'user' },
    'exam-drill': { content: md('exam-drill', 'Тренировка к экзамену: серия коротких задач с разбором ошибок.', 'Дай 5 задач по теме.', ['экзамен', 'практика']), enabled: false, source: 'user' },
    'example-flashcards': { content: md('example-flashcards', 'ПРИМЕР. Превращает конспект в карточки.', 'Составь карточки.', ['пример']), enabled: true, source: 'catalog', installed: { version: '1.0.0', sha: null } },
  };
  files['example-flashcards'].installed.sha = hash(files['example-flashcards'].content);
  files['example-flashcards'].content = files['example-flashcards'].content.replace('Составь карточки.', 'Составь карточки. (моя правка)');
  files['ext-notes'] = { content: md('ext-notes', 'Навык из .agents/skills (только чтение).', 'Внешний.'), enabled: true, source: 'external', external: true };
  const catalog = [
    { id: 'example-flashcards', title: 'Пример: Карточки для повторения', description: 'ПРИМЕР. Превращает конспект в карточки.', version: '1.1.0', tags: ['пример'], example: true, sha256: 'x' },
    { id: 'example-socratic-tutor', title: 'Пример: Сократовский наставник', description: 'ПРИМЕР. Ведёт ученика вопросами вместо готовых ответов.', version: '1.0.0', tags: ['пример', 'диалог'], example: true, sha256: 'y' },
    { id: 'socratic-tutor', title: 'Сократовский наставник (чужой)', description: 'Имя занято вашим навыком.', version: '1.0.0', tags: [], sha256: 'z' },
  ];
  const meta = text => {
    const f = k => { const m = new RegExp(`^${k}: (.*)$`, 'm').exec(text); if (!m) return ''; try { return JSON.parse(m[1]); } catch { return m[1]; } };
    return { name: f('name'), description: f('description'), tags: f('tags').split(',').map(x => x.trim()).filter(Boolean) };
  };
  const row = id => {
    const f = files[id], m = meta(f.content);
    const entry = catalog.find(c => c.id === id);
    return { id, name: id, description: m.description, tags: m.tags, source: f.source, path: f.external ? `/fixture/.agents/skills/${id}/SKILL.md` : `/fixture/.graphy/skills/${id}/SKILL.md`, enabled: f.enabled,
      hash: hash(f.content), modified: !!f.installed && hash(f.content) !== f.installed.sha, size: f.content.length, updated: 1.7e9, editable: !f.external, warnings: [],
      ...(f.installed ? { catalog: { id, installed_version: f.installed.version, latest_version: entry?.version ?? '', update_available: !!entry && entry.version !== f.installed.version } } : {}) };
  };
  const fail = (status, code, message) => ({ status, body: { error: { code, message } } });
  const ok = (body, status = 200) => ({ status, body });
  const create = content => {
    const m = meta(content);
    if (!/^---\n[\s\S]*\n---/.test(content)) return fail(400, 'invalid', 'SKILL.md must start with a --- frontmatter block');
    if (!NAME.test(m.name)) return fail(400, 'invalid', 'Frontmatter name must be lowercase letters, digits, - or _ (max 64)');
    if (!m.description) return fail(400, 'invalid', 'Frontmatter description is required');
    if (files[m.name]) return fail(409, 'conflict', `Skill '${m.name}' already exists`);
    files[m.name] = { content, enabled: true, source: 'user' };
    return ok(row(m.name), 201);
  };
  return function handle(method, path, body) {
    if (!path.startsWith('/skills')) return null;
    const seg = path.split('/').slice(2).map(decodeURIComponent);
    const [a, b, c] = seg;
    if (method === 'GET' && a === 'project' && window.__oldSkillsBackend) return fail(404, 'not_found', 'Unknown skill');
    if (method === 'GET' && a === 'project') return ok({ skills: ['socratic-tutor', 'exam-drill'].map(id => ({ name: id, description: meta(files[id].content).description, path: `/fixture/.graphy/skills/${id}/SKILL.md` })), warnings: [] });
    if (method === 'GET' && a === 'library') return ok({ skills: Object.keys(files).map(row), warnings: [] });
    if (method === 'GET' && a === 'catalog') return ok({ warnings: [], skills: catalog.map(e => {
      const f = files[e.id], mine = f?.installed;
      return { ...e, installed: !!mine, installed_version: mine?.version ?? '', update_available: !!mine && mine.version !== e.version,
        modified: !!mine && hash(f.content) !== mine.sha, conflict: !!f && !mine };
    }) });
    if (method === 'POST' && a === 'catalog' && c === 'install') {
      const e = catalog.find(x => x.id === b);
      if (!e) return fail(404, 'not_found', 'Unknown catalog skill');
      const f = files[b];
      if (f && !f.installed) return fail(409, 'conflict', 'A skill with this name already exists');
      if (f && hash(f.content) !== f.installed.sha && !body?.force) return fail(409, 'conflict', 'skill_modified');
      const content = md(b, e.description, `Версия ${e.version}.`, e.tags);
      files[b] = { content, enabled: f?.enabled ?? true, source: 'catalog', installed: { version: e.version, sha: hash(content) } };
      return ok(row(b), 201);
    }
    if (method === 'POST' && !a) return create(md(body.name, body.description, body.body, body.tags ?? []));
    if (method === 'POST' && a === 'import') {
      if (body.path) return fail(400, 'invalid', 'SKILL.md not found at this path');
      return create(body.content);
    }
    if (!files[a]) return fail(404, 'not_found', 'Unknown skill');
    if (method === 'GET' && !b) return ok({ ...row(a), content: files[a].content });
    if (method === 'PUT' && !b) {
      if (body.expected_hash && body.expected_hash !== hash(files[a].content)) return fail(409, 'conflict', 'The skill changed on disk since you opened it');
      if (meta(body.content).name !== a) return fail(400, 'invalid', `Frontmatter name must match the skill id '${a}'`);
      files[a].content = body.content;
      return ok(row(a));
    }
    if (method === 'DELETE' && !b) { delete files[a]; return ok({ deleted: true, id: a }); }
    if (method === 'PUT' && b === 'enabled' && a === 'exam-drill' && body.enabled === false) return fail(500, 'storage_error', 'Не удалось сохранить');
    if (method === 'PUT' && b === 'enabled') { files[a].enabled = !!body.enabled; return ok(row(a)); }
    if (method === 'POST' && b === 'duplicate') {
      let id = `${a}-copy`;
      for (let n = 2; files[id]; n++) id = `${a}-copy-${n}`;
      files[id] = { content: files[a].content.replace(`name: ${a}`, `name: ${id}`), enabled: true, source: 'user' };
      return ok(row(id), 201);
    }
    return null;
  };
}
