# Library and settings

**Status:** accepted 2026-11-28 (D75), before the first release. Done: PR 1 (the library's server side).
**Decided by the maintainer:** the library becomes a folder tree beside the release list (like Picard), with a status
filter, sorting, bulk actions and the view in the URL; Settings becomes sections with a side menu, each with its own
URL, and the settings that had no UI get one.

## Why

- **Library:** the page was a flat table of 50 releases at a time, with a search box and an All/Library/Inbox filter.
  With hundreds of albums it is hard to explore, and impossible to focus on one folder while enriching it.
- **Settings:** one long page (Account, about ten provider cards, Cover art, MusicBrainz submissions, Files). Scanner
  ignore patterns, identification thresholds, genres, the MusicBrainz mirror, AcoustID's minimum score and session
  lifetimes existed in `settings.json` with no UI.

## Library

```
┌─ Folders ──────────┬─ Soundtracks ───────────────────────────────────────┐
│ ▾ Library   (812)  │ [Search…]  Status [Changes ready ▾]  Sort [Album ▾]  │
│   ▸ Classical (140)│ ☐ all 9 here     [Identify again] [Write changes]   │
│   ▾ Soundtracks(57)│ ☐ ♪ Zimmer      Dune           MB ✓    25          │
│     ▸ Dune     (3) │ ☐ ♪ –           track01.flac   ✗       4           │
│ ▸ Inbox        (4) │ 9 of 57 releases                                    │
└────────────────────┴─────────────────────────────────────────────────────┘
```

- **Tree:** Library and Inbox roots, built from the releases the scan found (not the disk), one level at a time. Each
  folder shows its releases (with those below) and how many have changes ready or need a choice. On a phone it opens
  as a drawer.
- **List:** the folder and everything below it, searched, filtered by status, sorted.
  - Statuses: changes ready, needs a choice, files changed, complete, not identified, no match.
  - Sorts: artist, album, folder, recently added, most changes.
- **URL:** `?root=library&folder=…&status=…&sort=…&q=…`, so Back from a release returns to the view.
- **Bulk actions:** identify again, and write the ready changes, for the selection or the whole view. The server
  re-checks each release; each write is verified and can be undone on its own.

## Settings

Sections at `/settings/<section>`, with a side menu (a select on a phone):

- **Account:** you and your password.
- **Library & inbox:** ignore patterns, the inbox check interval.
- **Files & naming.**
- **Identification:** thresholds, AcoustID's minimum score, weights under "Advanced".
- **Tags & covers:** genres, the cover mode.
- **Providers:** a compact list that expands.
- **MusicBrainz:** the submission server, the mirror and its rate.
- **Sign-in:** session lifetimes, and how single sign-on and proxy sign-in are set up (read-only).

## Plan

1. Library server: the summary cache, the list's folder, status, sort and counts, and the tree.
2. Library UI: tree and list, filter, sort, URL.
3. Bulk actions.
4. Settings shell: routes, side menu, existing sections moved, providers as a compact list.
5. Settings additions for the settings without UI.

## PR 1 as built

- **The summary cache** (`release_summary`, `server/library/summary.ts`): each release's prepared changes, counted
  with the Changes tab's own rules, for filtering, sorting and counting across a whole folder. A row is recomputed
  when a key it was computed for changed:
  - the latest proposal's id and its new `revision`;
  - the release's content hash;
  - a global `generation`.
- **Triggers keep the keys current:**
  - any change to a proposal, its fields or its cover bumps its revision;
  - locks, destinations and files appearing, going or moving bump the generation;
  - the naming settings bump it in code.
- **Speed**, measured on 1,000 releases of 12 tracks:
  - a refresh with nothing changed takes 1 ms;
  - a list page 2–6 ms;
  - a tree level 3–16 ms;
  - a full recompute 0.8 s, or 1.9 s with renaming on. The rename check's set of taken names is now built once per
    refresh, not per album; it was 5.7 s.
  A scan recomputes in its own job, so the page doesn't wait.
- **API:**
  - `GET /api/library/releases` gains `root`, `folder` (a folder and below; whole names only), `status`, `sort` and
    `counts`;
  - `GET /api/library/tree?root=&path=` is new.
