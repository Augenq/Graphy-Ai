# Локальный API graphy (протокол v1)

`graphy serve` поднимает HTTP-сервер для графических клиентов (например, `frontend/` этого проекта).
Данные лежат в `~/.graphy` (или `$GRAPHY_DIR`). Один чат может быть открыт только в одном процессе.

## Запуск

```bash
.venv/bin/python -m graphy serve [--port 0] [--allow-origin ORIGIN]... [--cwd DIR] [--exit-on-stdin-close]
```

После старта в stdout печатается одна JSON-строка; клиент читает из неё адрес и токен:

```json
{"type": "ready", "url": "http://127.0.0.1:41823", "token": "…", "protocol": 1, "version": "0.3.0", "pid": 1234}
```

| Параметр | Смысл |
|---|---|
| `--port` | `0` — свободный порт (по умолчанию) |
| `--allow-origin` | источник веб-клиента, например `http://localhost:5174`; можно несколько; `null` — страница из `file://`. Также `GRAPHY_ALLOWED_ORIGINS` через запятую |
| `--cwd` | каталог для относительных путей материалов (`@файл`) |
| `--exit-on-stdin-close` | завершиться, когда родитель закроет stdin (Electron упал или закрыт) |
| `GRAPHY_TOKEN` | задать токен заранее (иначе случайный) |

Сервер слушает **только** loopback. Это не заменяет авторизацию: любая открытая в браузере страница может
обратиться к localhost, поэтому каждый запрос проверяется:

1. заголовок `Host` — только `127.0.0.1`, `localhost`, `::1` (защита от DNS rebinding), иначе `403 bad_host`;
2. заголовок `Origin`, если есть, — только из разрешённых, иначе `403 bad_origin`; для них отдаются CORS-заголовки;
3. `Authorization: Bearer <token>` — иначе `401 unauthorized`. Для потока событий допустим `?token=`
   (у `EventSource` нет заголовков). Без токена доступен только `GET /api/v1/health` (ответ дополнительно содержит `"engine": "rust"`);
4. тело записывающих запросов — `application/json` (иначе `415`), что заставляет браузер делать preflight.

## Формат

Все пути начинаются с `/api/v1`. Тела и ответы — JSON. Ошибка:

```json
{"error": {"code": "question_open", "message": "Сначала отправьте или отмените открытый блок вопросов."}}
```

Коды: `invalid` (400, сообщение объясняет причину), `unauthorized`, `bad_host`, `bad_origin`, `unknown_session`,
`unknown_provider`, `unknown_flow` (404), `busy`, `question_open`, `session_locked`, `bad_session`,
`login_in_progress`, `no_prompt` (409), `discovery_failed` (502), `storage_error`, `internal` (500).

Команды, запускающие работу агента (`messages`, `skill`, `compact`, `questions/…/submit|cancel`), отвечают
`202` сразу; ход идёт в фоне, результат приходит событиями.

## События

`GET /events` — поток Server-Sent Events, один на клиента, для всех чатов. Каждое событие:

```
id: 412
data: {"seq": 412, "time": 1790000000.1, "type": "text_delta", "session_id": "20261030-101500-ab12cd34", …}
```

`seq` растёт на единицу в пределах процесса. Первое событие — `hello` с текущим `seq`. Каждая запись
`GET /sessions/{id}` содержит `seq` на момент снимка: события с `seq` не больше него уже учтены в снимке.
Порядок надёжной синхронизации: открыть поток → получить снимок → применять события с большим `seq`.
Если клиент не успевает читать, приходит `lagged` и поток закрывается: переподключитесь и запросите снимки заново.
Каждые 15 секунд — комментарий `: ping`.

**Потоковый вывод.** Токены передаются по мере поступления от провайдера: ничего не накапливается и не
сжимается, события, ждущие в очереди, уходят одной записью. Клиент складывает `text_delta` и
`thinking_delta` в сообщение с `message_id`.

