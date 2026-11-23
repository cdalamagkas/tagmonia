# CLAUDE.md — Tagmony

Tagmony is a self-hosted web app that identifies music files, merges metadata from several providers with per-field provenance, writes Picard-compatible tags, and helps submit missing releases to MusicBrainz.

**[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the source of truth.** Read the sections relevant to your task before writing code. If the code needs to diverge from it, update `ARCHITECTURE.md` in the same change and add a row to its Decision log (§17). Do not silently deviate.

## How to work

- Work **one roadmap phase at a time** (ARCHITECTURE.md §16). Do not start a phase until the previous one's "Done when" criteria pass.
- Before a non-trivial change, state a short plan: files to touch, tests to add. Keep changes small and reviewable.
- If a requirement is ambiguous or ARCHITECTURE.md lists it as an open question (§18), **ask instead of guessing**.
- When you discover a fact that changes the design (a provider limit, a library bug, a Harmony module that will not import), record it in the Decision log.

## Commands

These `deno.json` tasks are created in Phase 0. Keep them working.

```sh
deno task dev     # API server + Vite dev server with reload
deno task test    # all tests
deno task lint    # deno lint
deno task fmt     # deno fmt (run before committing)
deno task build   # build SPA + server bundle
```

Run `deno task fmt`, `deno task lint` and `deno task test` before considering any task done.

**Never install tools or libraries on the host.** Run every command in the dev container: `scripts/dk deno task test` (D13). Generate audio fixtures first with `scripts/dk scripts/gen_fixtures.sh`.

## Stack (summary)

- Deno 2 + TypeScript (strict). Hono for HTTP. Preact + Vite for the SPA in `web/`.
- SQLite (WAL) at `/config/tagmony.db`; numbered SQL migrations in `server/db/migrations/`.
- Harmony vendored as a git submodule at `vendor/harmony`, **pinned to a commit**.
- Tag I/O only through the `TagIO` interface in `server/tagio/`.
- `fpcalc` (Chromaprint) for fingerprints.

## Code conventions

- TypeScript `strict: true`. No `any` except at validated boundaries; validate all external input (HTTP bodies, provider responses, settings) with a schema.
- Shared API types live in `shared/types.ts`; the web client in `web/src/api.ts` uses them. Never duplicate DTO shapes.
- Only `server/providers/harmony_adapter.ts` may import from `vendor/harmony`. Never import Harmony's Fresh `server/` code.
- Only `server/tagio/` may touch audio file bytes or tag libraries.
- Paths stored in the database are **relative to the music root**.
- Long-running work goes through the job queue (`server/jobs/`), never inside a request handler.
- Use the canonical tag names from ARCHITECTURE.md §6.2 everywhere outside `server/tagio/`.
- Prefer small pure functions for scoring, normalization and merge logic, so they are easy to unit test.
- Comments explain *why*, not *what*.

## Testing rules

- Every bug fix comes with a test that fails before the fix.
- **Never** test against real provider APIs in the default test run. Use recorded responses in `tests/fixtures/snaps/`. Live provider tests, if any, are opt-in behind an environment variable.
- Audio fixtures are **generated** by a script (ffmpeg + a reference tag writer). Do not commit copyrighted music or large binaries.
- The TagIO conformance suite (`tests/tagio/`, ARCHITECTURE.md §11.5) must pass on all five formats: FLAC, OGG Vorbis, Opus, MP3, M4A. Never weaken or skip a conformance test to make a change pass; fix the implementation or record the decision.

## Safety rules (must follow)

1. **Never write to a real music library during development or tests.** Tests operate on copies of fixtures in a temporary directory.
2. All tag writes are atomic (temp file, fsync, rename), take a backup first, and verify by re-reading (§11.3).
3. Every filesystem path is resolved and checked to stay inside the music root (§14.4).
4. **MusicBrainz:** at most 1 request per second on average, always with the Tagmony `User-Agent`. Never submit edits automatically; submission is only via release-editor seeding in the user's browser (§12).
5. Providers call only their fixed API hosts; user-supplied URLs are matched against a host allowlist before any request (§14.5).
6. Use only official APIs for providers. No unofficial YouTube Music or scraping-based providers unless the Decision log approves it.
7. Never log or return secrets (tokens, passwords, cookies). Stored credentials are encrypted at rest (§14.3).
8. Authentication is mandatory on every route except `/api/health`, login and first-run setup. State-changing routes require a CSRF token.
9. Do not add a dependency without stating why; pin versions and keep `deno.lock` committed.
10. Keep Harmony's MIT notice in `THIRD_PARTY_NOTICES.md`.

## Git

- Small commits with imperative messages, prefixed by area: `tagio: preserve unknown frames on write`, `identify: add duration scoring`.
- One roadmap item per pull request where practical. Update ARCHITECTURE.md in the same PR when the design changes.
- Do not commit generated fixtures, `/config` data, `.env` files or snapshots containing credentials.
