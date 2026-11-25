# Release page restructure

**Status:** accepted 2026-11-25, not started. To be implemented after Phase 5 part 2 (D53).
**Decided by the maintainer:** tabs (not collapsible sections); checkboxes replace "Use proposed / Keep current", with
Edit and Lock in a ⋯ menu; built as separate PRs, outside Phase 5.

## Why

The release page (`web/src/pages/ReleasePage.tsx`, `components/Identification.tsx`, `Review.tsx`, `Submission.tsx`)
grew one card per feature, in the order the features were built:

1. summary with cover, then a "Release tags" table
2. MusicBrainz match: best match, score signals, two link boxes
3. Editions
4. Candidates
5. Track mapping
6. Proposed tags: "Also on", conflicts, cover, album fields, one table per track
7. History
8. Add to MusicBrainz
9. Tracks (the files)

Measured on 2026-11-25 (1280 × 900 viewport, headless Chromium):

| | Matched album: 17 tracks, already correct | EP not on MusicBrainz, tags from Deezer |
|---|---|---|
| Page length | 4,080 px (4.5 screens) | 5,017 px (5.6 screens) |
| What needs acting on | one cover upgrade, at 2,525 px (2.8 screens down) | 15 changes at 2,218 px; Add to MusicBrainz at 4,357 px, below History |
| Buttons | 24 | 96 |

Problems:

1. **The order follows the code, not the work.** What the user acts on sits in the middle.
2. **Evidence weighs as much as decisions.** A 100% match still shows six 100% signal rows and a 17-row track
   mapping. On a provider-sourced release, the MusicBrainz card keeps headlining a stale guess (seen: "CD 1 — Niklas",
   47%; "New Piano Sounds — Zygmunt Krauze") after the user chose Deezer.
3. **Duplicates.** "Release tags" repeats the review's "In the files now" column. The track mapping and the bottom
   "Tracks" list are the same rows, and two sections are titled "Tracks".
4. **No single status.** "matched", "needs review", "0 changed, 0 added" next to "Write 1 change" (the cover is not
   counted), the history and the submission state each speak separately.
5. **Five controls per decision** (Use proposed, Keep current, Edit…, lock for this file, lock everywhere), repeated
   for every field of every track: 20 near-identical rows such as "totaltracks: 5 added" on a 5-track EP.
6. **The page does not follow background work.** Opened while identification ran, the review panel never showed the
   automatic proposal until a reload: it polls only while a job it already knows about runs.

## Structure

A header that says where the release stands and what to do next, then four tabs.

### Header (always visible)

- Cover, title, artist, format, folder.
- **Source line:** where the tags come from and how sure Tagmonia is, with **Change** (opens the Match tab).
- **Status sentence and one primary action**, chosen by state:

| State | Status sentence | Primary action |
|---|---|---|
| New / identifying | "Identifying on MusicBrainz…" (live) | none |
| Needs a choice | "3 releases fit; none is certain" | Choose a release (Match tab) |
| Not found | "Not on MusicBrainz as far as Tagmonia can tell" | Paste an album link |
| Changes ready | "15 changes ready", or "Everything is already right" | Write 15 changes |
| Sources disagree | "2 fields need your choice" | Resolve (jumps to them) |
| Files changed since | "The files changed since this was prepared" | Build again |
| Written | "Written 11:32 · nothing left to change" | Undo (secondary) |
| Tags from a provider, not on MusicBrainz | as above, plus "Add to MusicBrainz →" | Add to MusicBrainz |

The header and tabs update live while jobs run (fixes problem 6).

### Changes tab (default when a proposal exists)

- Only what would change, grouped: **Needs your choice** (conflicts) → **Cover** → **Album** → **Tracks**.
- One line per change: `date  (not set) → 2021-07-23  [✓]  ⋯`.
  - The checkbox means "include in the write"; unchecked replaces "Keep current".
  - Clicking the value edits it.
  - The ⋯ menu holds Lock for this album or file, Lock everywhere, and Edit.
  - "filled by iTunes" stays as a small mark where it applies (D48, D51).
