<p align="center"><img src="brand/svg/tagmonia-logo-horizontal.svg" alt="Tagmonia" width="360"></p>

**Tags in harmony.** Tagmonia is a self-hosted web app that identifies music files, merges metadata from several
providers with per-field provenance, writes Picard-compatible tags, and helps submit missing releases to MusicBrainz.

> **Status: In active development (alpha) - We are now working on UI and usability improvements.
> Stay tuned for the first release!** Tagmonia identifies releases against
> MusicBrainz, proposes tags field by field with values merged from Deezer, iTunes and Discogs, adds cover art, writes
> everything with verification and undo, and tells Jellyfin. Releases missing from MusicBrainz can be tagged from
> Deezer, iTunes, Discogs or Bandcamp and added to MusicBrainz through its release editor.
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
- **One page per release** that says where it stands and what to do next ("15 changes ready · Write 15 changes",
  "3 releases fit; none is certain · Choose a release", "Written … · Undo"), and updates by itself while Tagmonia works.
  Below it: **Changes** (what a write would do: a table for the album and one per track with each field's current
  and proposed value and a checkbox, and **Show all fields** for the rest; the ⋯ menu edits a value or keeps a field
  from ever changing on this album, this track or any album), **Match** (where the tags come from, the track mapping, the other editions and releases, and one box for
  any MusicBrainz, Deezer, iTunes, Discogs or Bandcamp link),
  **Files** (what the files hold now) and **History** (writes and undos). For a release missing from MusicBrainz, the
  header's **Add to MusicBrainz →** opens a step panel over the tabs.
- **Writes** reviewed tags safely: a backup first, an atomic write, a read-back check with automatic restore, and
  **undo** for every write. A read-only mode writes nothing.
- **Tells Jellyfin** to re-read exactly the albums it changed.
- **Finds the same release on Deezer, iTunes, Discogs, and Tidal and Spotify if you set them up**, by the release's own
  MusicBrainz link or by barcode, and shows where it was found, where only another edition exists (a different track
  count), and where it is missing.
- **Merges their values by precedence**: a full release date where MusicBrainz has only the year, a missing barcode,
  label or catalog number from Discogs, missing ISRCs from Deezer or iTunes, and each provider's own ID. Such fields
  are marked "filled by …". Where MusicBrainz and Discogs disagree, the review shows both values and asks you to
  choose before anything is written.
- **Poorly tagged or missing releases, from an album link**: paste a Deezer, iTunes, Tidal, Spotify, Discogs, Bandcamp
  or YouTube link on the release page. Tagmonia first looks for that album on MusicBrainz (releases linked to the page,
  the same barcode, the same title and artist): when one is certain it tags from MusicBrainz, and offers the likely
  ones otherwise. If MusicBrainz lacks it, the tags come from the album itself, filled in from the same release on the
  other providers (by barcode), ready to review, write and add to MusicBrainz.
- **Adds them to MusicBrainz, with you in charge**: Tagmonia checks MusicBrainz for the release first (barcode, linked
  pages, title), then opens MusicBrainz's release editor filled in, with an edit note naming its sources. You review
  and submit from your own account; MusicBrainz sends you back, Tagmonia checks the new release exists, and its
  MusicBrainz IDs are proposed for the files. It runs as five steps with a progress line (Check, Artists, Duplicates,
  Editor, Done), and the header says where it stands. Artists MusicBrainz does not have yet are listed first, each with
  a filled-in "Add artist" link. The last step is a checklist: write the MusicBrainz IDs, add the cover art, submit
  the ISRCs. **Settings →
  MusicBrainz submissions** can point this at test.musicbrainz.org for trying it out. Nothing is ever submitted
  automatically.
- **YouTube as a source**: paste a YouTube playlist (or a single video) on the release page's Match tab. For a
  release MusicBrainz lacks, its auto-generated descriptions ("Provided to YouTube by …", "Title · Artist", the album,
  the ℗ line, "Released on: …") give the titles, artists, track numbers, album, date and label, and the release can
  then be added to MusicBrainz with the playlist as its streaming link. With a MusicBrainz release chosen, the link
  only fills the date and label where no other source has them. Uses the official YouTube Data API with your own key.
- **Cover art** from the Cover Art Archive, or else the largest image iTunes, Deezer or Discogs has for the same
  release. The review shows the cover with its source, size and what the files have now. **Settings → Cover art**
  chooses how it is written: embedded at full size (the default), embedded at about 1200 px, only as `cover.jpg` in
  the album folder, or both (about 1200 px embedded plus the full-size `cover.jpg`). Other pictures in the files are
  kept, and undo puts back the previous pictures and folder image exactly.
- **Shows each release's current cover**: a thumbnail in the library list, and on the release page the cover with its
  size, type and where it is (embedded in the files or an image in the album folder).
- **Search with your own terms** (Match tab): for files with few or no tags, type an artist, album or track title to
  search MusicBrainz again; if nothing fits, use them as the tags to write.
- **Untagged files:** each is a release of its own, named by its title or file name, except a folder of untagged
  files numbered like an album (`01 …`, `02 …`), which stays one release. Search finds files by name too.
- **Library list at a glance:** next to each release's MusicBrainz status, how many changes are ready to write, how
  many values need your choice, or that its files are already complete.
