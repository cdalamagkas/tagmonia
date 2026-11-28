/** The Changes tab's tables and counts (D53, D56). */
import { assert, assertEquals } from "@std/assert";
import type { FieldProposalDto, LockDto, ProposalDto } from "../../shared/types.ts";
import { buildChanges, type ChangesModel, locksOf } from "../../web/src/release/changes.ts";
import { changesToWrite } from "../../web/src/release/status.ts";

let nextId = 1;
function row(fileId: number, field: FieldProposalDto["field"], over: Partial<FieldProposalDto> = {}): FieldProposalDto {
  return {
    id: nextId++,
    fileId,
    field,
    current: null,
    proposed: "x",
    edited: null,
    status: "added",
    decision: "auto",
    locked: false,
    sources: [],
    origin: "deezer",
    conflict: false,
    resolvedFrom: null,
    ...over,
  };
}

function proposal(fields: FieldProposalDto[], over: Partial<ProposalDto> = {}): ProposalDto {
  return {
    id: 1,
    releaseMbid: null,
    sourceUrl: "https://www.deezer.com/album/1",
    primarySource: "deezer",
    mbServer: null,
    state: "needs_review",
    chosenBy: "user",
    createdAt: 0,
    stale: false,
    counts: { changed: 0, added: 0, unchanged: 0, locked: 0, filled: 0, conflicts: 0 },
    unmappedFiles: [],
    fields,
    providers: [],
    cover: null,
    rename: null,
    musicbrainzCandidates: [],
    ...over,
  };
}

const FILES = [1, 2, 3, 4, 5];

/** The EP: one album field changed on every file, totals added on every track, ISRCs per track, titles right. */
function ep() {
  return [
    ...FILES.map((f) =>
      row(f, "album", { current: "Ambient Piano Vol 1", proposed: "Ambient Piano Vol.1", status: "changed" })
    ),
    ...FILES.map((f) => row(f, "totaltracks", { proposed: 5 })),
    ...FILES.map((f) => row(f, "isrc", { proposed: [`QM${f}`], origin: "itunes" })),
    ...FILES.map((f) => row(f, "title", { current: `T${f}`, proposed: `T${f}`, status: "unchanged" })),
  ];
}

/** A track's row for a field. */
const cell = (m: ChangesModel, fileId: number, field: string) =>
  m.tracks.find((t) => t.fileId === fileId)!.rows.find((r) => r.field === field)!;

Deno.test("an album table with each field once; a table per track, every field, what is right marked", () => {
  const m = buildChanges(proposal(ep()), FILES);
  assertEquals(m.album.map((i) => [i.field, i.ids.length, i.weight, i.current, i.value, i.right]), [
    ["album", 5, 1, ["Ambient Piano Vol 1"], "Ambient Piano Vol.1", false],
  ]);
  assertEquals(m.tracks.map((t) => t.fileId), FILES);
  // Reading order: title, numbering, then the ISRC.
  assertEquals(m.tracks[0].rows.map((r) => [r.field, r.right]), [["title", true], ["totaltracks", false], [
    "isrc",
    false,
  ]]);
  assertEquals(cell(m, 2, "isrc").value, ["QM2"]);
  assertEquals(cell(m, 2, "isrc").filledBy, "itunes", "not the proposal's own source: filled by iTunes");
  assertEquals(m.album[0].filledBy, null);
  // 1 album field + 5 totals + 5 ISRCs; titles are already right.
  assertEquals([m.selected, m.total, m.alreadyRight], [11, 11, 5]);
  assertEquals(m.selected, changesToWrite(proposal(ep())), "the write bar and the header agree");
});

Deno.test("track order follows the files, not the database", () => {
  const m = buildChanges(proposal(ep()), [5, 4, 3, 2, 1]);
  assertEquals(m.tracks.map((t) => t.fileId), [5, 4, 3, 2, 1]);
});

Deno.test("kept, locked and edited rows: the checkbox, the counts, and the value shown", () => {
  const fields = ep().map((r) => {
    if (r.field === "album" && r.fileId === 1) return { ...r, decision: "kept_current" as const };
    if (r.field === "isrc" && r.fileId === 2) return { ...r, locked: true, decision: "kept_current" as const };
    if (r.field === "title" && r.fileId === 3) return { ...r, decision: "edited" as const, edited: "Mine" };
    return r;
  });
  const m = buildChanges(proposal(fields), FILES);
  assertEquals([m.album[0].included, m.album[0].mixed], [false, true], "four files write it, one keeps its value");
  const locked = cell(m, 2, "isrc");
  assertEquals([locked.locked, locked.included], [true, false]);
  const edited = cell(m, 3, "title");
  assertEquals([edited.edited, edited.value, edited.included, edited.right], [true, "Mine", true, false]);
  // Album field still written to four files (1) + 5 totals + 4 ISRCs + 1 edited title.
  assertEquals([m.selected, m.total], [11, 12]);
});