События чата (`session_id` есть всегда):

| `type` | Поля | Смысл |
|---|---|---|
| `busy` | `busy`, `needs_continuation?` | чат начал / закончил операцию |
| `message` | `message` | новое сообщение (пользователь, ассистент — ещё пустое, результат инструмента) |
| `text_delta` / `thinking_delta` | `message_id`, `delta` | очередной кусок ответа / рассуждения |
| `message_end` | `message` | итоговое сообщение ассистента: `calls`, `stop`, `usage` |
| `message_discarded` | `message_id` | пустой ответ модели, будет повтор |
| `tool_start` / `tool_update` / `tool_end` | `call` / `call_id`, `text` / `call`, `result` | выполнение инструмента |
| `question_opened` | `block` | открыт тест (без ключей) |
| `question_resolved` | `batch_id`, `status` | тест отправлен или отменён |
| `learning` | `learning` | проекция плана, фазы и оценок |
| `context` | `context` | `{used, limit, percent}` |
| `usage` | `usage` | итоги токенов и стоимости чата (как `usage` в снимке), после каждого хода |
| `status` | `text` | текущая активность («Повтор 1/3…», пусто — нет) |
| `notice` | `text`, `error`, `code?`, `can_retry?` | сообщение пользователю (ошибка провайдера уже без секретов); при `error` — типизированная причина `code` (`stalled`, `rate_limit`, `auth`, `network`, `context`, `model`, `empty`, `error`) и `can_retry` (ответ на последнее сообщение ещё не начался) |
| `stalled` | `phase` (`model`/`tool`), `seconds`, `aborted` | нет событий дольше `stall_timeout_s` (настройки, по умолчанию 120, `0` — выключено). `aborted:false` — предупреждение (можно подождать или остановить), `aborted:true` — запуск остановлен, написанное сохранено |
| `stall_cleared` | — | после предупреждения активность вернулась |
| `queued` | `followup`, `text` | сообщение поставлено в очередь (steering / follow-up) |
| `queue_restored` | `text` | очередь не запустилась (стоп/ошибка): текст вернуть в поле ввода |
| `session_created` / `session_updated` / `session_closed` / `session_deleted` | `session` / `session_id` | жизненный цикл чата |

Глобальные (без `session_id`): `providers_changed`, `settings_changed`,
`login` (`flow_id`, `state`: `starting` · `running` · `waiting_input` · `done` · `cancelled` · `error`;
`url`, `user_code`, `prompt`, `message`).

## Сообщения

```
user:      {id, role, content, attachments?: [{name, path, kind: file|image, size}], images?: n, at}
assistant: {id, role, content, thinking, calls: [{id, name, arguments}], stop, provider, model, usage?, at}
tool:      {id, role, call_id, name, content, error?, images?, ui?, at}
```

* `content` пользователя — исходный текст; содержимое прикреплённых файлов уходит модели, но здесь не дублируется.
* `stop`: `stop`, `tool_calls`, `length`, `error`, `aborted`, `empty`. Сообщения с `empty` и без текста, рассуждений
  и вызовов клиент скрывает.
* У результатов обучающих инструментов есть `ui` — список записей, одинаково для живого потока и истории:
  `{"kind":"plan","goal","steps":[title]}`, `{"kind":"phase","phase","step"}`,
  `{"kind":"assessment","items":[{id,question,outcome,feedback,used_hints}]}`, `{"kind":"finished","summary","next_step"}`.
  `outcome`: `independent` · `with_hints` · `gap` · `uncertain` · `skipped`.
* Ключи тестов (`correct`, `rubric`, `grading`) и вердикты по ответам **никогда** не передаются: ни в `question_opened`,
  ни в аргументах вызова `ask_questions`, ни в его результате (остаются `status` и `answers`).

## Снимок чата

`GET /sessions/{id}` (открывает чат и блокирует его файл; `409 session_locked`, если он открыт другим процессом):

