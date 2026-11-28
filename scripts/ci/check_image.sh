#!/usr/bin/env bash
# Checks a built image before it may be published (D73): it starts and answers /api/health on its platform
# (under emulation for arm64), reports the expected version when one is given (D74), and Trivy finds no
# critical vulnerability that has a fix.
#   scripts/ci/check_image.sh <image> <platform> [version]
set -euo pipefail
image="$1"
platform="$2"
expected="${3:-}"
# Trivy's own image, pinned by digest (no third-party action in the workflow).
trivy="aquasec/trivy:0.76.2@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb"
name="tagmonia-check-$$"
config="$(mktemp -d)"
chmod 777 "$config"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

echo "== Start ($platform)"
docker run -d --name "$name" --platform "$platform" -v "$config:/config" "$image" >/dev/null
for _ in $(seq 1 60); do
  state="$(docker inspect -f '{{.State.Health.Status}}' "$name")"
  [ "$state" = healthy ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ] || break
  sleep 5
done
if [ "$state" != healthy ]; then
  echo "The image did not become healthy ($state):" >&2
  docker logs "$name" >&2
  exit 1
fi
echo "healthy"
if [ -n "$expected" ]; then
  reported="$(docker exec "$name" python3 -c "import json, urllib.request; print(json.load(urllib.request.urlopen('http://127.0.0.1:8080/api/health'))['version'])")"
  if [ "$reported" != "$expected" ]; then
    echo "The image reports version $reported, not $expected" >&2
    exit 1
  fi
  echo "version $reported"
fi

echo "== Scan ($platform)"
scan=(docker run --rm -v /var/run/docker.sock:/var/run/docker.sock "$trivy" image --quiet --scanners vuln
  --ignore-unfixed --table-mode detailed --platform "$platform")
# Every fixable high and critical finding goes in the run's summary; only a critical one fails the check.
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  found="$("${scan[@]}" --severity HIGH,CRITICAL --format table "$image")"
  {
    echo "### Trivy: $platform (fixable, high and critical)"
    # shellcheck disable=SC2016 # literal backticks: a Markdown code block
    if [ -n "$found" ]; then printf '```\n%s\n```\n' "$found"; else echo "None found."; fi
  } >>"$GITHUB_STEP_SUMMARY"
fi
"${scan[@]}" --severity CRITICAL --exit-code 1 --format table "$image"
