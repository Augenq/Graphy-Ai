#!/usr/bin/env bash
# Builds the images and packs everything needed to run Graphy on another computer with only Docker installed:
#   graphy-portable/  (images tar + compose file + search settings + README)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=graphy-portable
docker compose build
docker pull searxng/searxng:latest
rm -rf "$OUT" && mkdir -p "$OUT/searxng"
docker save graphy-app:latest searxng/searxng:latest | gzip > "$OUT/graphy-images.tar.gz"
cp docker-compose.yml "$OUT/"
cp searxng/settings.yml "$OUT/searxng/"
cat > "$OUT/README.txt" <<'TXT'
Graphy на другом компьютере. Нужен только Docker (Docker Desktop на Windows/macOS или docker + compose на Linux).

  1. docker load -i graphy-images.tar.gz     (на Linux/macOS: gunzip -c graphy-images.tar.gz | docker load)
  2. docker compose up -d --no-build
  3. Открыть http://localhost:5174

Остановить: docker compose down. Данные (уроки, настройки, ключи провайдеров) лежат в томах Docker и сохраняются.
Ключи моделей на новом компьютере нужно ввести заново в настройках приложения.
Образ собран для той же архитектуры процессора, что и исходный компьютер (x86_64).
TXT
echo "Готово: $OUT/ ($(du -sh "$OUT" | cut -f1)). Скопируйте папку на другой компьютер."
