# Graphy целиком: веб-интерфейс + агент (Rust-ядро) в одном образе.
#   docker compose up -d   →   http://localhost:5174

# 1. Rust-ядро собираем в том же Debian, что и итоговый образ (иначе несовместимый glibc).
FROM rust:bookworm AS core
WORKDIR /build
ENV CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse \
    CARGO_NET_GIT_FETCH_WITH_CLI=true \
    CARGO_NET_RETRY=3 \
    CARGO_TERM_PROGRESS_WHEN=never \
    CARGO_INCREMENTAL=0
# Cache deps: fetch/build dependencies in a separate layer (src changes don't refetch the index).
COPY backend/rust/Cargo.toml backend/rust/Cargo.lock ./
RUN mkdir -p src && printf 'pub fn _dummy(){}\n' > src/lib.rs \
 && CARGO_BUILD_JOBS=1 cargo build --release --locked --lib || true
COPY backend/rust/ ./
# Build the Rust core. If scripts/docker-build.sh staged a prebuilt .so (fast, reliable on
# constrained hosts), use it; otherwise build from source (canonical/CI path).
# CARGO_BUILD_JOBS=1: release deps (image/jsonschema/axum) are RAM-heavy; avoids OOM.
RUN mkdir -p target/release \
 && if [ -f prebuilt-libgraphy_core.so ]; then \
      cp prebuilt-libgraphy_core.so target/release/libgraphy_core.so; \
      echo "using staged prebuilt libgraphy_core.so"; \
    else \
      CARGO_BUILD_JOBS=1 cargo build --release --locked --lib; \
    fi

# 2. Сайт.
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
COPY scripts/web-proxy.mjs /scripts/web-proxy.mjs
RUN npm run build

# 3. Итог: Python (запускатель) + Node (веб-сервер) + ядро + собранный сайт.
FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/app HOME=/tmp/home \
    GRAPHY_SANDBOX=docker GRAPHY_DIR=/data GRAPHY_CORE_LIBRARY=/opt/graphy-native/libgraphy_core.so \
    GRAPHY_WEB_HOST=0.0.0.0 GRAPHY_WEB_PORT=5174 GRAPHY_API_URL=http://127.0.0.1:8765 \
    MPLBACKEND=Agg MPLCONFIGDIR=/tmp/mplconfig XDG_CACHE_HOME=/tmp/.cache OMP_THREAD_LIMIT=1 \
    TEXMFVAR=/tmp/texmf-var TEXMFCACHE=/tmp/texmf-cache TEXMFHOME=/tmp/texmf-home PIP_NO_CACHE_DIR=1
RUN find /etc/apt \( -name '*.sources' -o -name 'sources.list' \) -exec sed -i 's|http://deb.debian.org|http://cloudfront.debian.net|g' {} + \
 && grep -rq cloudfront /etc/apt \
 && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=15 -o Acquire::ForceIPv4=true update \
 && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=15 -o Acquire::ForceIPv4=true install -y --no-install-recommends bash git curl ca-certificates poppler-utils unzip jq ripgrep procps less file \
    tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng pandoc catdoc antiword djvulibre-bin qpdf \
    gcc g++ libc6-dev make fp-compiler hunspell hunspell-ru \
    texlive-latex-base texlive-latex-recommended texlive-fonts-recommended texlive-lang-cyrillic texlive-xetex latexmk \
 && dpkg --purge --force-depends texlive-pictures texlive-latex-extra \
 && mkdir -p /usr/local/share/texmf/tex/latex/lmodern \
 && printf '\\ProvidesPackage{lmodern}\n\\endinput\n' > /usr/local/share/texmf/tex/latex/lmodern/lmodern.sty && mktexlsr \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /usr/share/info/* \
 && (dpkg -L texlive-lang-greek | while read f; do [ -f "$f" ] && rm -f "$f"; done; true) \
 && find /usr/share/locale -mindepth 1 -maxdepth 1 ! -name 'ru*' ! -name 'en*' -exec rm -rf {} +

# Python libraries the agent uses in its sandbox (documents, charts, OCR, maths): exact versions in requirements.txt
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --no-compile -r /tmp/requirements.txt \
 && mkdir -p /usr/share/doc && find /usr/local/lib/python3.12/site-packages -type d \( -name tests -o -name test -o -name __pycache__ \) -prune -exec rm -rf {} + \
 && rm -f /tmp/requirements.txt
COPY --from=web /usr/local/bin/node /usr/local/bin/node
COPY --from=core /build/target/release/libgraphy_core.so /opt/graphy-native/libgraphy_core.so
COPY backend/graphy /app/graphy
COPY scripts/web-server.mjs scripts/web-proxy.mjs scripts/max-hub.mjs scripts/school.mjs /app/scripts/
RUN chmod -R a+rX /app/graphy /app/scripts
COPY --from=web /web/dist /app/frontend/dist
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN sed -i "s#'../frontend/dist'#'../frontend/dist'#" /app/scripts/web-server.mjs \
 && mkdir -p /data /workspace && chmod 1777 /data /workspace
# Computer Modern with Cyrillic (matches the document style) and xxd, small layer
RUN set -e; apt-get -o Acquire::Retries=5 -o Acquire::ForceIPv4=true update; cd /tmp; apt-get -o Acquire::ForceIPv4=true download fonts-cmu xxd; dpkg -i --force-depends fonts-cmu_*.deb xxd_*.deb; rm -f /tmp/*.deb; rm -rf /var/lib/apt/lists/* /usr/share/doc/fonts-cmu /usr/share/man; fc-cache -f
WORKDIR /workspace
EXPOSE 5174
ENTRYPOINT ["bash", "/app/docker-entrypoint.sh"]