- **Naming templates** (Settings → Files): how written albums will be named. Choose a built-in template (Album
  (Year), Artist / Album (Year), Picard's default, Composer / Album (Year)) or create and save your own, each with a
  live example. The default is `{album} ({date:4})/{disc-}{tracknumber:02} {artist} - {title}`.
- **Renames albums when writing them** (off by default, Settings → Files): the release's Files → Location shows every file's new name
  first, the album's cover and booklet files move with it, nothing is ever overwritten, and Undo puts the old names
  back.
- **An inbox for new music** (`TAGMONIA_INBOX_DIR`): albums dropped there are scanned with the library, identified
  and prepared; when you write one, it moves into the library under the template's name. The inbox is watched:
  albums copied there appear by themselves once the copy has finished (also checked every 5 minutes, for network
  shares). The library page has an Inbox filter.
- **Choose where an album goes** (Files → Location on the release page): pick any library folder, or name a new one (made when you
  write), for example a film's folder for its soundtrack. The album folder and file names still follow the template.
- **Providers page** (Settings → Providers): credentials stored encrypted, on/off switches, and a health check per
  provider.

- Design and decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (source of truth)
- Agent/contributor conventions: [CLAUDE.md](CLAUDE.md)

## Development

All tooling runs in a Docker container; nothing needs to be installed on the host except Docker and git.
`scripts/dk` builds the dev image (`docker/dev.Dockerfile`: Deno, ffmpeg, mutagen, Pillow, fpcalc) on first use and runs a
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
- **Tidal** (optional): a client ID and secret from an app at developer.tidal.com → Dashboard. Takes effect after a
  restart.
- **Spotify** (optional): a client ID and secret from an app at developer.spotify.com → Dashboard (using it means
  accepting Spotify's Developer Terms). Takes effect after a restart.
- **Jellyfin** (optional): the server URL, an API key (Dashboard → API Keys) and optionally one library; Tagmonia then
  asks Jellyfin to re-read exactly the albums it changed.
- MusicBrainz, Deezer and iTunes need no credentials.
- **Bandcamp** needs none either, but it is off unless you switch it on: Bandcamp has no official API, so Tagmonia
  reads its public album pages, and only when you give it a Bandcamp link.
- **YouTube** (optional): an API key from Google Cloud. Create a project, enable the **YouTube Data API
  v3**, then create an API key (Credentials → Create credentials → API key). The free daily quota is ample: a playlist
  costs a few units, and responses are cached for a week.

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
# with an inbox for new music:
docker run -p 8080:8080 -v /path/to/music:/music -v /path/to/inbox:/inbox -e TAGMONIA_INBOX_DIR=/inbox \
  -v tagmonia-config:/config tagmonia
```

### Signing in with your identity provider

Besides the local admin account, Tagmonia can sign people in through an OpenID Connect provider (Authentik,
Keycloak, Authelia, …). Only members of one group get in; the local password form stays as the fallback.

1. Create an OAuth2/OpenID client in the provider: confidential, authorization code flow, redirect URI
   `<TAGMONIA_PUBLIC_URL>/api/auth/oidc/callback`, and make sure its tokens carry a `groups` claim.
2. Create a group (e.g. `tagmonia`) and add the people who may use Tagmonia.
3. Set, next to `TAGMONIA_PUBLIC_URL`:

```sh
TAGMONIA_OIDC_ISSUER=https://auth.example.com/application/o/tagmonia/
TAGMONIA_OIDC_CLIENT_ID=tagmonia
TAGMONIA_OIDC_CLIENT_SECRET_FILE=/run/secrets/oidc_secret   # or TAGMONIA_OIDC_CLIENT_SECRET
TAGMONIA_OIDC_GROUP=tagmonia
TAGMONIA_OIDC_NAME=Authentik                                 # the button reads "Sign in with Authentik"
```

The provider must be reachable over https. Each person gets their own Tagmonia account, matched by the provider's
user ID, never by name.

### Signing in through your reverse proxy

If a reverse proxy already signs people in (Authelia, an Authentik outpost, oauth2-proxy), Tagmonia can take the user
from its headers. They are believed only from the proxy's own address, and only members of one group get in; the
local password form stays as the fallback.

```sh
TAGMONIA_TRUSTED_HEADER=Remote-User
TAGMONIA_TRUSTED_GROUPS_HEADER=Remote-Groups   # the default
TAGMONIA_TRUSTED_GROUP=tagmonia
TAGMONIA_TRUSTED_PROXIES=172.18.0.0/16         # the proxy's address or its Docker network
```

Make sure Tagmonia is reachable only through the proxy, and that the proxy sets these headers itself rather than
passing on what the browser sent. Signing out happens at the proxy.

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
| `oauth4webapi`                          | OpenID Connect sign-in: discovery, PKCE, state and nonce checks, ID-token validation (D69)        |
| `@std/path`                             | Glob matching for the scanner's ignore patterns                                                   |
| `node:sqlite` (built into Deno)         | Database (D19); not a separate dependency                                                         |
| `preact`, `vite`, `@preact/preset-vite` | Web UI and its build (§4)                                                                         |
| `@std/assert`                           | Test assertions                                                                                   |
| `taglib-wasm`                           | TagIO spike implementation kept so the D7 decision can be re-checked; not used in production      |
| mutagen, Python 3 (Debian packages)     | Production TagIO sidecar (D7)                                                                     |
| Chromaprint `fpcalc` (Debian package)   | Fingerprinting for AcoustID identification (§8)                                                   |
| Pillow (Debian package)                 | Cover thumbnails for the library and release pages (D50)                                          |

Third-party licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Tagmonia is licensed under the [GNU General Public License v3.0](LICENSE).
