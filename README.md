<p align="center"><img src="brand/svg/tagmonia-logo-horizontal.svg" alt="Tagmonia" width="360"></p>

**Tags in harmony.** Tagmonia is a self-hosted web app that identifies music files, merges metadata from several
providers with per-field provenance, writes Picard-compatible tags, and helps submit missing releases to MusicBrainz.

> **Status: Phase 1 (scan and read).** Scans and browses a library read-only; identification and tag writing come next. See the roadmap in
> [docs/ARCHITECTURE.md §16](docs/ARCHITECTURE.md#16-implementation-roadmap).

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

Fingerprint identification is optional: get a free application key at <https://acoustid.org/new-application> and pass it as `TAGMONIA_ACOUSTID_KEY`, or as a Docker secret with `TAGMONIA_ACOUSTID_KEY_FILE` (see `docker-compose.example.yml`).

`deno task dev` starts both servers in one container (publish both ports with two `-p` flags if you run it that way).

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
| Chromaprint `fpcalc` (Debian package)   | Fingerprinting (§8, used from Phase 2)                                                            |

Third-party licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Tagmonia is licensed under the [GNU General Public License v3.0](LICENSE).
