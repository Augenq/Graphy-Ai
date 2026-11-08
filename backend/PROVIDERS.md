# Провайдеры и модели

Реализованы девять подключений по API-ключу и отдельный **Codex через ChatGPT OAuth**. GitHub Copilot исключён из этой версии. Это набор выбранных популярных сервисов; место в рейтинге популярности не утверждается.

## Сервис Graphy (по умолчанию)

Провайдер `graphy` работает без настройки: агент создаёт анонимный токен установки и шлёт запросы на сервер проекта (`GRAPHY_SERVICE_URL`, по умолчанию `https://78-17-61-24.sslip.io:8443/llm`), а тот пересылает их в OpenRouter с ключом сервера. Доступны три модели под режимами «Быстрый», «Сбалансированный», «Глубокий». Сервер ограничивает расход (на токен, IP и в сутки всего). `GRAPHY_SERVICE_URL=off` отключает сервис, тогда нужен свой ключ ниже. Выбор провайдеров в интерфейсе скрыт: остальное настраивается переменными окружения и `settings.json`.

## Встроенные подключения

| ID провайдера | Сервис | API | Переменная ключа |
|---|---|---|---|
| `openai` | OpenAI API | Responses | `OPENAI_API_KEY` |
| `openai-codex` | ChatGPT / Codex | Codex Responses, HTTP/SSE | вход через браузер (интерфейс скрыт) |
| `anthropic` | Anthropic Claude | Messages | `ANTHROPIC_API_KEY` |
| `google` | Google Gemini | Generative AI | `GEMINI_API_KEY` |
| `deepseek` | DeepSeek | Chat Completions | `DEEPSEEK_API_KEY` |
| `openrouter` | OpenRouter | Chat Completions | `OPENROUTER_API_KEY` |
| `xai` | xAI Grok | Responses | `XAI_API_KEY` |
| `mistral` | Mistral | Chat Completions | `MISTRAL_API_KEY` |
| `groq` | Groq | Chat Completions | `GROQ_API_KEY` |
| `together` | Together AI | Chat Completions | `TOGETHER_API_KEY` |

Ключ можно задать переменной окружения или в `auth.json`; переменная окружения имеет приоритет над сохранённым ключом. Codex не принимает API-ключ вместо OAuth: Browser PKCE с callback/ручным redirect и Device code реализованы в Rust, refresh выполняется перед запросом с блокировкой между процессами. Доступные модели и лимиты определяются аккаунтом сервиса.

Streaming, tool calls, usage и доступные блоки reasoning преобразуются в общий формат. При смене провайдера неподходящие native/signature-блоки не отправляются новому API; исходная история сохраняется. Поддержка изображения, инструментов и уровней reasoning определяется конкретной моделью, а не только сервисом.

## Произвольный совместимый API

Свой совместимый сервер задаётся в `settings.json` (`providers`): имя, API, базовый URL и необязательный ключ. Доступны `chat`, `responses`, `anthropic`, `google`. URL должен содержать нужную часть `/v1` или `/v1beta`; не указывайте конечный путь `/chat/completions`. Ключи передавайте отдельно от URL. Обнаружение моделей выполняется через `/models`, если сервер его предоставляет; иначе укажите ID модели вручную.

Один пример `~/.graphy/settings.json` для уже запущенного совместимого локального сервера:

```json
{
  "default_model": "my-local/owner/model",
  "providers": {
    "my-local": {
      "api": "chat",
      "base_url": "http://127.0.0.1:8000/v1",
      "api_key_env": "MY_LOCAL_API_KEY",
      "models": [
        {
          "id": "owner/model",
          "context": 32768,
          "max_output": 4096,
          "vision": false,
          "tools": true,
          "reasoning": false,
          "thinking_levels": ["off"],
          "cost": null,
          "sampling": {"temperature": 0.2}
        }
      ]
    }
  }
}
```

Ключ необязателен; без `MY_LOCAL_API_KEY` и сохранённого ключа запрос пойдёт без авторизации. Для редактирования JSON завершите приложение и сохраните остальные существующие настройки. При `GRAPHY_DIR` файл находится в указанном каталоге.