```
{id, name, created, said, busy, model, thinking, seq,
 messages: [...], learning: {goal, phase, phase_label, steps:[{id,title}], current_step, current_index,
   finished, summary, next_step, assessments:[…]},
 question: {batch_id, title, purpose, questions:[{id,type,prompt,options?:[{id,label}],allow_custom_answer?,topic_id?}],
   answers:[{question_id,status,selected_option_ids,text,reasoning}], step} | null,
 resolved_questions: {batch_id: {block, status, answers, message_id}},
 context, usage, activity, needs_continuation, warning, queued}
```

`needs_continuation` — ход прерван (ошибка, остановка, перезапуск): предложите пользователю написать «продолжай»,
повторной записи ответов не будет.

## Команды

Курсы и чаты

| Запрос | Тело → ответ |
|---|---|
| `GET /bootstrap` | всё для старта: `models`, `ready` (есть ли доступная модель), `settings`, `providers`, `seq` |
| `GET /sessions?include_empty=1` | список (пустые скрыты, пока не открыты) |
| `POST /sessions` | `{model?, thinking?, explanation_style?}` → снимок (201); курсов нет, лишнее поле `course_id` игнорируется; чаты старых курсов остаются в списке и открываются |
| `GET /sessions/{id}` | снимок |
| `PATCH /sessions/{id}` | `{name}` |
| `DELETE /sessions/{id}` | удалить чат навсегда (409, пока он работает или открыт другим процессом) |
| `POST /sessions/{id}/close` | освободить файл чата (нельзя при работе) |
| `POST /sessions/{id}/messages` | `{text, followup?, paths?: [путь], retry?}` (`retry` повторяет последнее ответом не начатое сообщение без дубля; иначе 409 `retry_not_allowed`) → `{started}` или `{queued, followup}` |
| `POST /sessions/{id}/abort` | `{aborted}` |
| `POST /sessions/{id}/stall/wait` | `{waiting}`; продлевает ожидание после `stalled`; 409 `not_running` |
| `POST /sessions/{id}/queue/edit` | тело `{followup,index,text?}`; без `text` — удалить элемент очереди; 409 `queue_item_gone`, если он уже ушёл |
| `POST /sessions/{id}/restore` | `{text}` — забрать неотправленную очередь |
| `POST /sessions/{id}/compact` | `{instructions?}` |
| `POST /sessions/{id}/skill` | `{name, request?}` |
| `PUT /sessions/{id}/model` | `{model: "provider/id", thinking?, make_default?}` |

Если во время работы приходит сообщение, оно ставится в очередь (`followup: false` — steering, `true` — после ответа).
При открытом тесте сообщения отвергаются (`409 question_open`).

Тесты

| Запрос | Тело |
|---|---|
| `PUT /sessions/{id}/questions/{batch}/draft` | `{answers, step}` — черновик (пишется на диск) |
| `POST /sessions/{id}/questions/{batch}/submit` | `{answers}` — каждый вопрос: `answered`, `skipped` или `dont_know` |
| `POST /sessions/{id}/questions/{batch}/cancel` | `{}` |

Модели, провайдеры, настройки

| Запрос | Смысл |
|---|---|
| `GET /models`, `POST /models/refresh {provider}` | доступные модели: `{id, provider, name, context, vision, tools, reasoning, thinking_levels, cost, metadata_estimated}` |
| `GET /providers` | `{name, kind: api\|local\|oauth\|custom, api, base_url, key_env, configured, key_source: env\|stored\|"", models}` — ключи не возвращаются |
| `PUT /providers/{name}` | `{key?, base_url?, api?}`; новый провайдер требует `api` и `base_url`. Сохраняет и пробует получить список моделей → `{provider, discovery: {ok, error}, models}` |
| `DELETE /providers/{name}` | удалить сохранённые учётные данные |
| `POST /login/codex` | `{method: browser\|device}` → `{flow_id}`; прогресс событиями `login` |
| `POST /login/{flow}/input`, `DELETE /login/{flow}` | `{value}` — вставленный адрес/код; отмена |
| `GET /settings`, `PATCH /settings` | `skills_enabled`, `auto_compact`, `block_images`, `default_model`, `default_thinking`, `web_provider`, `tools` |
| `PUT /settings/web-key` | `{key}` — ключ Brave Search |
| `GET /skills` | `{skills, warnings}` — только включённые навыки, то, что видит агент |

