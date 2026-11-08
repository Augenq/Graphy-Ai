# Сквозной сценарий «Школы» (Playwright)

Проверяет в браузере: учитель создаёт тест (3 типа вопросов) → ученик 1 сдаёт, ученик 2 начинает → учитель видит итоги, проверяет свободный ответ вручную; отдельно онбординг нового учителя и выдача материала.

Запуск (нужны `playwright-core` и Chromium; тестовый хаб без настоящего MAX):

```bash
docker volume create sch-data
docker run --rm -v sch-data:/d --entrypoint sh graphy:latest -c 'mkdir -p /d/hub && echo "{\"open\":true,\"admins\":[\"9001\"]}" > /d/hub/hub.json'
docker run -d --name sch-hub --network host -e MAX_BOT_TOKEN=fake:token -e MAX_API_URL=http://127.0.0.1:1 \
  -e GRAPHY_PUBLIC_URL=http://localhost:5191 -e GRAPHY_WEB_PORT=5191 -e GRAPHY_SANDBOX= -v sch-data:/data graphy:latest
cd scripts/e2e-school && npm i playwright-core
# CHROME=/usr/bin/chromium по умолчанию в lib.mjs
node setup.mjs && node e2e1.mjs && node e2e2.mjs && node e2e3.mjs && node e2e4.mjs
```

Вход подделывается подписью `initData` ключом `fake:token`: это тестовый хаб, не production. В MAX WebView сценарий не проверяет.