`context` и `max_output` — положительные целые; `vision`, `tools`, `reasoning` — boolean. `thinking_levels` — непустой список поддерживаемых значений из `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Одного объявления недостаточно: endpoint и модель должны поддерживать соответствующие поля протокола. `sampling` допускает поддерживаемые адаптером параметры; не каждый сервис принимает все варианты.

В `/settings → Model metadata` можно изменить `context`, `max_output`, `vision`, `tools`, `reasoning`, `thinking_levels`, `sampling`, `cost` текущей модели. `cost` задаётся в USD за миллион токенов, например `{"input": 1, "output": 2, "cache_read": 0.1}`. `null` означает неизвестную цену; для бесплатного endpoint задайте нулевые ставки явно.

`/settings → Custom provider HTTP headers` сохраняет словарь строк в приватном `auth.json`. Такой способ подходит для заголовков с секретами. Настройки `providers.<name>.headers` также поддерживаются, но находятся в обычном `settings.json`. Для встроенного провайдера можно переопределить `api` и `base_url`; для другой переменной ключа задайте `env`.

## Локальные серверы

| ID | URL по умолчанию | Протокол |
|---|---|---|
| `ollama` | `http://localhost:11434/v1` | Chat Completions |
| `lmstudio` | `http://localhost:1234/v1` | Chat Completions |
| `llama.cpp` | `http://localhost:8080/v1` | Chat Completions; отдельное управление router API |
| `vllm` | `http://localhost:8000/v1` | Chat Completions |
| `sglang` | `http://localhost:30000/v1` | Chat Completions |
| `localai` | `http://localhost:8080/v1` | Chat Completions |

Все URL изменяемы, включая LAN. Список серверов не ограничен этими пресетами: остальные подключаются как произвольные совместимые endpoints. Произвольный нестандартный протокол автоматически не становится совместимым.

Inference-сервер запускается отдельно. Для агентного цикла нужны tool calls, корректный chat template и достаточный контекст; текст, похожий на команду, сам по себе не исполняется. Для неизвестного ID используются консервативные исходные metadata: 32768 контекста, 4096 выхода, vision выключен, reasoning выключен. Уточните реальные характеристики через `/settings`.

Rust runtime поддерживает текущий каталог и состояния роутера, load/unload, поиск GGUF в Hugging Face, quantization и скачивание силами сервера. Перед загрузкой при наличии других моделей можно сохранить их или явно выгрузить. Прогресс поступает через `/models/sse` и polling; успешность сверяется по `/models`. Отмена load/download использует `/models/unload`; отсутствие подтверждённого состояния показывается явно. Сбой не вызывает автоматический повтор изменяющего запроса. Обнаружение учитывает autoload, loaded/sleeping, контекст и vision роутера; decision-only модели не предлагаются как чат. Требуется совместимая версия router API; обычный `/v1/models` одиночного сервера не заменяет роутер.

## Каталог, кеш и стоимость

Встроенный snapshot выбранных моделей взят из [models.dev](https://github.com/anomalyco/models.dev), коммит `1dfa7fe16479961030f1a8f056d2c0d4afe9bc49`, 17 октября 2026. Источник и MIT notice сохранены в [NOTICE](NOTICE). Snapshot — исходные metadata, не подтверждение доступности модели вашему аккаунту.

`POST /models/refresh` обновляет и кеширует обнаруженный каталог. Ручной ID работает и без discovery. Обновление списка не гарантирует актуальность всех характеристик: часть APIs возвращает только ID. При необходимости переопределите metadata. Выбор и чтение локального кеша не выполняют фоновых LLM-запросов.

Usage берётся из ответа провайдера. Контекст оценивается приблизительно; стоимость рассчитывается по известным ставкам и может отличаться от счёта. Неполные тарифы и Codex-подписка обозначаются неизвестной стоимостью, а не нулём. Для Anthropic передаются cache hints, Responses получает устойчивый cache key сессии; другие API используют доступное обычное кеширование. Прогрев кеша отсутствует.

## Проверки

Rust unit- и HTTP-тесты запускаются командой `cargo test --locked --manifest-path rust/Cargo.toml` из `backend/`. Исторические Python-тесты и `tests/reference_graphy` служат отдельным оракулом прежнего поведения и не вызываются Rust в работающем приложении. Автоматические тесты с тестовым HTTP не подтверждают особенности каждого реального сервиса; доступность и возможности модели зависят от провайдера и аккаунта.
