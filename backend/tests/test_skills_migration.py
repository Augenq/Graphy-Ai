import json

import pytest
from filelock import FileLock
from reference_graphy.learning_tools import LearningTools
from reference_graphy.migration import purge_coding_sessions
from reference_graphy.session import Session
from reference_graphy.skills import Skills


def add_skill(root, name, text):
    path = root / name / 'SKILL.md'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def test_skill_scopes_precedence_folded_metadata_and_live_refresh(tmp_path):
    cwd, root, home = (tmp_path / p for p in ('cwd', 'state', 'home'))
    add_skill(root / 'skills', 'math', '---\nname: math\ndescription: Global\n---\nGlobal instructions')
    local = add_skill(cwd / '.graphy/skills', 'math',
                      '---\nname: math\ndescription: >\n  Local math\n  explanations\n---\nLocal instructions')
    skills = Skills(root, cwd, home=home)
    assert skills.list()[0]['description'] == 'Local math explanations'
    assert skills.load('math')['path'] == str(local)
    assert 'Local instructions' in skills.load('math')['instructions']
    add_skill(home / '.agents/skills', 'new', 'New instructions')
    assert {s['name'] for s in skills.list()} == {'math', 'new'}
    add_skill(root / 'skills', 'oversize', 'x' * 50000)
    assert 'oversize' not in {s['name'] for s in skills.list()}
    assert skills.warnings
    with pytest.raises(ValueError, match='Unknown skill'):
        skills.load('../secret')


async def test_skill_loading_records_metadata_without_executing_scripts(tmp_path):
    session = Session(tmp_path, tmp_path)
    try:
        skill = add_skill(tmp_path / '.graphy/skills', 'math', 'Use examples. Run ./helper.sh if needed.')
        marker = tmp_path / 'ran'
        (skill.parent / 'helper.sh').write_text(f'touch {marker}')
        tools = LearningTools(tmp_path, session)
        result = await tools.execute({'id': 'load', 'name': 'load_skill', 'arguments': {'name': 'math'}})
        assert not result.get('error')
        assert session.learning.skills == [{'name': 'math', 'path': str(skill),
                                           'instructions': 'Use examples. Run ./helper.sh if needed.'}]
        assert not marker.exists()
        tools.enabled.remove('load_skill')
        result = await tools.execute({'id': 'disabled', 'name': 'load_skill', 'arguments': {'name': 'math'}})
        assert result.get('error')
    finally:
        session.close()


def test_migration_only_deletes_unlocked_version_one(tmp_path):
    folder = tmp_path / 'sessions/group'
    folder.mkdir(parents=True)
    def history(name, version):
        path = folder / (name + '.jsonl')
        path.write_text(json.dumps({'type': 'header', 'version': version}) + '\n')
        return path
    old = history('old', 1)
    active = history('active', 1)
    study = history('study', 2)
    unknown = history('unknown', 3)
    outside = tmp_path / 'outside.jsonl'
    outside.write_text(old.read_text())
    (folder / 'link.jsonl').symlink_to(outside)
    with FileLock(str(active) + '.lock'):
        result = purge_coding_sessions(tmp_path)
    assert result['removed'] == 1 and result['skipped']
    assert not old.exists()
    assert all(p.exists() for p in (active, study, unknown, outside))