Расход токенов

| Запрос | Ответ |
|---|---|
| `GET /usage?range=7d\|30d\|all` | сводка по журналам занятий на диске (по умолчанию `30d`; другое значение → 400) |

Всё считается локально по событиям `usage` в журналах занятий; ничего не отправляется наружу. Ответ:
`{range, today, from, skipped, totals, days, heatmap, models, sessions}`. Везде одинаковые поля счётчика:
`input`, `output`, `cache_read`, `cache_write`, `tokens` (их сумма), `cost`, `known_cost`, `unknown_cost`, `calls`.
`cost` — сумма только известных стоимостей (указана провайдером или посчитана по прайсу модели, то есть оценка);
вызов без стоимости не оценивается, а ставит `unknown_cost: true` (если `known_cost: false`, стоимость неизвестна совсем).
`totals` дополнительно: `lessons` (занятий с расходом), `cache_hit` (`cache_read / (input + cache_read + cache_write)` или `null`).
`days` — только дни с расходом внутри диапазона `[from, today]` (локальные даты, `YYYY-MM-DD`), каждый с `day` и `lessons`;
`heatmap` — то же за последние 26 недель независимо от `range`. `models` — `{model: "provider/id", …}` (`?` — модель неизвестна);
`sessions` — до 10 занятий `{id, name, …}` по убыванию токенов.
`skipped` — `{files, lines}`: журналы, которые не удалось прочитать, и повреждённые строки `usage`/`model`/`name`/сообщений (они не входят в итоги).
Вызов без токенов и без стоимости не считается и не делает стоимость «неизвестной». Модель вызова берётся из последнего
сообщения ассистента или события `model` выше по журналу, поэтому сжатие истории и генерация названия относятся к модели
занятия на тот момент. Разбор журналов выполняется вне async-потока и кэшируется по файлу (время изменения + размер).

Учёба: банк задач, повторение, календарь

| Запрос | Ответ |
|---|---|
| `GET /study/bank?course_id&topic&outcome&tag&error_type&q&state` | `{items, total, truncated, facets}`; `state`: `active` (по умолчанию), `suspended`, `all`; до 500 задач, новые первыми |
| `GET /study/due` | `{now, total_due, items, topics, upcoming_week}`: что пора освежить (слабое первым) и темы |
| `GET /study/weak-topics` | `{topics:[{topic, course_id, course, due_at, due_count, weak, total}]}` по убыванию числа слабых задач |
| `GET /study/calendar?from&to` | `{today, from, to, days, exam_countdown}`; даты `YYYY-MM-DD`, диапазон до 400 дней (по умолчанию текущий месяц) |
| `GET /study/calendar/ics?from&to` | `{filename, content_type, content}`: iCalendar (события, экзамены, дни повторения; по умолчанию 90 дней вперёд) |
| `POST /study/events` | создать событие `{kind: exam\|session\|note, date, time?, title, course_id?, topic?, note?}` (201) |
| `PATCH /study/events/{id}` / `DELETE /study/events/{id}` | изменить (null убирает необязательное поле) / удалить |
| `PATCH /study/items/{id}` | `{tags?, note?, suspended?, deleted?}`: пометки пользователя |
| `POST /study/review/next` | `{n?, course_id?}` -> `{course_id, count, prompt, items}`: что повторять; `prompt` клиент отправляет первым сообщением нового занятия в курсе `course_id` (пустой, если повторять нечего) |

