# Inbox and renaming

**Status:** accepted 2026-11-26 (D57); Phase 6, W7 and §11.3's optional rename/move. Progress: PR 1 (the template), PR 2 (renaming on write) and PR 3 (the inbox) done; destinations added (D59).
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
- **As built (D58):** inbox files are stored as `@inbox/<path in the inbox>`, not with a `root` column. One path column
  stays unique, and units, grouping and hashes work as they do for the library. `Roots` resolves a stored path in its
  own root, and every path is checked to stay inside it (§14.4). A real `@inbox` folder in the library is skipped.
- Startup refuses an inbox that is the library, inside it, or contains it.

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

Added on request after PR 3: **destinations** (D59), below.

Every PR is tested on temporary directories only; any check against real folders works on a copy, backed up first
(CLAUDE.md safety rule 1).

## PR 2 as built

- `server/files/rename.ts`:
  - the plan is pure: each file's tags after the write, through the template in use;
  - two files with the same new name are numbered " (2)", " (3)";
  - names compare without case, since SMB shares and Windows ignore it;
  - a name another file has is a conflict.
- **Companion files** are every other regular file in a folder whose audio all goes to one new folder (cover,
  booklet, cue sheet and so on), simpler than a list of patterns. A folder that still holds another album's audio keeps
  them. Subfolders stay. A companion whose name is taken in the new folder stays where it is.
- **Order in the write:** tags, verified, then renames, only when every file was written. Every target is checked
  before anything moves; any failure moves back what was moved. The batch is then "partial" with the reason, and the
  tags stay written.
- **Undo:** moves back first (refusing files moved again since, or whose old name is taken), then restores the tags
  of the files that are back. A rename-only write is undone by the moves alone.
- **Database:** the files keep their IDs, the release's folder follows (the deepest folder holding all its files),
  and its content hash is recomputed, so a rescan finds nothing changed.
- **UI:**
  - Settings → Files: "Rename albums when writing them" (off by default).
  - Changes tab: a **Files** section with its checkbox ("Rename 17 files and move them to …"), any taken names, and
    every file's new name in a fold. It counts as one change, and a taken name blocks the write until renaming is left
    out of it.
  - History: "17 renamed", with each move.
- **Checked** on a scratch copy of the 17-track album:
  - with the default template there is nothing to rename: it reproduces the maintainer's own names exactly;
  - with "Artist / Album (Year)": 17 files moved, then undone. Names, tags, pictures and audio (FLAC MD5) were equal
    to the backup, and no folder was left behind.

## PR 3 as built

- **Scanning:** "Scan library" scans the library, then the inbox. Each scan compares only its own rows, so neither
  removes the other's files. Inbox albums are identified and prepared like any other.
- **Writing:** an inbox album always moves into the library by the template in use, whether or not library renaming
  is on (there is no checkbox). Everything else is PR 2's rules: after the tags verify, all or nothing, never over an
  existing file, its other files along. The inbox folder is removed once empty, never the inbox itself. Undo moves the
  album back into the inbox.
- **Fingerprints, covers and thumbnails** read inbox files through the same resolver.
- **UI:**
  - Library: All / Library / Inbox (N), an "inbox" badge, and folders shown as "Inbox / …".
  - Release page: "In the inbox · 26 changes ready" with **Write and move to the library**.
  - Changes tab: "Move 3 files from the inbox into the library, to …".
  - Settings → Files: how many albums wait in the inbox, or how to set one up.
- **Checked** in headless Chromium with a scratch library and inbox: silent stand-ins for a 3-track Deezer album were
  scanned into Inbox (1), proposed from the Deezer link, and written. They landed in the library as
  `Interstellar Epic Piano Suite (2023)/01 Katherine Cordova - …flac`, with the folder's `notes.txt`, and the inbox was
  left empty. Undo back into the inbox is tested on real audio.

## Destinations (D59)

Libraries are not always Artist / Album. A soundtrack collection may be kept by film or series, with as many artists
as tracks. Tagmonia does not try to know such schemes; it lets you put an album in any folder.

- **Where:** the Changes tab's Files section. "Choose a folder instead…" (or "Move the album to a folder…" when
  nothing would move) opens a picker:
  - browse the library's folders (hidden folders, symlinks and the inbox's reserved name are left out);
  - "Used before" lists earlier choices, most used first;
  - "New folder" names one or more new folders; they are made only when the album is written, so nothing changes on
    disk before Write, and read-only mode can still choose. Characters that Windows or SMB refuse become "_", as in
    templates, and the picker says so.
- **What it does:** the album folder and file names still come from the template, but only its last folder level:
  `Soundtracks/Interstellar` + `{albumartist}/{album} ({date:4})/…` gives
  `Soundtracks/Interstellar/Interstellar (2014)/…`, with no artist folder. "Use the template's folders" goes back.
- **When it applies:** inbox albums always move. A library album with a destination moves on Write even when "Rename
  albums when writing them" is off, since choosing a folder asks for it. The Files checkbox can still leave the move
  out of one write.
- **Kept with the album,** not with one proposal, so building the changes again keeps it, and a later write keeps the
  album there.
- **Undo** moves the album back and removes the album folder the write made, but never the chosen folder, even empty.
- **Not covered:** moving an album that has nothing left to write. The Files section is part of the Changes tab, so
  it needs open changes.
- **Checked** in headless Chromium with a scratch library (`Soundtracks/Dune`, `Classical`) and inbox: chose
  `Soundtracks`, made "Interstellar: the film?" (named `Interstellar_ the film_`), wrote the album into
  `Soundtracks/Interstellar_ the film_/Interstellar Epic Piano Suite (2023)/`, undid it back into the inbox (the
  chosen folder stayed), and checked the picker at 390 px.

## Open points (defaults chosen; say if you want otherwise)

1. **Renaming inside the library is off by default.** Inbox albums are always moved into the library on Write, since
   that is what the inbox is for.
2. **Inbox albums need a template**, so the default one applies until changed.
3. **Untouched inbox albums:** an album that cannot be identified stays in the inbox until you choose a release or
   paste a link. Nothing is ever moved without a Write.
4. **No "delete from inbox" in the UI:** removing files stays with you.
