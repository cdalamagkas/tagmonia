#!/usr/bin/env bash
# Regenerates tests/fixtures/audio (gitignored). Run inside the dev container.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp)"
deno run --quiet scripts/export_tag_mapping.ts > "$tmp"
python3 -I tests/fixtures/generate_audio.py "$tmp" tests/fixtures/fixture_tags.json tests/fixtures/audio
rm -f "$tmp"