Задача банка строится из `learning_assessment` в журналах (в том числе внутри `learning_transaction`; `supersedes`
применяется). Одна и та же формулировка в курсе даёт одну задачу с историей попыток. Задача с подсказкой никогда не
считается самостоятельной. Расписание (чистая функция по истории): `independent` поднимает на ступень 1, 3, 7, 16, 35, 70 дней;
`with_hints` не удлиняет интервал (не больше 2 дней, ступень сохраняется); `gap` возвращает на 1 день; `uncertain` и
`skipped` ничего не меняют. Тема «пора», когда пора её самой слабой задаче. Просроченное показывается на сегодня. Пометки
и события пишутся только дописыванием в `learning/study/overlay.jsonl` и `learning/study/events.jsonl`; остальное
пересобирается из журналов. Ничего не отправляется наружу.

Презентация файлов (`present_file`): агент отдаёт ученику готовый документ.
Инструмент `present_file(path, title?)` (объявлен в коде, `backend_runtime/presented.rs`) копирует обычный файл рабочей папки (до 20 МБ)
в снимок `<рабочая папка>/.graphy-presented/<id>/` и возвращает `{ok, file: {id, name, title, mime, size}}`; клиент рисует карточку в ленте
и открывает панель рядом с чатом. Оригинал можно менять и удалять — снимок остаётся.

| Запрос | Ответ |
|---|---|
| `GET /presented/{id}` | байты файла (`Content-Type` по расширению, `nosniff`, `CSP: sandbox`); `id` — 32 hex-символа, иначе `404 not_found`. Только с заголовком `Authorization: Bearer` |

Граф знаний появится отдельной версией протокола.

### Session mode (learn / quiz)

`POST /sessions` accepts optional `mode` (`learn` default, `quiz`), `quiz_kind` (`check`; the removed
`mock_exam` is accepted and treated as `check`) and `deadline` (epoch seconds, quiz only). `PUT /sessions/{id}/mode` takes the same
fields and returns the updated summary; invalid values return 400. `mode`, `quiz_kind` and
`deadline` appear in summaries, snapshots and `session_updated`. Journals without a
`session_mode` event load as `learn`. In quiz mode `prompts/quiz.md` is appended to the system
prompt (no hints or teaching until the report) and `learning_assessment` events carry
`mode: "quiz"`.

### Explanation styles

`POST /sessions` accepts optional `explanation_style` (default `deep_dive`),
`explanation_depth` and `explanation_presentation` (both default `adaptive`).
`PUT /sessions/{id}/style` accepts any subset of these three fields and returns the updated
session summary. Valid IDs: `deep_dive`, `quick_take`, `conversational_mentor`,
`socratic`, `structured_reference`. Depth is `adaptive`, `brief` or `detailed`;
presentation is `adaptive`, `prose` or `structured`. Explicit depth and presentation
replace only the corresponding method-profile defaults; practice difficulty follows
learner evidence independently. A method change preserves depth and presentation;
`adaptive` resets the corresponding override. Invalid values return 400 before saving.
All three fields appear in summaries, snapshots and `session_updated`, and persist
together in one session JSONL event. Older events without preferences load as adaptive.
Changes take effect on the next provider request; an in-flight request is unchanged.

`GET/PATCH /settings` includes boolean `anti_slop_enabled` (default `true`), applied
across all lessons on the next request. Unknown styles and non-boolean values return 400.

### Strategy memory («Память»)

