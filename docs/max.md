# Graphy в MAX

Graphy работает как сервис внутри MAX: бот присылает кнопку входа, приложение открывается в WebView, пользователь выбирает роль «Ученик» или «Учитель».

Рабочий бот: <https://max.ru/ideya_fiks_2_bot>

## Как это устроено

1. Пользователь пишет боту `/start`. Если он в списке доступа, бот отвечает кнопкой «Открыть Graphy» со ссылкой входа.
2. Ссылка содержит подписанный токен: она не истекает и открывается любое число раз, в том числе на другом устройстве. Если приложение запущено как мини-приложение MAX, вход идёт по подписанным данным `WebApp.initData`.
3. Хаб (`scripts/max-hub.mjs`) проверяет подпись, создаёт пользователя, выдаёт сессию на 7 дней и запускает ему отдельного агента.
4. Учитель создаёт класс и отправляет ученикам ссылку-приглашение; ученик присоединяется по ней.

Если адрес мини-приложения не зарегистрирован в кабинете MAX, приложение всё равно работает по ссылкам от бота.

## Переменные окружения

Шаблон: [.env.example](../.env.example).

| Переменная | Назначение |
|---|---|
| `MAX_BOT_TOKEN` | токен бота; наличие включает режим хаба |
| `GRAPHY_PUBLIC_URL` | публичный HTTPS-адрес сервиса, попадает в ссылки входа |
| `MAX_ADMIN_CLAIM` | одноразовый код: отправьте боту `/claim <код>`, чтобы стать администратором |
| `MAX_ADMIN_IDS` | список id администраторов через запятую (альтернатива `/claim`) |
| `GRAPHY_LLM_KEY`, `GRAPHY_LLM_UPSTREAM` | ключ и адрес провайдера моделей (по умолчанию OpenRouter); пользователи его не видят |
| `GRAPHY_MAX_AGENTS` | сколько агентов держать в памяти одновременно (по умолчанию 3 для сервера на 1 ГБ) |
| `GRAPHY_DAILY_LLM_REQUESTS` | лимит запросов к модели на пользователя в сутки |
| `GRAPHY_PUBLIC_LLM` | `off` выключает публичный уровень сервиса Graphy для локальных установок |
| `GRAPHY_ANON_USD_TOKEN`, `_IP`, `_TOTAL` | суточные лимиты публичного уровня по оценке стоимости, USD (1 / 2.5 / 12 по умолчанию) |
| `SEARXNG_URL`, `GRAPHY_STT_URL` | адреса поиска и распознавания речи, если они подняты |

## Команды администратора бота

`/users` (список доступа), `/adduser <id>`, `/open` и `/close` (открыть доступ всем или только по списку), `/claim <код>`. Незнакомые пользователи попадают в список ожидания, их id администратор видит в `/users`.

## Развёртывание на сервере

Требования: Docker, домен или `sslip.io`-адрес с HTTPS (MAX открывает приложения только по HTTPS), 1 ГБ ОЗУ с запасом swap.

```bash
docker network create graphy-net
# поиск и распознавание речи — по желанию
docker run -d --name searxng --network graphy-net -v $PWD/searxng/settings.yml:/etc/searxng/settings.yml:ro searxng/searxng:latest
docker run -d --name graphy-hub --restart unless-stopped --network graphy-net --env-file .env \
  -e SEARXNG_URL=http://searxng:8080 -e GRAPHY_PUBLIC_URL=https://your.domain \
  -p 127.0.0.1:5174:5174 -v graphy-data:/data -v graphy-workspace:/workspace \
  --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add FOWNER --cap-add DAC_OVERRIDE \
  --security-opt no-new-privileges:true --pids-limit 256 --memory 640m \
  --read-only --tmpfs /tmp:rw,exec,nosuid,size=256m graphy:latest
```

Хаб запускается от root внутри контейнера, чтобы переключать uid агентов; поэтому остальные права ограничены. Перед ним ставится обратный прокси с TLS, проксирующий на `127.0.0.1:5174` (пример для Caddy: `your.domain { reverse_proxy 127.0.0.1:5174 }`).

Обновление: собрать или загрузить новый образ, `docker rm -f graphy-hub`, запустить заново. Данные в томах сохраняются; простой около минуты.

## Проверка без MAX

Хаб можно поднять локально с тестовым токеном и проверить школу в обычном браузере: см. [scripts/e2e-school/README.md](../scripts/e2e-school/README.md). Это не заменяет проверку в настоящем MAX WebView.
