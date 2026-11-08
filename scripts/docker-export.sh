#!/usr/bin/env bash
# Собирает образы и кладёт всё нужное для запуска на другом компьютере в одну папку:
#   dist-docker/graphy-images.tar.gz   (образы graphy + searxng, без интернета)
#   dist-docker/docker-compose.yml, searxng/settings.yml, run.sh
set -euo pipefail
cd "$(dirname "$0")/.."
out=dist-docker
docker compose build
docker compose pull searxng
rm -rf "$out"; mkdir -p "$out/searxng"
docker save graphy:latest searxng/searxng:latest | gzip > "$out/graphy-images.tar.gz"
# в экспортируемом compose сборка не нужна: образ загружается из архива
sed '/^    build: \.$/d' docker-compose.yml > "$out/docker-compose.yml"
cp searxng/settings.yml "$out/searxng/"
cat > "$out/run.sh" <<'RUN'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
docker image inspect graphy:latest >/dev/null 2>&1 || gunzip -c graphy-images.tar.gz | docker load
docker compose up -d
echo "Graphy: http://localhost:5174"
RUN
chmod +x "$out/run.sh"
du -sh "$out"/*
