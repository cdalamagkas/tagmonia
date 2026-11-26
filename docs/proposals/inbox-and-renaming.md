# Inbox and renaming

**Status:** accepted 2026-11-26 (D57); Phase 6, W7 and §11.3's optional rename/move. Progress: PR 1 (the template).
**Decided by the maintainer:** a separate inbox folder; new arrivals are prepared automatically but written by you; renaming
happens as part of Write, in the same batch and undone by the same Undo; the default template names album folders like
the maintainer's own test folder.

## Why

New music arrives untagged or tagged by a shop, in folders named however the download named them. Today it has to be
copied into the library first, scanned by hand, and stays under its old name. With an inbox, Tagmonia notices new
albums, prepares their tags, and on Write moves them into the library under a consistent name.

## What the user sees

- **Settings → Files:**
  - the inbox (from `TAGMONIA_INBOX_DIR`, shown read-only);
  - the template in use, chosen from built-in templates and your own saved ones, each shown with an example;
  - **New template**, and copy, edit and delete for saved ones, with a live example while typing;
  - "Rename albums already in the library when writing" (off by default).
- **Library page:** an **Inbox (3)** filter next to the list; inbox albums carry an "inbox" badge.
- **Release page of an inbox album:**
  - the header reads "In the inbox · 15 changes ready" with **Write and move to the library**;
  - the Changes tab gets a **Files** section: each file's current name → new path, with the album folder once
    ("→ Lukas Sternath plays … (2026)/"). The move counts as one change.
- **After the write:** the album is in the library under its new name, the History entry lists the moves, and **Undo**
  puts back the tags, the names and the folder, as they were.

## Design

### Two roots

- `TAGMONIA_INBOX_DIR` (optional, e.g. `/inbox`). Without it, nothing in this note changes Tagmonia, except opt-in
  renaming inside the library.
- `library_file` and `candidate` get a `root` column (`library` | `inbox`). Paths stay relative to their root (CLAUDE.md),
  and `path` is unique per root (a table rebuild in the migration).
- Startup refuses an inbox inside the library or the library inside the inbox. Every path is resolved and checked
  against its own root (§14.4).

### Noticing new arrivals (W7)

- `Deno.watchFs` on the inbox, plus polling every 5 minutes (setting). Polling is what works on SMB/NFS mounts and on
  WSL's `/mnt/c`, where change events do not arrive.
- **Quiet period:** an album folder is scanned only once nothing in it changed for 30 seconds and its file sizes are
  the same on two looks, so a copy in progress is never picked up.
- The scan covers only the inbox; then identification and the automatic proposal run as for the library. Nothing is
  written by itself.

### The template

- **Several to choose from** (setting `files.active` and `files.templates`):
  - built in: "Album (Year)" (the default), "Artist / Album (Year)", "Picard's default" and "Composer / Album (Year)"
    for classical music;
  - up to 20 saved templates of your own, each with a unique name;
  - the one in use cannot be deleted; if the chosen one is missing, the default applies.
- **Default:** `{album} ({date:4})/{disc-}{tracknumber:02} {artist} - {title}`, which gives
  `Lukas Sternath plays Franz Schubert and Franz Liszt (2026)/1-01 Franz Schubert & Franz Liszt - Der Wanderer S 558_11 (after D 489).flac`.
- **Variables:** any canonical tag (§6.2), as it will be **after** the write.
  - `{date:4}`: the first 4 characters;
  - `{tracknumber:02}`: padded to 2 digits;
  - `{disc-}`: "1-" only when the release has more than one disc;
  - `{a|b}`: the first one that has a value (e.g. `{albumartist|artist}`).
- **Missing values:** `[unknown album]`, `[unknown artist]` and so on, never an empty folder name.
- **Safe names everywhere (NAS, SMB, Windows):**
  - `/ \ : * ? " < > |` become `_` (as in the test folder's `S 558_11`);
  - trailing dots and spaces are trimmed, whitespace runs collapsed, Unicode normalised (NFC);
  - names never start with `.` and are at most 255 bytes, truncated before the extension;
  - the extension is the file's own, in lower case.
- **Validation:** the setting is checked on save. An unknown variable, an absolute path, `..`, or a template without
  `{title}` or `{tracknumber}` is refused.
- Pure functions, unit-tested, shared by the server and the settings page's live example (`shared/naming.ts`).

### Moves in the write batch

Order: write and verify every file's tags (§11.3), **then** move. Rules:

- **All or nothing per album:** if any file of the album failed its tag write, nothing is moved and the batch is
  "partial", so an album is never left half in the inbox and half in the library.
- **Never overwrite:** a target that exists and is not the same file fails that move. Two files that map to the same
  name get " (2)".
- **Atomic where possible:** `rename(2)`. Across filesystems (inbox and library on different mounts, `EXDEV`) the file is
  copied, `fsync`ed, compared by size and SHA-256, and only then is the original deleted.
- **Companion files move with the album:**
  - which: `cover.*`, `folder.*`, `*.pdf`, `*.cue`, `*.log`, `*.txt`, `*.m3u*`, `*.jpg`/`*.png` scans;
  - when: only if every audio file of that folder moves to the same new folder and the folder holds no other album's
    audio;
  - afterwards, emptied source folders are removed, up to their root.
- **Journal:** a `file_move` row per moved file (from root and path, to root and path, status), next to `file_backup`.
  Undo moves back first, then restores tags, and refuses a file that was moved or changed since.
- **The database follows:** the file row's `root`, `path` and `folder` are updated in place, and the candidate's
  folder too. So file IDs, locks, history and Undo keep working across Tagmonia's own renames (half of the deferred
  "locks surviving renames"; renames by other tools still lose them).
- **Jellyfin:** the new folder is new to Jellyfin, so a debounced library scan replaces the targeted refresh for moves.
- **Read-only mode** moves nothing, like it writes nothing.

## Plan

Four PRs, each usable on its own:

1. **Template:** the template engine and its validation; Settings → Files with built-in and saved templates to choose
   from, created and edited with a live example.
   Nothing is renamed yet, and the page says so.
2. **Renaming on write:**
   - the Files section of the Changes tab, previewing the new names (with "Rename albums already in the library");
   - moves in the write batch, the journal, companion files, emptied folders, Undo, the database update, the Jellyfin
     scan.

   The preview comes with the moves, so the page never shows names a Write would not give.
3. **The inbox:** the second root (migration), scanning the inbox, the Inbox filter, the header's "Write and move to the
   library".
4. **Watching:** `watchFs`, polling, the quiet period.

Every PR is tested on temporary directories only; any check against real folders works on a copy, backed up first
(CLAUDE.md safety rule 1).

## Open points (defaults chosen; say if you want otherwise)

1. **Renaming inside the library is off by default.** Inbox albums are always moved into the library on Write, since
   that is what the inbox is for.
2. **Inbox albums need a template**, so the default one applies until changed.
3. **Untouched inbox albums:** an album that cannot be identified stays in the inbox until you choose a release or
   paste a link. Nothing is ever moved without a Write.
4. **No "delete from inbox" in the UI:** removing files stays with you.
