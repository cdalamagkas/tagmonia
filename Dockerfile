# syntax=docker/dockerfile:1
# Production image (ARCHITECTURE.md §15.1). Phase 6 adds PUID/PGID remapping,
# SBOM and multi-arch publishing; this is the Phase 0 baseline.
# The Deno image is written out (no build arg) so Dependabot can update it, together with docker/dev.Dockerfile.
FROM denoland/deno:debian-2.9.8 AS build
WORKDIR /app
ENV DENO_DIR=/deno-dir
COPY . .
RUN deno task web:install \
 && deno run -A npm:vite@7.3.7 build web \
 && deno cache --frozen --node-modules-dir=none server/main.ts

FROM denoland/deno:debian-2.9.8
# python3-mutagen: TagIO sidecar (D7). libchromaprint-tools: fpcalc (§8). python3-pil: cover thumbnails (D50).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-mutagen python3-pil libchromaprint-tools \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV DENO_DIR=/deno-dir \
    TAGMONIA_WEB_DIR=/app/web/dist \
    TAGMONIA_MUSIC_DIR=/music \
    TAGMONIA_CONFIG_DIR=/config
COPY --from=build /deno-dir /deno-dir
COPY --from=build /app/deno.json /app/deno.lock ./
COPY --from=build /app/vendor/harmony ./vendor/harmony
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
COPY --from=build /app/web/dist ./web/dist
COPY THIRD_PARTY_NOTICES.md ./
RUN mkdir -p /music /config && chown 1000:1000 /config && chmod -R a+rX /deno-dir /app
USER 1000:1000
EXPOSE 8080
VOLUME ["/config"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["deno", "eval", "const r = await fetch('http://127.0.0.1:8080/api/health'); Deno.exit(r.ok ? 0 : 1)"]
CMD ["deno", "run", "--cached-only", "--node-modules-dir=none", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-run=python3,fpcalc", "server/main.ts"]
