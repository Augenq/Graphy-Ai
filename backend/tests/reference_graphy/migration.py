"""Remove obsolete version-1 coding histories while preserving learning data."""

import json

from filelock import FileLock, Timeout


def purge_coding_sessions(root):
    folder = root / "sessions"
    removed = 0
    skipped: list[dict[str, str]] = []
    if folder.is_symlink() or not folder.exists():
        return {"removed": removed, "skipped": skipped}
    for group in folder.iterdir():
        if group.is_symlink() or not group.is_dir():
            continue
        for path in group.glob("*.jsonl"):
            if path.is_symlink():
                continue
            lock = FileLock(str(path) + ".lock")
            try:
                with lock.acquire(timeout=0):
                    with path.open(encoding="utf-8") as source:
                        header = json.loads(source.readline())
                    if not isinstance(header, dict) or header.get("type") != "header" or header.get("version") != 1:
                        continue
                    path.unlink()
                    for tail in path.parent.glob(path.stem + ".damaged-*"):
                        if not tail.is_symlink():
                            tail.unlink()
                    removed += 1
            except (OSError, ValueError, Timeout) as exc:
                skipped.append({"path": str(path), "reason": str(exc)})
        # Empty lock files are harmless; do not unlink locks other processes may use.
    return {"removed": removed, "skipped": skipped}
