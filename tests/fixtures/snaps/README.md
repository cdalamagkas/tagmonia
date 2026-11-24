# Recorded provider responses

Replayed by `tests/helpers/replay_fetch.ts` so the default test run never calls a
real provider API (CLAUDE.md testing rules). Unrecorded URLs make the test fail.

Layout: `<host>/<path>[__<query>].json`, e.g. `api.deezer.com/album/629506181.json`.
Queries longer than 160 characters (Lucene searches) are stored as
`__sha256-<hex of the query>` instead. A recorded 404 is `<name>.404.json`.

- Never commit responses that contain credentials, tokens or personal data.
- `api.deezer.com/*` was copied from Harmony's `testdata/` (MIT, see
  `THIRD_PARTY_NOTICES.md`) at the pinned submodule commit.
- `musicbrainz.org/*` was recorded with `scripts/record_mb.ts`, which goes
  through Tagmonia's own client (real User-Agent, 1 req/s, Retry-After). Re-run
  it with `--force` to refresh a recording.
