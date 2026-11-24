/** §10.2 comparison and §10.3 rules on the field proposals. */
import { assert, assertEquals } from "@std/assert";
import { buildFieldProposals, type FieldLock } from "../../server/proposal/build.ts";
import { normalizeText, valuesAgree } from "../../server/proposal/compare.ts";
import type { ProposedTags } from "../../server/proposal/musicbrainz_tags.ts";

Deno.test("comparison: invisible differences agree; case and punctuation are changes (D43)", () => {
  assert(valuesAgree("title", "Don\u2019t  Stop ", "Don\u2019t Stop"), "extra spaces are invisible");
  assert(valuesAgree("artist", "Beyonce\u0301", "Beyoncé"), "decomposed é equals composed é");
  // MusicBrainz's exact spelling is proposed, as Picard writes it.
  assert(!valuesAgree("title", "is this it", "Is This It"));
  assert(!valuesAgree("title", "Don't Stop", "Don\u2019t Stop"));
  assert(!valuesAgree("title", "Stop", "Start"));
});

Deno.test("comparison: the loose strength ignores case and punctuation, for providers agreeing", () => {
  assert(valuesAgree("title", "is this it", "Is This It", "loose"));
  assert(valuesAgree("title", "Don't Stop", "Don\u2019t Stop", "loose"));
  assertEquals(normalizeText("  A \u201Cquote\u201D "), 'a "quote"');
});

Deno.test("comparison: dates at shared precision, barcodes by digits", () => {
  assert(valuesAgree("date", "2019", "2019-05-03"));
  assert(!valuesAgree("date", "2018", "2019-05-03"));
  assert(valuesAgree("barcode", "0602508000001", "602508000001"));
});

Deno.test("comparison: unordered lists ignore order, artist lists do not", () => {
  assert(valuesAgree("genre", ["Rock", "Pop"], ["Pop", "Rock"]));
  assert(!valuesAgree("genre", ["rock"], ["Rock"]), "case is a change");
  assert(!valuesAgree("artists", ["A", "B"], ["B", "A"]));
  assert(valuesAgree("label", "Label A", ["Label A"]), "a single stored value agrees with a one-item list");
  assert(valuesAgree("performer", { piano: ["X", "Y"] }, { piano: ["Y", "X"] }));
  assert(valuesAgree("performer", { Piano: ["X"] }, { piano: ["x"] }, "loose"));
  assert(!valuesAgree("performer", { piano: ["X"] }, { piano: ["X", "Y"] }));
});

const proposed: ProposedTags = {
  release: { album: "Album", date: "2019-05-03", genre: ["rock"] },
  tracks: new Map([["t1", { title: "One", tracknumber: 1 }], ["t2", { title: "Two", tracknumber: 2 }]]),
};

function build(locks: FieldLock[] = []) {
  return buildFieldProposals({
    candidateId: 7,
    files: [
      { id: 1, tags: { album: "album", title: "Uno", date: "2019", barcode: "123456789012" } },
      { id: 2, tags: {} },
      { id: 3, tags: { title: "Bonus" } },
    ],
    mapping: [{ fileId: 1, trackId: "t1" }, { fileId: 2, trackId: "t2" }],
    proposed,
    snapshotId: 9,
    locks,
  });
}

Deno.test("fields are unchanged, changed or added; unmapped files are left out", () => {
  const r = build();
  const f1 = new Map(r.fields.filter((f) => f.fileId === 1).map((f) => [f.field, f.status]));
  assertEquals(Object.fromEntries(f1), {
    // "album" → "Album": MusicBrainz's case is proposed (D43).
    album: "changed",
    date: "unchanged",
    genre: "added",
    title: "changed",
    tracknumber: "added",
  });
  assert(r.fields.filter((f) => f.fileId === 2).every((f) => f.status === "added"));
  assertEquals(r.unmappedFiles, [3]);
});

Deno.test("a field MusicBrainz has no value for is not proposed, so the file keeps it (D40)", () => {
  assert(!build().fields.some((f) => f.field === "barcode"));
});

Deno.test("every field carries its MusicBrainz source and snapshot", () => {
  const f = build().fields.find((x) => x.fileId === 1 && x.field === "title")!;
  assertEquals(f.sources, [{ provider: "musicbrainz", value: "One", snapshotId: 9, agreesWithProposed: true }]);
  assertEquals([f.current, f.proposed], ["Uno", "One"]);
});

Deno.test("locks apply per file, per release and globally (§10.3 rule 1)", () => {
  const r = build([
    { scope: "file", target: "1", field: "title" },
    { scope: "release", target: "7", field: "genre" },
    { scope: "release", target: "8", field: "album" },
    { scope: "global_field", target: "", field: "tracknumber" },
  ]);
  const locked = (fileId: number, field: string) =>
    r.fields.find((f) => f.fileId === fileId && f.field === field)!.locked;
  assertEquals([locked(1, "title"), locked(2, "title")], [true, false]);
  assertEquals([locked(1, "genre"), locked(2, "genre")], [true, true]);
  assertEquals(locked(1, "album"), false, "a lock on another release does not apply");
  assertEquals([locked(1, "tracknumber"), locked(2, "tracknumber")], [true, true]);
});
