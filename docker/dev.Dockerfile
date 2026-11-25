# Development/test toolchain image. All local tooling runs here so nothing is
# installed on the host (see README "Development").
FROM denoland/deno:debian-2.9.8

# ffmpeg: fixture generation. python3-mutagen: reference tag writer for fixtures
# and the production TagIO sidecar (D7). libchromaprint-tools: fpcalc.
# python3-pil: cover thumbnails (D50).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-mutagen python3-pil libchromaprint-tools git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Deno cache lives in a named volume mounted here; world-writable so the
# container works for whatever host uid scripts/dk runs it as.
RUN mkdir -p /cache/deno && chmod -R 1777 /cache

WORKDIR /app
