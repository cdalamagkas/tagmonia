# Recorded provider responses

Replayed by `tests/helpers/replay_fetch.ts` so the default test run never calls a
real provider API (CLAUDE.md testing rules). Unrecorded URLs make the test fail.

Layout: `<host>/<path>[__<query>].json`, e.g. `api.deezer.com/album/629506181.json`.

- Never commit responses that contain credentials, tokens or personal data.
- `api.deezer.com/*` was copied from Harmony's `testdata/` (MIT, see
  `THIRD_PARTY_NOTICES.md`) at the pinned submodule commit.
