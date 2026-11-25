# Release page restructure

**Status:** accepted 2026-11-25, not started; next after Phase 5 (D53). Updated 2026-11-25 to cover the UI added
after the proposal was written: the artist step of Add to MusicBrainz, its "Check again", the callback page and the
test-server marking (D52).
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
8. Add to MusicBrainz (only for releases tagged from a provider; see below)
9. Tracks (the files)

The Add to MusicBrainz card (`Submission.tsx`) has since become a workflow of its own, all in one card whose content
changes with the submission's state:

- **Before preparing:** an explanation and "Check MusicBrainz and prepare the editor"; after a failure, the error and
  the same button.
- **Test server:** a "test server" banner when submissions go to test.musicbrainz.org (Settings → MusicBrainz
  submissions).
- **Checking:** "Checking test.musicbrainz.org for this release…".
- **Ready / editor opened:**
  - an **Artists** list. Each credited artist is one of:
    - found by its provider page;
    - your choice (with undo);
    - same name, to check ("not this artist");
    - not linked yet (with suggestions, "Use this artist", a box to paste an artist link, and "None of these? Add this
      artist");
    - not on the server ("Add this artist").

    Linked artists may also offer "add its provider page". A note below explains why, with an inline "check again".
  - a **possible duplicates** table ("Use this" proposes from that release instead);
  - **Open the release editor** (again), **Check again**, **Cancel**;
  - once opened: "Check every tab of the editor, then submit", and a box to paste the new release's link if
    MusicBrainz does not send the browser back.
- **Verifying:** "Checking the new release on test.musicbrainz.org…".
- **Returned:** "added", the new release's link, "write the MusicBrainz identifiers in the proposal above", and the
  follow-ups: Add cover art; Submit the ISRCs (MagicISRC, musicbrainz.org only).

Elsewhere: MusicBrainz sends the browser to a separate page, `/mb/callback/<id>` ("Back from MusicBrainz"), which
returns to the release page once the release is verified. A proposal built from the test server shows a
"test.musicbrainz.org" badge next to "this MusicBrainz release"; one built from a provider link shows "this Deezer
album · not on MusicBrainz".

Measured on 2026-11-25, before the artist step existed (1280 × 900 viewport, headless Chromium):

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
7. **Adding to MusicBrainz is one long card with no sense of progress.** It is reached below History; it mixes artist
   matching, duplicates, the editor, waiting and follow-ups; its states replace each other in place with no "step 2 of
   4"; "Check again" appears twice; and after the return, the step that finishes the job (writing the new MusicBrainz
   identifiers) happens in a different card, the review, with nothing pointing to it.

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

While a submission is under way (D52), its state takes the status line:

| Submission state | Status sentence | Primary action |
|---|---|---|
| checking | "Checking test.musicbrainz.org for this release…" (live) | none |
| ready, artists to sort out | "2 artists to link before the editor" | Continue (opens the step at Artists) |
| ready, possible duplicates | "test.musicbrainz.org may already have this release" | Continue (opens the step at Duplicates) |
| ready, nothing in the way | "Ready to open the release editor" | Open the release editor |
| seeded (editor opened) | "Waiting for you to submit on test.musicbrainz.org" | Open the editor again; paste the link |
| verifying | "Checking the new release on test.musicbrainz.org…" (live) | none |
| returned, IDs not written | "Added to test.musicbrainz.org · 5 MusicBrainz IDs to write" | Write 5 changes |
| returned, IDs written | "On test.musicbrainz.org · follow-ups: cover art, ISRCs" | Follow-ups |
| failed | the error | Try again |

The header and tabs update live while jobs run, submission jobs included (fixes problem 6).

The source line says which server a MusicBrainz release is on when it is not the configured one: "MusicBrainz (test
server)", keeping today's badge.

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

A step launched from the header ("Add to MusicBrainz →"), not a card at the bottom: a panel over the tabs with a
progress line, closable at any point (the submission keeps its state, and the header shows it).

1. **Check.** "Check MusicBrainz and prepare the editor", then the live "Checking…" line. The test-server banner sits at
   the top of the panel for the whole step.
2. **Artists.** One row per credited artist, in a single format:
   `name — status — link to the artist — one action`. The status is one of: found by its page; your choice; same name,
   check it; not linked yet; not on the server.
   - The action follows the status: undo; not this artist; Use this artist (per suggestion), with the paste box and
     "Add this artist" under a "None of these?" disclosure.
   - "add its provider page" stays as a small link on linked rows.
   - Skipped automatically when every artist is found by its page.
3. **Duplicates.** Only when there are any. "Use this" ends the step: the release is proposed from that MusicBrainz
   release instead.
4. **Editor.** "Open the release editor", the reminder to check every tab, and the paste box for the new release's
   link if MusicBrainz does not send the browser back. "Waiting for you to submit…" until it does.
5. **Done.** "Added" with the new release's link, then a checklist:
   - **Write the MusicBrainz IDs** (links to the Changes tab, where they are the pending changes);
   - **Add cover art**;
   - **Submit the ISRCs** (musicbrainz.org only).

One **Check again** for the whole panel, in its footer next to **Cancel**: it re-runs the check after adding artists
or changing anything on MusicBrainz. The inline "check again" in the artist note goes.

The callback page (`/mb/callback/<id>`) stays a short transitional page. Once the release is verified, it opens the
release page with the panel at step 5.

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

