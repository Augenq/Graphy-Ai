"""Progressively load local SKILL.md instructions without executing their scripts."""

import json
import re
from pathlib import Path

NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
MAX_SKILL_BYTES = 48 * 1024


def metadata(text):
    """Read conventional scalar/folded name/description frontmatter, not arbitrary YAML."""
    result: dict[str, str] = {}
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return result
    key = None
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if line[:1].isspace() and key:
            result[key] = (result[key] + " " + line.strip()).strip()
            continue
        match = re.match(r"^(name|description):\s*(.*)$", line)
        key = None
        if match:
            key, value = match.groups()
            value = value.strip()
            if value in ("|", ">", "|-", ">-"):
                value = ""
            elif value.startswith('"'):
                try:
                    value = json.loads(value)
                except ValueError:
                    pass
            elif len(value) >= 2 and value[0] == value[-1] == "'":
                value = value[1:-1].replace("''", "'")
            if isinstance(value, str):
                result[key] = value
    return result


class Skills:
    def __init__(self, root, cwd, *, home=None):
        home = Path.home() if home is None else Path(home)
        self.roots = [Path(cwd) / ".graphy" / "skills", Path(cwd) / ".agents" / "skills",
                      Path(root) / "skills", home / ".agents" / "skills"]
        self.warnings: list[str] = []

    def list(self):
        result: dict[str, dict] = {}
        self.warnings = []
        for folder in self.roots:
            for path in sorted(folder.glob("*/SKILL.md")):
                try:
                    if path.stat().st_size > MAX_SKILL_BYTES:
                        raise ValueError("SKILL.md exceeds 48 KiB")
                    text = path.read_text(encoding="utf-8")
                    info = metadata(text)
                    name = info.get("name", path.parent.name)
                    if not NAME.fullmatch(name):
                        raise ValueError("Use a lowercase skill name with letters, digits, - or _")
                    description = info.get("description", "")
                    if not description:
                        description = next((s.strip() for s in text.splitlines()
                                            if s.strip() and not s.startswith(("#", "---"))), name)
                    result.setdefault(name, {"name": name, "description": description[:500],
                                             "path": str(path.resolve())})
                except (OSError, UnicodeError, ValueError) as exc:
                    self.warnings.append(f"{path}: {exc}")
        return list(result.values())

    def load(self, name):
        row = next((item for item in self.list() if item["name"] == name), None)
        if row is None:
            raise ValueError("Unknown skill. Use /skills to list available skills")
        path = Path(row["path"])
        data = path.read_bytes()
        if len(data) > MAX_SKILL_BYTES:
            raise ValueError("SKILL.md exceeds 48 KiB")
        return row | {"base_directory": str(path.parent), "instructions": data.decode("utf-8")}
