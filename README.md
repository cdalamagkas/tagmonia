<p align="center"><img src="brand/svg/tagmonia-logo-horizontal.svg" alt="Tagmonia" width="360"></p>

**Tags in harmony.** Tagmonia is a self-hosted web app that identifies music files, merges metadata from several
providers with per-field provenance, writes Picard-compatible tags, and helps submit missing releases to MusicBrainz.

> **Status: Phases 0–4 are done; Phase 5 (MusicBrainz submission) is next.** Tagmonia identifies releases against
> MusicBrainz, proposes tags field by field with values merged from Deezer, iTunes and Discogs, adds cover art,
> writes everything with verification and undo, and tells Jellyfin.
> See the roadmap in
> [docs/ARCHITECTURE.md §16](docs/ARCHITECTURE.md#16-implementation-roadmap).

## What it does today

- **Scans** a library (FLAC, OGG Vorbis, Opus, MP3, M4A) and groups files into releases, multi-disc sets included.
- **Identifies** each release against MusicBrainz: existing MBIDs, barcode or catalog number, text search, and
  optional AcoustID fingerprints. Albums with missing tracks are recognised; similar editions are never picked
  silently but shown side by side in an **edition picker**. A MusicBrainz link can be pasted when nothing fits.
- **Proposes tags** the way Picard writes them, including classical credits (composer, conductor, performers, work and
  movement) and MusicBrainz genres. Every field shows what the files hold now, what is proposed and where it comes
  from; each can be accepted, kept, edited or locked.
- **Writes** reviewed tags safely: a backup first, an atomic write, a read-back check with automatic restore, and
  **undo** for every write. A read-only mode writes nothing.
- **Tells Jellyfin** to re-read exactly the albums it changed.
- **Finds the same release on Deezer, iTunes and Discogs**, by the release's own MusicBrainz link or by barcode, and
  shows where it was found, where only another edition exists (a different track count), and where it is missing.
- **Merges their values by precedence**: a full release date where MusicBrainz has only the year, a missing barcode,
  label or catalog number from Discogs, missing ISRCs from Deezer or iTunes, and each provider's own ID. Such fields
  are marked "filled by …". Where MusicBrainz and Discogs disagree, the review shows both values and asks you to
  choose before anything is written.
- **Cover art** from the Cover Art Archive, or else the largest image iTunes, Deezer or Discogs has for the same
  release. The review shows the cover with its source, size and what the files have now. **Settings → Cover art**
  chooses how it is written: embedded at full size (the default), embedded at about 1200 px, only as `cover.jpg` in
  the album folder, or both (about 1200 px embedded plus the full-size `cover.jpg`). Other pictures in the files are
  kept, and undo puts back the previous pictures and folder image exactly.
- **Providers page** (Settings → Providers): credentials stored encrypted, on/off switches, and a health check per
  provider.

- Design and decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (source of truth)
- Agent/contributor conventions: [CLAUDE.md](CLAUDE.md)

## Development

All tooling runs in a Docker container; nothing needs to be installed on the host except Docker and git.
`scripts/dk` builds the dev image (`docker/dev.Dockerfile`: Deno, ffmpeg, mutagen, fpcalc) on first use and runs a
command in it with the repo mounted.

```sh
git clone --recurse-submodules <repo>    # or: git submodule update --init
scripts/dk scripts/gen_fixtures.sh       # generate test audio (tests/fixtures/audio, gitignored)
scripts/dk deno task test                # all tests
scripts/dk deno task lint
scripts/dk deno task fmt
scripts/dk deno task check               # type-check
DK_PORTS=8080:8080 scripts/dk deno task dev:server   # API on :8080
DK_PORTS=5173:5173 scripts/dk deno task dev:web      # Vite dev server on :5173 (proxies /api)
DK_REBUILD=1 scripts/dk true             # rebuild the dev image
# synthetic 300-album library in dev/music (what dev:server scans); never point it at a real library
scripts/dk deno run --allow-read --allow-write --allow-env --allow-run=python3 scripts/gen_library.ts --albums 300
```

On first start the UI asks you to create the admin account (or set `TAGMONIA_ADMIN_PASSWORD_FILE`).

### Providers and credentials

**Settings → Providers** in the app lists every provider with its purpose, an on/off switch where it applies, its
credentials and a **Test** button. Secrets are stored encrypted (AES-256-GCM) and never shown again once saved.

- **AcoustID** (optional fingerprint identification): a free application key from
  <https://acoustid.org/new-application>.
- **Discogs**: a consumer key and secret from discogs.com → Settings → Developers. Takes effect after a restart.
- **Jellyfin** (optional): the server URL, an API key (Dashboard → API Keys) and optionally one library; Tagmonia then
  asks Jellyfin to re-read exactly the albums it changed.
- MusicBrainz, Deezer and iTunes need no credentials.

The same values can come from the environment instead, which wins over the app and suits Docker secrets:
`TAGMONIA_ACOUSTID_KEY` / `TAGMONIA_ACOUSTID_KEY_FILE`, `TAGMONIA_JELLYFIN_URL`, `TAGMONIA_JELLYFIN_KEY` /
`TAGMONIA_JELLYFIN_KEY_FILE`, `TAGMONIA_JELLYFIN_LIBRARY` (see `docker-compose.example.yml`).

**Back up the encryption key with the database.** Saved credentials are encrypted with `TAGMONIA_SECRET_KEY` if set,
otherwise with a key generated into `/config/secret.key` on first start. Without that key they cannot be read (the app
says so and asks for them again).

`deno task dev` starts both servers in one container (publish both ports with two `-p` flags if you run it that way).

### A throwaway Jellyfin for development

To see writes the way a music server does (Phase 3), run a dev Jellyfin over a **test** music folder (never your real
library; Tagmonia writes to it):

```sh
TAGMONIA_TEST_MUSIC=/path/to/test-music UID=$(id -u) GID=$(id -g) \
  docker compose -f docker/jellyfin-dev.compose.yml up -d     # http://localhost:8096
DK_NETWORK=tagmonia-dev scripts/dk deno run -A scripts/dev_jellyfin.ts
# first-run setup, a "MusicTest" library over the folder, and an API key in dev/secrets/ (gitignored, never printed)
```

Then run Tagmonia on the same folder with `DK_NETWORK=tagmonia-dev DK_MUSIC=/path/to/test-music` and
`TAGMONIA_MUSIC_DIR=/music TAGMONIA_JELLYFIN_URL=http://tagmonia-dev-jellyfin:8096
TAGMONIA_JELLYFIN_KEY_FILE=dev/secrets/jellyfin_key TAGMONIA_JELLYFIN_LIBRARY=MusicTest`. `scripts/dk` passes every
`TAGMONIA_*` variable of your shell into the container by name.

### TagIO

Tag reading and writing go only through `server/tagio/`. The production implementation is a Python
[mutagen](https://mutagen.readthedocs.io/) sidecar (decision D7). The conformance suite in `tests/tagio/` checks every
canonical field on FLAC, OGG Vorbis, Opus, MP3 and M4A against Picard's tag mapping, inspecting raw bytes with an
independent inspector. To re-run it against the taglib-wasm spike:

```sh
scripts/dk sh -c 'TAGMONIA_TAGIO_IMPL=taglib-wasm deno task test:tagio'
```

## Running the image

```sh
docker build -t tagmonia .
docker run -p 8080:8080 -v /path/to/music:/music -v tagmonia-config:/config tagmonia
```

See `docker-compose.example.yml`. Configuration variables are listed in
[ARCHITECTURE.md §15.2](docs/ARCHITECTURE.md#152-configuration).

## Dependencies

Every dependency is pinned (`deno.json`, `deno.lock`, the Harmony submodule commit, the Deno base image tag).

| Dependency                              | Why                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Harmony (submodule)                     | Provider lookups, release merging and MusicBrainz seeding (§4.1)                                  |
| `hono`                                  | HTTP framework (§4)                                                                               |
| `zod`                                   | Schema validation of all external input: env, HTTP bodies, sidecar output (CLAUDE.md conventions) |
| `hash-wasm`                             | Argon2id password hashing, pure WebAssembly (D20)                                                 |
| `@std/path`                             | Glob matching for the scanner's ignore patterns                                                   |
| `node:sqlite` (built into Deno)         | Database (D19); not a separate dependency                                                         |
| `preact`, `vite`, `@preact/preset-vite` | Web UI and its build (§4)                                                                         |
| `@std/assert`                           | Test assertions                                                                                   |
| `taglib-wasm`                           | TagIO spike implementation kept so the D7 decision can be re-checked; not used in production      |
| mutagen, Python 3 (Debian packages)     | Production TagIO sidecar (D7)                                                                     |
| Chromaprint `fpcalc` (Debian package)   | Fingerprinting for AcoustID identification (§8)                                                   |

Third-party licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Tagmonia is licensed under the [GNU General Public License v3.0](LICENSE).
