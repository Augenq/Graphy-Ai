#!/usr/bin/env bash
# Запускает агента (только внутри контейнера) и веб-сервер, который проксирует к нему запросы.
set -euo pipefail
mkdir -p "$HOME" "$GRAPHY_DIR"
# MAX hub mode: the web server starts one private agent per signed-in user (scripts/max-hub.mjs); no shared agent.
if [ -n "${MAX_BOT_TOKEN:-}" ]; then
  export GRAPHY_RESOURCE_DIR="${GRAPHY_RESOURCE_DIR:-/app/graphy}"
  exec node /app/scripts/web-server.mjs
fi
# токен нужен только связке «сайт ↔ агент» внутри контейнера; наружу не публикуется
export GRAPHY_TOKEN="${GRAPHY_TOKEN:-$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
export GRAPHY_API_TOKEN="$GRAPHY_TOKEN"
python -m graphy serve --host 127.0.0.1 --port 8765 --cwd /workspace \
  --allow-origin "http://localhost:${GRAPHY_WEB_PORT}" >/tmp/agent.log 2>&1 &
agent=$!
for _ in $(seq 1 100); do
  grep -q '"type":"ready"' /tmp/agent.log 2>/dev/null && break
  kill -0 "$agent" 2>/dev/null || { cat /tmp/agent.log; exit 1; }
  sleep 0.2
done
trap 'kill "$agent" 2>/dev/null' EXIT TERM INT
node /app/scripts/web-server.mjs &
web=$!
wait -n "$agent" "$web"