The same EP, Add to MusicBrainz open at the artist step (test server):

```
 Add to MusicBrainz                                             ✕
 ① Check ✓ ─ ② Artists ─ ③ Duplicates ─ ④ Editor ─ ⑤ Done
 [test server] Releases added here exist only on test.musicbrainz.org.

 Artists
   Niklas Blumenthaler   ● on test.musicbrainz.org · found by its Deezer page
   Matthias Krauss       ● on test.musicbrainz.org · same name, check it   [Not this artist]
                           add his Deezer page on test.musicbrainz.org
 Duplicates: none on test.musicbrainz.org

                       [ Open the release editor ]   Check again   Cancel
```

## Plan

Progress: PR 1 done (header, live updates, tabs); PR 2 done (the Changes tab).

Four PRs, each usable on its own:

1. **Header and tabs:** status sentence, primary action, live updates, today's cards moved into tabs, duplicates
   removed. Low risk.
2. **Changes tab:** checkbox decisions with the ⋯ menu, the track grid, "same on all tracks" grouping, the pinned write
   bar, the cover counted consistently.
3. **Match tab:** one link box, one list of alternatives, evidence and mapping collapsed when certain.
4. **Add to MusicBrainz** as a header-launched step: the progress line, the five steps, one row format for artists,
   one Check again, the callback page opening step 5, and the submission states in the header.

Each PR is checked in headless Chromium at desktop and phone width, with the measurements redone:

- **Matched album:** the 17-track album from the maintainer's test folder, on a read-only copy.
- **Not on MusicBrainz:** a release on a provider but missing from MusicBrainz, with silent stand-in files of the real
  track lengths. The EP used so far, *Ambient Piano Vol.1*, is now on test.musicbrainz.org, and its stand-in files were
  deleted. PR 4 needs one still missing from the test server, and an artist missing there.

## PR 1 as built

- `web/src/release/status.ts` computes the status sentence and actions; it is pure and unit-tested
  (`tests/web/status.test.ts`).
  - The header's change count matches the Changes tab: an album field once, a track field per track, the cover as one.
    It no longer counts album fields once per file.
- `web/src/release/useRelease.ts` loads the release, identification, proposal, history, submission and current cover
  together, and polls while any job for the release runs. The cards no longer fetch or poll on their own.
- The review card lost its Write button, state badge and "files changed / discarded" notices: the header has them.
  Discard stays in the card.
- Add to MusicBrainz sits at the top of the Changes tab until PR 4. The header's "Add to MusicBrainz →" opens that tab
  and scrolls to it.
- The selected tab is in the URL (`?tab=match`). Without one, Changes opens when there is a proposal, Match otherwise.
- Found while checking: after an undo, the proposal read as "the files changed since…", so the header offered "Build
  again". The undo rewrites the files (new mtimes) but restores exactly the tags the proposal was built from. A
  complete undo now refreshes the proposal's file hash (`server/write/apply.ts`, with a test).
- Measured after PR 1 (1280 × 900):
  - matched album, one cover upgrade: the Changes tab is 1,029 px (1.1 screens), 9 buttons, and the status line sits
    at 249 px (was 4,080 px, 24 buttons, action at 2,525 px);
  - EP from Deezer: the Changes tab is still 4,209 px and 211 buttons, which is PR 2's work.

## PR 2 as built

- `web/src/release/changes.ts` groups a proposal into the Changes tab's items; it is pure and unit-tested
  (`tests/web/changes.test.ts`). The groups:
  - **Needs your choice:** open disagreements, also on fields already as proposed.
  - **Album:** an album field once.
  - **On all tracks:** the same proposed value, current value and decision on every track (at least two tracks).
  - **Track grid:** the rest, a row per track and a column per field, in the files' order.
- The write bar's "N of M changes selected" and the header's "N changes ready" use the same counting, which the tests
  check. Locked changes count in M but not in N.
- Each line: a checkbox (checked = include in the write; "mixed" when some files keep their value), the field, current
  → new, marks ("filled by …", "your value", "chosen: …", "🔒 never changes on …"), and a ⋯ menu. The menu offers
  Edit the value…, Use the proposed value, and Never change on this album, on this track (track lines) or on any
  album; on a locked line, Allow changes again. Clicking the new value edits it. The menu closes on a choice, an
  outside click or Escape.
- Track grid: each cell has its checkbox and ⋯; the column header's checkbox switches that field on every track.
- Cover: one line with the current and proposed pictures, their sizes, and where it goes.
- "N fields already right" opens a plain list; "Discard these changes" moved into the write bar.
- Phone width (settled): the grid keeps its columns and scrolls sideways inside its box; the page itself does not.
- Measured after PR 2 (1280 × 900):
  - EP from Deezer, 41 changes: the Changes tab is 1,853 px (2.1 screens), with album fields once, 5 "all 5 tracks"
    lines and one grid column (ISRC). It was 4,209 px after PR 1, with one table per track.
  - Matched album, one cover upgrade: 900 px (one screen), 10 controls.

## Still to settle while building

- Which tab opens when there is no proposal yet (probably Match).
- Whether the library list shows the same status sentence per release.
- Whether Settings → Cover art and Settings → MusicBrainz submissions get a link from where they apply (the cover row,
  the Add to MusicBrainz panel), as the review's cover line does today.
