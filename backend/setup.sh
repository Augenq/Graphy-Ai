#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd -- "$PROJECT_DIR"

fail() {
    printf 'graphy: %s\n' "$*" >&2
    exit 1
}

# Prefer an existing environment, then a compatible Python from PATH.
PYTHON=""
for candidate in "$PROJECT_DIR/.venv/bin/python" python3.12 python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 &&
        "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 12))' 2>/dev/null; then
        PYTHON="$candidate"
        break
    fi
done
[[ -n "$PYTHON" ]] || fail 'Установите Python 3.12 или новее и повторите запуск.'

if [[ ! -x .venv/bin/python ]] ||
    ! .venv/bin/python -c 'import sys; sys.exit(sys.version_info < (3, 12) or sys.prefix == sys.base_prefix)' 2>/dev/null; then
    # Preserve a broken environment, including one copied from another device.
    if [[ -e .venv || -L .venv ]]; then
        BACKUP="$(mktemp -d "$PROJECT_DIR/.venv-backup.XXXXXXXX")"
        mv -- .venv "$BACKUP/venv"
        printf 'Прежнее окружение сохранено в %s/venv\n' "$BACKUP"
    fi
    printf 'Создаём виртуальное окружение…\n'
    "$PYTHON" -m venv .venv || fail 'Не удалось создать .venv. Проверьте наличие модуля venv для вашего Python.'
fi

# Reinstall after a move or dependency changes, and retry any incomplete installation.
STAMP=.venv/.graphy-install
FINGERPRINT="$(.venv/bin/python - <<'PY'
import hashlib
import sys
from pathlib import Path

digest = hashlib.sha256()
digest.update(str(Path.cwd()).encode())
digest.update(sys.version.encode())
for name in ("pyproject.toml", "requirements.lock", "setup.sh", "hatch_build.py", "rust/Cargo.toml", "rust/Cargo.lock"):
    digest.update(Path(name).read_bytes())
for source in sorted(p for p in Path("rust/src").rglob("*") if p.suffix in (".rs", ".json")):
    digest.update(source.read_bytes())
print(digest.hexdigest())
PY
)"
if [[ ! -f "$STAMP" ]] || [[ "$(cat "$STAMP")" != "$FINGERPRINT" ]] ||
    ! .venv/bin/python -c 'from graphy.native import invoke; assert invoke("health")["engine"] == "rust"' 2>/dev/null; then
    if ! .venv/bin/python -m pip --version >/dev/null 2>&1; then
        .venv/bin/python -m ensurepip --upgrade
    fi
    printf 'Устанавливаем зависимости…\n'
    .venv/bin/python -m pip install -e . -c requirements.lock
    printf '%s\n' "$FINGERPRINT" > "$STAMP"
fi

printf '\nОкружение готово. Обычно агента запускает приложение (npm run dev / npm run web в корне проекта).\n'
printf 'Только сервер, без интерфейса:\n\n'
printf '  .venv/bin/python -m graphy serve\n'
