# Build the Rust library inside the same Debian family as the runtime image.
# The launcher must not load a host-linked .so with an incompatible glibc.
FROM rust:bookworm AS core
WORKDIR /build
COPY rust/ ./
RUN CARGO_BUILD_JOBS=2 cargo build --release --locked --lib

FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONPATH=/app HOME=/tmp/home GRAPHY_SANDBOX=docker \
    GRAPHY_CORE_LIBRARY=/opt/graphy-native/libgraphy_core.so

COPY --from=core /build/target/release/libgraphy_core.so /opt/graphy-native/libgraphy_core.so

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash git curl ca-certificates poppler-utils unzip jq ripgrep procps less file \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
EXPOSE 8765
