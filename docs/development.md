# Разработка

## Требования

Node.js 22+, Rust 1.89+ (cargo), Python 3.12+, Docker. Для локального запуска без Docker также нужны `pandoc`, `tesseract`, `xelatex` — они используются инструментами агента.

## Запуск из исходников

```bash
npm run setup      # окружение Python, зависимости сайта, сборка Rust-ядра
npm run dev        # агент + сайт с горячей перезагрузкой, http://localhost:5174
npm run web        # то же в Docker-песочнице (нужен собранный образ)
npm run build      # production-сборка сайта
```

Только агент (без сайта): `.venv/bin/python -m graphy serve --allow-origin http://localhost:5174`. Описание API: [backend/docs/protocol.md](../backend/docs/protocol.md).

## Сборка Docker-образа

```bash
./scripts/docker-build.sh            # Rust-ядро в rust:bookworm → сайт → docker build → graphy:latest
SKIP_RUST=1 ./scripts/docker-build.sh   # использовать уже собранное ядро
SKIP_WEB=1  ./scripts/docker-build.sh   # использовать уже собранный сайт
docker save graphy:latest | gzip > graphy-image.tar.gz    # экспорт образа
```

Ядро нельзя собирать на хосте с более новой glibc, чем в образе: библиотека не загрузится (`GLIBC_x.y not found`). Поэтому скрипт собирает его в контейнере, а `docker build` без скрипта делает то же в первом этапе `Dockerfile`.

## Тесты

```bash
cd backend/rust && cargo test --locked          # ядро: агент, провайдеры, журнал, веб-инструменты
node --test scripts/                            # хаб, школа, вход MAX, прокси
cd frontend && npm run typecheck                # типы сайта
cd backend && python -m pytest -q               # контрактные тесты промптов и API
```

Сквозной сценарий «Школы» в браузере (Playwright): [scripts/e2e-school/README.md](../scripts/e2e-school/README.md).

## Структура репозитория

```text
backend/rust/      ядро: агент, инструменты, провайдеры, состояние, HTTP-сервер
backend/graphy/    запускатель на Python, промпты (prompts/), схемы и навыки (resources/)
frontend/          сайт: React + TypeScript + Vite
scripts/           веб-сервер, хаб MAX, школа, сборка образа, e2e-сценарии
stt/               сервис распознавания речи
searxng/           настройки метапоиска
docs/              документация и скриншоты
Dockerfile, docker-compose.yml, docker-entrypoint.sh, requirements.txt
```

## Правила

- Промпты и инструкции агента на английском, интерфейс и документация на русском.
- Новые зависимости Python добавляйте в `requirements.txt` с точной версией.
- Секреты не коммитятся: `.env` в `.gitignore`, шаблон — `.env.example`.
