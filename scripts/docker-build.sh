#!/usr/bin/env bash
# Reliable, repeatable Graphy image build. Builds Rust core and frontend on the HOST
# (fast, uses local caches, avoids the classic Docker builder hanging on heavy Rust
# release compiles), stages the core .so, then runs a normal `docker build` for the
# final image. Works with or without buildx.
#
# Usage: ./scripts/docker-build.sh [extra docker build args...]
# Env:   IMAGE=graphy:latest (default)  SKIP_RUST=1  SKIP_WEB=1
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${IMAGE:-graphy:latest}"
cd "$ROOT"

if [[ "${SKIP_RUST:-}" != "1" ]]; then
  # The core must be linked against the SAME glibc as the final image (Debian bookworm); a .so built on a
  # newer host (Arch, Fedora, Ubuntu 24.04+) fails to load with "GLIBC_2.xx not found". So build in rust:bookworm
  # with a persistent target dir (incremental) and registry cache.
  echo "==> building Rust core (rust:bookworm container, release, jobs=1)"
  docker run --rm --network host -v "$ROOT/backend/rust:/build" -w /build \
    -e CARGO_TARGET_DIR=/build/target-bookworm -e CARGO_BUILD_JOBS=1 -e CARGO_TERM_PROGRESS_WHEN=never \
    -u "$(id -u):$(id -g)" -e CARGO_HOME=/build/.cargo-home \
    rust:bookworm cargo build --release --locked --lib
fi
cp backend/rust/target-bookworm/release/libgraphy_core.so backend/rust/prebuilt-libgraphy_core.so
echo "==> staged backend/rust/prebuilt-libgraphy_core.so ($(du -h backend/rust/prebuilt-libgraphy_core.so | cut -f1))"

if [[ "${SKIP_WEB:-}" != "1" ]]; then
  echo "==> building frontend"
  if command -v npm >/dev/null 2>&1; then
    (cd frontend && { [[ -d node_modules ]] || npm ci; } && npm run build)
  else
    docker run --rm --network=host -v "$ROOT/frontend:/w" -w /w node:22-bookworm-slim \
      sh -lc 'if [ -d node_modules ]; then npm run build; else npm ci && npm run build; fi'
  fi
fi

echo "==> docker build -t $IMAGE"
docker build --network=host -f Dockerfile -t "$IMAGE" "$@" "$ROOT"

rm -f backend/rust/prebuilt-libgraphy_core.so
echo "==> done: $IMAGE"
docker image inspect "$IMAGE" --format 'id={{.Id}} size={{.Size}} created={{.Created}}' 2>/dev/null || true
