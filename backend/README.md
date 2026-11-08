# Backend: агент Graphy

Агент написан на Rust (`rust/`). Python (`graphy/`) — тонкий запускатель: загружает Rust-библиотеку и передаёт ей управление; других runtime-зависимостей у него нет. Общая схема: [../docs/architecture.md](../docs/architecture.md).

## Запуск

```bash
./setup.sh                # Windows: .\setup.bat; создаёт .venv и собирает ядро
.venv/bin/python -m graphy serve --allow-origin http://localhost:5174
```

Сервер слушает только loopback и печатает одну JSON-строку с адресом и токеном. Токен можно задать заранее переменной `GRAPHY_TOKEN`. Протокол: [docs/protocol.md](docs/protocol.md).

Сборка ядра вручную: `python scripts/build_native.py` (нужен Rust 1.89+). Ядро должно быть собрано в той же среде, где оно запускается (версия glibc).

## Что внутри

| Путь | Назначение |
|---|---|
| `rust/src/backend_runtime.rs` | HTTP-сервер `/api/v1`, события SSE, проверка токена, Host и Origin |
| `rust/src/runtime_agent.rs`, `runtime_tools.rs` | цикл «модель ↔ инструменты» и сами инструменты |
| `rust/src/provider_runtime/` | провайдеры моделей, потоковые ответы, каталог, веб-поиск и чтение страниц |
| `rust/src/state_runtime/` | журнал занятий, формы вопросов, память, прогресс, календарь, навыки |
| `rust/src/researcher.rs` | субагент-исследователь |
| `graphy/prompts/` | инструкции режимов и стилей (на английском) |
| `graphy/resources/` | схемы инструментов и вопросов, навыки, каталог моделей |
| `tests/` | контрактные тесты на Python |

## Данные

Всё хранится в `GRAPHY_DIR` (по умолчанию `~/.graphy`): `settings.json`, `auth.json`, `models.json`, `learning/` (журналы занятий в JSONL, память, прогресс). Записи защищены блокировками; повреждённый хвост журнала восстанавливается по целым событиям.

## Провайдеры и навыки

Провайдеры, ключи и локальные серверы: [PROVIDERS.md](PROVIDERS.md). Свои навыки — каталоги с `SKILL.md` в `GRAPHY_DIR/skills/` или в проекте; встроенный навык `graphy-document-style` задаёт оформление документов.

## Проверки

```bash
cd rust && cargo test --locked        # основные тесты
python -m pytest -q tests             # контрактные тесты
```
