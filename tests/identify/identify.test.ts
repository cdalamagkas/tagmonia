/** The §8 identification order against an in-memory MusicBrainz (FakeMb). */
import { assert, assertEquals } from "@std/assert";
import { identify, queryFromFolder } from "../../server/identify/identify.ts";
import { BEETHOVEN_5, evidenceFor, FakeMb, filesFor, loadRelease, variant } from "./helpers.ts";

const base = await loadRelease(BEETHOVEN_5);
const CD = "00000000-0000-4000-8000-0000000000cd";
const OTHER = "00000000-0000-4000-8000-00000000000b";
const OLD = "00000000-0000-4000-8000-0000000000aa";

Deno.test("an existing MBID that fits the files is confirmed with one lookup and no search", async () => {
  const mb = new FakeMb([base]);
  const r = await identify(evidenceFor(base, { albumMbid: BEETHOVEN_5 }), mb, "Album");
  assertEquals(r.verdict, "matched");
  assertEquals(r.methodsTried, ["existing_mbid"]);
  assertEquals(mb.calls, [`lookup ${BEETHOVEN_5}`]);
  assertEquals(r.ranked[0].method, "existing_mbid");
});

Deno.test("a merged MBID is followed and reported as redirected", async () => {
  const mb = new FakeMb([base]);
  mb.merged.set(OLD, BEETHOVEN_5);
  const r = await identify(evidenceFor(base, { albumMbid: OLD }), mb, "Album");
  assertEquals(r.redirected, { from: OLD, to: BEETHOVEN_5 });
  assertEquals(r.ranked[0].releaseId, BEETHOVEN_5);
});

Deno.test("an existing MBID that does not fit falls through to text search", async () => {
  const wrong = variant(base, OTHER, { releaseGroup: crypto.randomUUID(), shiftMs: 60_000, title: "Something Else" });
  const mb = new FakeMb([base, wrong]);
  mb.search = () => [base];
  const r = await identify(evidenceFor(base, { albumMbid: OTHER }), mb, "Album");
  assertEquals(r.methodsTried, ["existing_mbid", "text"]);
  assertEquals(r.ranked[0].releaseId, BEETHOVEN_5);
  assertEquals(r.verdict, "matched");
});

Deno.test("two editions that fit equally well go to the edition picker", async () => {
  const cd = variant(base, CD, { format: "CD", country: "DE" });
  const mb = new FakeMb([base, cd]);
  mb.search = () => [base, cd];
  const r = await identify(evidenceFor(base), mb, "Album");
  assertEquals(r.verdict, "needs_review");
  assertEquals(new Set(r.ranked.slice(0, 2).map((m) => m.releaseId)), new Set([BEETHOVEN_5, CD]));
});

Deno.test("an edition whose durations differ loses clearly to the right one", async () => {
  const cd = variant(base, CD, { format: "CD", shiftMs: 20_000 });
  const mb = new FakeMb([base, cd]);
  mb.search = () => [cd, base];
  const r = await identify(evidenceFor(base), mb, "Album");
  assertEquals(r.verdict, "matched");
  assertEquals(r.ranked[0].releaseId, BEETHOVEN_5);
  assert(r.ranked[0].score - r.ranked[1].score > 0.03);
});

Deno.test("a barcode search comes before text search and stops when it is confident", async () => {
  const withBarcode = variant(base, CD, { barcode: "0028942541052" });
  const mb = new FakeMb([withBarcode]);
  mb.search = (q) => (q.barcode ? [withBarcode] : []);
  const r = await identify(evidenceFor(withBarcode, { barcode: "028942541052" }), mb, "Album");
  assertEquals(r.methodsTried, ["barcode"]);
  assertEquals(r.ranked[0].method, "barcode");
  assertEquals(r.ranked[0].identifierMatch, true);
});

Deno.test("untagged files are searched by folder name but never auto-matched on durations alone", async () => {
  const mb = new FakeMb([base]);
  const queries: unknown[] = [];
  mb.search = (q) => {
    queries.push(q);
    return [base];
  };
  const files = filesFor(base, { tagged: false });
  const r = await identify({ files }, mb, "Classical/Karajan - Symphony no. 5 (1978) [FLAC]");
  assertEquals(queries[0], { release: "Symphony no. 5", artist: "Karajan", tracks: 4 });
  assertEquals(r.verdict, "needs_review");
  assertEquals(r.ranked[0].capped, true);
});

Deno.test("only the best pre-ranked search hits are looked up", async () => {
  const decoys = Array.from({ length: 8 }, (_, i) =>
    variant(base, `00000000-0000-4000-8000-00000000010${i}`, {
      releaseGroup: crypto.randomUUID(),
      title: `Unrelated ${i}`,
    }));
  const mb = new FakeMb([base, ...decoys]);
  mb.search = () => [...decoys, base];
  const r = await identify(evidenceFor(base), mb, "Album", undefined);
  assertEquals(mb.calls.filter((c) => c.startsWith("lookup")).length, 5);
  assertEquals(r.ranked[0].releaseId, BEETHOVEN_5);
});

Deno.test("a truncated release is skipped, not fatal", async () => {
  const cd = variant(base, CD);
  const mb = new FakeMb([base, cd]);
  mb.truncated.add(CD);
  mb.search = () => [cd, base];
  const r = await identify(evidenceFor(base), mb, "Album");
  assertEquals(r.skipped.map((s) => s.releaseId), [CD]);
  assertEquals(r.ranked.map((m) => m.releaseId), [BEETHOVEN_5]);
});

Deno.test("with no hits at all the verdict is no_match", async () => {
  const r = await identify(evidenceFor(base), new FakeMb(), "Album");
  assertEquals([r.verdict, r.ranked.length], ["no_match", 0]);
});

Deno.test("queryFromFolder reads 'Artist - Album (year) [tags]'", () => {
  assertEquals(queryFromFolder("Music/Daft Punk - Discovery (2001) [FLAC]"), {
    artist: "Daft Punk",
    album: "Discovery",
  });
  assertEquals(queryFromFolder("Discovery"), { album: "Discovery" });
  assertEquals(queryFromFolder(""), {});
});