Transparent, editable memory of what worked for the learner. After each graded attempt
(`independent`, `with_hints`, `gap`; `uncertain` and `skipped` are not recorded) the tutor's move
before it (explanation form `analogy|worked_example|formal|visual|socratic|plain` by keyword rules,
style, hint level) is stored with the result as a plain-language Russian observation in
`learning/memory/observations.jsonl` (append-only: `add`, `edit`, `delete`, `supersede` events),
with refs to the source session, message and assessment. Rules (min 4 observations per group,
45-day half-life decay, hysteresis) derive a small profile `{preferred_style, preferred_form,
hint_start: early|late, step_size: smaller|bigger, evidence}`. Every change of the profile is a
snapshot `strategy-vN.json` (`strategy.json` is the current one) with a reason such as
"Объяснение через пример: 3 из 4 раз без подсказок". Deleted observations and observations whose text the learner edited do not feed
the profile; a tag-only correction counts under the corrected form. The lesson state gets `learner_notes` (at most 600 characters, data, "learner request
wins", never scores) unless adaptive is off. Observation capture and
notes are local; nothing is sent anywhere.

| Route | Meaning |
|---|---|
| `GET /memory` | `{settings:{adaptive}, strategy, versions[], observations[], rules}` |
| `PATCH /memory/observations/{id}` | `{text?, tag?}` (tag is a form id or `""`); marks it `edited` |
| `DELETE /memory/observations/{id}` | removes it from the list and the profile |
| `POST /memory/rollback` | `{version}`: restores that profile as a new version (kind `rollback`) |
| `PUT /memory/settings` | `{adaptive?}`; adaptive off also stops capturing |
| `POST /memory/rescan` | rebuilds missing observations from all journals, `{added, sessions}` |

Later (not built): a contextual bandit over the same strategy x context table behind
`strategy::choose(profile, context) -> {style, form, hint_start, step_size, reason}`.

### Question text formatting

`ask_questions.questions[].prompt` and `options[]` support Markdown and KaTeX math.
Use `$...$` inline and `$$...$$` on separate lines for display formulas. The frontend
also accepts `\(...\)` and `\[...\]`. Escape backslashes in JSON (e.g.
`{"prompt":"Compute $\\frac{1}{2}$."}`). Math inside code backticks stays literal.
Question prompts and selected answers retain formatting in the review before submission.
The title is plain text; `correct` still contains 1-based option numbers, not LaTeX labels.

### Skills library

User skills live in `$GRAPHY_DIR/skills/<id>/SKILL.md` (`id` = the frontmatter `name`: `[a-z0-9][a-z0-9_-]{0,63}`).
Skills from the other discovery folders (`.graphy/skills`, `.agents/skills`, `~/.agents/skills`) are listed
as `source: "external"` and are read-only. Writes never leave `$GRAPHY_DIR/skills`; ids are validated, symlinks are
never followed or copied, `SKILL.md` is at most 48 KiB, frontmatter needs `name` (equal to the id) and
`description` (up to 500 characters) and the body must be non-empty.

| Request | Meaning |
|---|---|
| `GET /skills/library` | `{skills: [Skill], warnings}`; `Skill = {id, name, description, tags, source: user\|catalog\|external, path, enabled, hash, modified, size, updated, editable, warnings, catalog?: {id, installed_version, latest_version, update_available}}`. `hash` is the sha256 of `SKILL.md`; `modified` is true for a catalog skill whose file differs from what was installed |
| `POST /skills` | `{name, description, body, tags?}` → `201 Skill`; `409 conflict` when the id exists |
| `POST /skills/import` | `{path}` (a `SKILL.md` or a folder holding one; supporting files up to 64 files / 2 MiB are copied) or `{content, name?, description?}` (pasted text; `name`+`description` wrap text without frontmatter) → `201 Skill` |
| `GET /skills/{id}` | `Skill` plus `content` (the file text) |
| `PUT /skills/{id}` | `{content, expected_hash?}` → `Skill`; a stale `expected_hash` gives `409 conflict`; the frontmatter name must stay the id |
| `DELETE /skills/{id}` | user and catalog skills only → `{deleted, id}` |
| `PUT /skills/{id}/enabled` | `{enabled}` → `Skill`. A disabled skill is hidden from `GET /skills`, from the agent's skill list and rejected by `load_skill` and `POST /sessions/{id}/skill`. Persisted in `$GRAPHY_DIR/skills/.state.json` |
| `POST /skills/{id}/duplicate` | copy as `<id>-copy[-n]` → `201 Skill` |
| `GET /skills/catalog` | `{skills: [{id, title, description, version, tags, sha256, example, installed, installed_version, update_available, modified, conflict}], warnings}` from the bundled `resources/skill-catalog.json`; no network |
| `POST /skills/catalog/{id}/install` | `{force?}` → `201 Skill` (`source: "catalog"`). Verifies the entry's sha256 first. Installing over a catalog skill you edited returns `409 conflict` (`skill_modified`) unless `force`; with `force` your file is kept as `SKILL.user-<time>.md`. A same-named skill that did not come from the catalog is never replaced. Installed versions are remembered in `$GRAPHY_DIR/skills/.catalog.json` |

Notes:
- The ids `library`, `catalog` and `import` are reserved (they would collide with fixed routes) and are refused everywhere.
- `POST /skills/import {path}` reads a local path the user typed: it is a local-user action, never driven by model or file content. Symlinks are skipped; nothing outside `$GRAPHY_DIR/skills` is written.
- Enable flags in `skills/.state.json` are keyed by the frontmatter `name`, not the folder. Deleting a user skill removes its flag unless an external skill of the same name still exists (it then keeps its switch state).
- Discovery (`GET /skills`, `load_skill`) now skips dot-folders (`.staging-*`) in every skills folder.
- Writers of `.state.json` / `.catalog.json` run under one process-wide mutex. A backup of a user-edited catalog skill is created with `create_new` as `SKILL.user-<nanos>[-n].md`; a symlinked `skills/<id>` is never written through (`409 conflict`).
- External skills open read-only in the UI (no Save).

Errors use the usual `{error: {code, message}}`; new codes: `conflict` (409), `not_found` (404).
Catalog format and how to add an entry: `backend/docs/skill-catalog.md`.

### Teacher / student role

Courses, assigned courses (`.graphycourse`), student reports (`.graphyreport`), authoring drafts, class analytics and the homework hint-ladder mode were removed: a chat is a plain chat. The role stays a local setting.

| Endpoint | Meaning |
|---|---|
| `GET /teaching/role`, `PUT /teaching/role {teacher}` | «Режим преподавателя» (a local setting in `learning/teaching/role.json`, not an account) |

`record_assessment` items keep the additive optional fields `hint_level` (0..4), `hint_log` (`[{level 1..4, note?}]`, at most 8) and `error_type`; they are stored in the `learning_assessment` journal event and returned in `learning.assessments[]`. Nothing gates them any more.

`quiz_topics` is added to the lesson state of quiz sessions: `{source: "weak_topics" | "plan", topics[]}` (weak topics from `study.weak_topics`).

Strategy memory observations (`GET /memory`) carry `context {mode?, error_type?}` when the assessment had them.

## Загрузка вложений из браузера

`POST /api/v1/attachments?name=<имя файла>` принимает исходные байты файла с
`Content-Type: application/octet-stream` и обычным `Authorization: Bearer <token>`.
Лимит тела — 20 МиБ. Пустой файл возвращает 400, превышение лимита — 413.
Ответ 201: `{ "path": "<путь в рабочей папке агента>", "size": 123 }`.
Путь затем передаётся в обычном списке вложений сообщения. Имя очищается от компонентов
пути; сервер создаёт уникальное имя внутри `.graphy-uploads/` рабочей папки, в том числе
в Docker. Выбор папки в браузере отправляет только список файлов как текст контекста.

Веб-сервер проекта проксирует `/api/` и SSE на API агента; добавляет токен на сервере.
`GET /graphy-config.json` возвращает `{ "url": "", "token": "" }`, то есть браузер
использует origin сайта. Доступ к прокси ограничен localhost и запросами с того же origin.