Deno.test("an open disagreement needs a choice first; once decided, it joins its section", () => {
  const date = FILES.map((f) =>
    row(f, "date", { proposed: "1978", conflict: true, origin: "musicbrainz", sources: [] })
  );
  const open = buildChanges(proposal([...date]), FILES);
  assertEquals([open.needsChoice.map((i) => i.field), open.album.length, open.needsChoice[0].unresolved], [
    ["date"],
    0,
    true,
  ]);
  const decided = buildChanges(proposal(date.map((r) => ({ ...r, decision: "accepted" as const }))), FILES);
  assertEquals([decided.needsChoice.length, decided.album.map((i) => i.field)], [0, ["date"]]);
  // An open disagreement on a field already as proposed still asks for a choice.
  const unchanged = buildChanges(
    proposal(date.map((r) => ({ ...r, status: "unchanged" as const, current: "1978" }))),
    FILES,
  );
  assertEquals(unchanged.needsChoice.length, 1);
});

Deno.test("the cover counts as one change, in the total and, when used, in the selection", () => {
  const cover = {
    source: "coverartarchive",
    embed: {},
    embedStatus: "changed",
    folder: null,
    folderStatus: null,
    writes: true,
  };
  const used = buildChanges(proposal(ep(), { cover: cover as ProposalDto["cover"] }), FILES);
  assertEquals([used.selected, used.total], [12, 12]);
  const kept = buildChanges(proposal(ep(), { cover: { ...cover, writes: false } as ProposalDto["cover"] }), FILES);
  assertEquals([kept.selected, kept.total], [11, 12]);
  const same = buildChanges(
    proposal(ep(), { cover: { ...cover, embedStatus: "unchanged", writes: false } as ProposalDto["cover"] }),
    FILES,
  );
  assertEquals(same.total, 11, "a cover already in the files is not a change");
});

Deno.test("an album field already right on some files is decided only for the others", () => {
  const fields = FILES.map((f) =>
    f === 1
      ? row(f, "label", { current: ["LKult"], proposed: ["LKult"], status: "unchanged" })
      : row(f, "label", { current: null, proposed: ["LKult"] })
  );
  const m = buildChanges(proposal(fields), FILES);
  assertEquals([m.album[0].ids.length, m.album[0].right, m.album[0].current], [4, false, [null]]);
});

Deno.test("the locks behind an item: this album's, its files', and global ones for the field", () => {
  const m = buildChanges(proposal(ep()), FILES);
  const locks: LockDto[] = [
    { id: 1, scope: "release", target: "9", field: "album" },
    { id: 2, scope: "global_field", target: "", field: "album" },
    { id: 3, scope: "release", target: "8", field: "album" },
    { id: 4, scope: "file", target: "2", field: "isrc" },
  ];
  assertEquals(locksOf(m.album[0], locks, 9).map((l) => l.id), [1, 2]);
  assertEquals(locksOf(cell(m, 2, "isrc"), locks, 9).map((l) => l.id), [4]);
  assert(locksOf(cell(m, 1, "isrc"), locks, 9).length === 0);
});

Deno.test("show all fields: right rows in reading order, album fields once, MusicBrainz identifiers last", () => {
  const right = (fileId: number, field: FieldProposalDto["field"], value: unknown) =>
    row(fileId, field, { current: value, proposed: value, status: "unchanged" });
  const fields = [
    right(2, "musicbrainz_trackid", "t2"),
    right(2, "title", "Two"),
    right(1, "musicbrainz_trackid", "t1"),
    right(1, "title", "One"),
    right(1, "composer", ["Schubert"]),
    right(1, "tracknumber", 1),
    right(1, "label", ["NO SILENCE"]),
    right(2, "label", ["NO SILENCE"]),
    right(1, "album", "A"),
    right(2, "album", "A"),
    row(1, "date", { current: "2026", proposed: "2026-10-23", status: "changed" }),
    row(2, "date", { current: "2026", proposed: "2026-10-23", status: "changed" }),
    row(1, "isrc", { proposed: ["X"] }),
  ];
  const m = buildChanges(proposal(fields), [1, 2]);
  assertEquals(m.album.map((i) => [i.field, i.right]), [["album", true], ["date", false], ["label", true]]);
  assertEquals(m.tracks.map((t) => [t.fileId, t.rows.map((r) => r.field)]), [
    [1, ["title", "tracknumber", "composer", "isrc", "musicbrainz_trackid"]],
    [2, ["title", "musicbrainz_trackid"]],
  ]);
  assertEquals(m.alreadyRight, 2 + 4 + 2);
});
