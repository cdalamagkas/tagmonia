# syntax=docker/dockerfile:1
# Production image (ARCHITECTURE.md §15.1). It starts as root only to hand /config to PUID:PGID and then runs
# Tagmonia as that user, without capabilities (D72); or as the user Docker's `user:` sets.
# The Deno image is written out (no build arg) so Dependabot can update it, together with docker/dev.Dockerfile.
# The web build runs on the builder's own platform: its output is the same for every target, so an arm64 image
# needs no emulated Vite build (D73).
FROM --platform=$BUILDPLATFORM denoland/deno:debian-2.9.8 AS web
WORKDIR /app
COPY . .
RUN deno task web:install && deno run -A npm:vite@7.3.7 build web

# The server's dependencies are cached for the target platform: Deno installs every npm package of the lock file
# for the platform it runs on (esbuild's native binary among them), and --cached-only then finds them (D73).
FROM denoland/deno:debian-2.9.8 AS build
WORKDIR /app
ENV DENO_DIR=/deno-dir
COPY . .
COPY --from=web /app/web/dist ./web/dist
RUN deno cache --frozen --node-modules-dir=none server/main.ts

FROM denoland/deno:debian-2.9.8
# python3-mutagen: TagIO sidecar (D7). libchromaprint-tools: fpcalc (§8). python3-pil: cover thumbnails (D50).
# `upgrade` brings Debian's security fixes released since the base image (D73).
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
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
# The release version, from the tag (D74); empty for other builds, which then report the development version.
ARG VERSION=""
RUN if [ -n "$VERSION" ]; then echo "$VERSION" > VERSION; fi
# `docker exec -it tagmonia reset-password [username]` (D71).
COPY --chmod=755 docker/reset-password /usr/local/bin/reset-password
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/entrypoint
RUN mkdir -p /music /config && chown 1000:1000 /config && chmod -R a+rX /deno-dir /app
ENV PUID=1000 PGID=1000
EXPOSE 8080
VOLUME ["/config"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["deno", "eval", "const r = await fetch('http://127.0.0.1:8080/api/health'); Deno.exit(r.ok ? 0 : 1)"]
ENTRYPOINT ["/usr/local/bin/entrypoint"]
CMD ["deno", "run", "--cached-only", "--node-modules-dir=none", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-run=python3,fpcalc", "server/main.ts"]
