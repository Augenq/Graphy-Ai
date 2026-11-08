"""Small atomic stores. Secrets never enter session files."""

import json
import os
import re
import tempfile
from pathlib import Path

from filelock import FileLock


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".graphy-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, type(default)):
            raise ValueError("unexpected data type")
        return value
    except (ValueError, OSError) as exc:
        raise ValueError(
            f"Cannot read {path.name}; correct or rename this file. Sessions are intact."
        ) from exc


def default_root() -> Path:
    """GRAPHY_DIR or ~/.graphy; a data directory left by the former name (~/.pipy) is moved there once."""
    if os.environ.get("GRAPHY_DIR"):
        return Path(os.environ["GRAPHY_DIR"])
    new, old = Path.home() / ".graphy", Path.home() / ".pipy"
    if not new.exists() and old.is_dir():
        old.rename(new)
    return new


class Store:
    def __init__(self, root: Path | None = None):
        self.root = root or default_root()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.prefs = read_json(self.root / "settings.json", {})
        self.secrets = read_json(self.root / "auth.json", {})

    def save(self):
        write_json(self.root / "settings.json", self.prefs)

    def credential(self, provider: str) -> dict:
        # Read again so a second process refreshing Codex cannot leave us with stale tokens.
        self.secrets = read_json(self.root / "auth.json", {})
        return self.secrets.get(provider, {})

    def set_credential(self, provider: str, credential: dict | None):
        with FileLock(str(self.root / "auth.lock")):
            values = read_json(self.root / "auth.json", {})
            if credential is None:
                values.pop(provider, None)
            else:
                values[provider] = credential
            write_json(self.root / "auth.json", values)
            self.secrets = values

    def redact(self, text: str) -> str:
        def strings(value):
            if isinstance(value, dict):
                for item in value.values():
                    yield from strings(item)
            elif isinstance(value, str) and len(value) > 6:
                yield value

        for secret in strings(self.secrets):
            text = text.replace(secret, "[redacted]")
        return re.sub(r"(?i)(bearer\s+)[\w.\-]+", r"\1[redacted]", text)