- **Tracks as one grid:** a row per track, a column per changed field, the old value on hover. A change identical on
  every track becomes one line: "On all 5 tracks: total tracks 5, disc 1/1 [✓]".
- **Write bar** pinned at the bottom: "15 of 15 changes selected · Write to files". The cover counts as a change
  everywhere (problem 4).
- "631 fields already right" is a single collapsed line.

### Match tab (today's MusicBrainz match, Editions, Candidates, Track mapping)

- The chosen source as one card. Evidence collapsed under "Why this release", open when the match is uncertain.
- Track mapping: only the rows that are off (low fit, unmapped files, tracks missing from the folder); otherwise one
  line, "All 17 files map 1:1".
- One list of alternatives: "Same album, other editions" and "Other releases".
- **One link box:** "Use another release: paste a MusicBrainz, Deezer, iTunes, Discogs or Bandcamp link", detected
  automatically. It replaces today's two boxes.
- With a provider source, old MusicBrainz guesses stay behind "MusicBrainz searched: nothing close (best 47%)".

### Files tab

Today's "Release tags" and bottom "Tracks" in one table. Values that differ across files are flagged, and each row
expands to all of that file's tags and technical details.

### History tab

Writes and undos, as today.

### Add to MusicBrainz

A step launched from the header, not a card at the bottom: a panel with a progress line, Check → Open the editor →
Back from MusicBrainz, then a follow-up checklist (add cover art, submit ISRCs). Once the release is on MusicBrainz,
the header switches to it and offers "Write 5 MusicBrainz IDs".

## Wireframes

Matched album, already correct, one cover upgrade: fits on one screen.

```
[cover] Lukas Sternath plays Franz Schubert and Franz Liszt
        Lukas Sternath · 2×CD · 17 FLAC files
        Source: MusicBrainz · 2026 · DE · NO SILENCE · 100% (MBID in your tags)  Change
        ● 1 change ready: a larger cover          [ Write 1 change ]
 Changes (1) │ Match │ Files │ History
 Cover   500×500 JPEG 62 KB → 1200×1200 PNG 641 KB  (Cover Art Archive)   [✓] ⋯
 631 fields already right ▸
```

EP not on MusicBrainz, tags from Deezer:

```
[cover] Ambient Piano Vol.1 · Niklas Blumenthaler · 5 FLAC files
        Source: Deezer album (not on MusicBrainz) · filled from iTunes      Change
        ● 15 changes ready                [ Write 15 changes ]   Add to MusicBrainz →
 Changes (15) │ Match │ Files │ History
 Album   album  Ambient Piano Vol 1 → Ambient Piano Vol.1 [✓]
         date   (not set) → 2021-07-23 [✓]   label (not set) → LKult  · iTunes [✓]
 Tracks  #  artist                                   ISRC
         1  Niklas B. → Niklas B. & Matthias Krauss  + QMFME2130072   [✓]
         …
         On all 5 tracks: total tracks 5, disc 1/1, media Digital Media [✓]
```

## Plan

Four PRs, each usable on its own:

1. **Header and tabs:** status sentence, primary action, live updates, today's cards moved into tabs, duplicates
   removed. Low risk.
2. **Changes tab:** checkbox decisions with the ⋯ menu, the track grid, "same on all tracks" grouping, the pinned write
   bar, the cover counted consistently.
3. **Match tab:** one link box, one list of alternatives, evidence and mapping collapsed when certain.
4. **Add to MusicBrainz** as a header-launched step with follow-ups.

Each PR is checked in headless Chromium on the two releases above (and the measurements redone), at desktop and phone
width.

## Still to settle while building

- The track grid at phone width: likely one card per track with its changed fields.
- Which tab opens when there is no proposal yet (probably Match).
- Whether the library list shows the same status sentence per release.
