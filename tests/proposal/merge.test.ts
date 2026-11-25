/** Merging Deezer, iTunes and Discogs into MusicBrainz's proposal by precedence (§10.3, D48). */
import { assert, assertEquals } from "@std/assert";
import type { ProviderMatch } from "../../server/providers/enrichment.ts";
import type { HarmonizedRelease } from "../../server/providers/harmony_adapter.ts";
import { buildFieldProposals } from "../../server/proposal/build.ts";
import { mergeProviders } from "../../server/proposal/merge.ts";
import { tagsFromMusicBrainz } from "../../server/proposal/musicbrainz_tags.ts";
import { BEETHOVEN_5, loadRelease } from "../identify/helpers.ts";

// DG 2542 105: date "1978", catalog number "2542 105", no barcode, an ISRC on every track.
const release = await loadRelease(BEETHOVEN_5);
const mb = tagsFromMusicBrainz({ release });
const trackIds = release.media[0].tracks!.map((t) => t.id);

function harmony(opts: {
  id?: string;
  date?: { year?: number; month?: number; day?: number };
  labels?: { name?: string; catalogNumber?: string }[];
  gtin?: string;
  isrcs?: (string | undefined)[];
}): HarmonizedRelease {
  return {
    title: "Symphony no. 5",
    artists: [],
    externalLinks: [],
    gtin: opts.gtin,
    releaseDate: opts.date && { date: opts.date, quality: "assumed-valid" },
    labels: opts.labels,
    media: [{ tracklist: trackIds.map((_, i) => ({ title: `t${i}`, isrc: opts.isrcs?.[i] })) }],
    info: { providers: [{ name: "X", internalName: "x", id: opts.id ?? "1", url: "https://x.test" }], messages: [] },
  } as unknown as HarmonizedRelease;
}

const match = (provider: ProviderMatch["provider"], r: HarmonizedRelease, status: ProviderMatch["status"] = "found") =>
  ({ provider, status, via: "link", url: null, reason: null, release: r }) as ProviderMatch;

Deno.test("without other providers, MusicBrainz's values stand and nothing is marked", () => {
  const m = mergeProviders(mb, release, []);
  assertEquals(m.release, mb.release);
  assertEquals(m.provenance.get("date"), {
    origin: "musicbrainz",
    sources: [{ provider: "musicbrainz", value: "1978" }],
    conflict: false,
  });
});

Deno.test("a year-only date is refined by a fallback's full date for that year, and marked", () => {
  const m = mergeProviders(mb, release, [
    match("deezer", harmony({ date: { year: 1978 } })),
    match("discogs", harmony({ date: { year: 1978, month: 3, day: 9 } })),
  ]);
  assertEquals(m.release.date, "1978-03-09");
  const p = m.provenance.get("date")!;
  assertEquals([p.origin, p.conflict], ["discogs", false]);
});

Deno.test("a different year is a conflict, and MusicBrainz's value stays proposed", () => {
  const m = mergeProviders(mb, release, [match("discogs", harmony({ date: { year: 1977 } }))]);
  assertEquals(m.release.date, "1978");
  const p = m.provenance.get("date")!;
  assertEquals([p.origin, p.conflict, p.sources.length], ["musicbrainz", true, 2]);
});

Deno.test("a store's different year is no conflict: it is often the original release's date on a reissue", () => {
  const m = mergeProviders(mb, release, [match("deezer", harmony({ date: { year: 1963, month: 5, day: 1 } }))]);
  assertEquals(m.release.date, "1978");
  const p = m.provenance.get("date")!;
  assertEquals([p.origin, p.conflict, p.sources.length], ["musicbrainz", false, 2]);
});

Deno.test("Discogs fills a missing barcode; a different catalog number is a conflict, a respelled one is not", () => {
  const filled = mergeProviders(mb, release, [
    match(
      "discogs",
      harmony({ gtin: "028925421059", labels: [{ name: "Deutsche Grammophon", catalogNumber: "2542105" }] }),
    ),
  ]);
  assertEquals(filled.release.barcode, "028925421059");
  assertEquals(filled.provenance.get("barcode")!.origin, "discogs");
  // "2542105" is "2542 105" respelled: same catalog number.
  assertEquals(filled.provenance.get("catalognumber")!.conflict, false);

  const differs = mergeProviders(mb, release, [
    match("discogs", harmony({ labels: [{ name: "DG", catalogNumber: "2531 105" }] })),
  ]);
  assertEquals(differs.release.catalognumber, ["2542 105"]);
  assert(differs.provenance.get("catalognumber")!.conflict);
});

Deno.test("Deezer and iTunes never conflict with MusicBrainz on label, catalog number or barcode", () => {
  const m = mergeProviders(mb, release, [match("deezer", harmony({ gtin: "1", labels: [{ name: "Other" }] }))]);
  assertEquals(m.release.barcode, undefined);
  assertEquals(m.provenance.get("label")?.conflict ?? false, false);
});

Deno.test("ISRCs: missing ones are filled per track from Deezer, then iTunes; a different one is no conflict", () => {
  // Only track 1 keeps its MusicBrainz ISRC here.
  const partial = {
    release: mb.release,
    tracks: new Map([...mb.tracks].map(([id, t], i) => [id, i === 0 ? t : { ...t, isrc: undefined }])),
  };
  const m = mergeProviders(partial, release, [
    match("deezer", harmony({ isrcs: ["DEX000000001", undefined, "DEX000000003", undefined] })),
    match("itunes", harmony({ isrcs: [undefined, "ITX000000002", "ITX000000003", undefined] })),
  ]);
  const isrc = (i: number) => m.tracks.get(trackIds[i])!.isrc;
  assertEquals([isrc(0), isrc(1), isrc(2), isrc(3)], [["DEF056201641"], ["ITX000000002"], ["DEX000000003"], undefined]);
  assertEquals(m.provenance.get(`${trackIds[0]}:isrc`)!.conflict, false);
  assertEquals(m.provenance.get(`${trackIds[1]}:isrc`)!.origin, "itunes");
});

Deno.test("provider IDs come from their own provider", () => {
  const m = mergeProviders(mb, release, [
    match("deezer", harmony({ id: "302127" })),
    match("discogs", harmony({ id: "1234567" })),
  ]);
  assertEquals([m.release.deezer_album_id, m.release.discogs_release_id], ["302127", "1234567"]);
});

Deno.test("another edition never contributes", () => {
  const m = mergeProviders(mb, release, [
    match("discogs", harmony({ id: "9", gtin: "5", date: { year: 1990 } }), "different_edition"),
  ]);
  assertEquals(m.release, mb.release);
});

Deno.test("the builder carries origin, conflict and every source with whether it agrees", () => {
  const m = mergeProviders(mb, release, [
    match("discogs", harmony({ gtin: "028925421059", date: { year: 1977 } })),
  ]);
  const { fields } = buildFieldProposals({
    candidateId: 1,
    files: [{ id: 7, tags: {} }],
    mapping: [{ fileId: 7, trackId: trackIds[0] }],
    proposed: m,
    snapshotId: 3,
    locks: [],
    provenance: m.provenance,
  });
  const f = (name: string) => fields.find((x) => x.field === name)!;
  assertEquals([f("barcode").origin, f("barcode").conflict], ["discogs", false]);
  assertEquals(f("barcode").sources, [
    { provider: "discogs", value: "028925421059", snapshotId: null, agreesWithProposed: true },
  ]);
  assertEquals([f("date").origin, f("date").conflict], ["musicbrainz", true]);
  assertEquals(f("date").sources.map((s) => [s.provider, s.snapshotId, s.agreesWithProposed]), [
    ["musicbrainz", 3, true],
    ["discogs", null, false],
  ]);
  // Fields no provider touched keep the single MusicBrainz source.
  assertEquals([f("album").origin, f("album").sources.length], ["musicbrainz", 1]);
});

Deno.test("a refined date is written over a year-only one; a precise date in the file is never cut back", () => {
  const build = (fileDate: string, proposedDate: string) =>
    buildFieldProposals({
      candidateId: 1,
      files: [{ id: 7, tags: { date: fileDate } }],
      mapping: [{ fileId: 7, trackId: trackIds[0] }],
      proposed: { release: { date: proposedDate }, tracks: new Map([[trackIds[0], {}]]) },
      snapshotId: null,
      locks: [],
    }).fields.find((f) => f.field === "date")!.status;
  assertEquals(build("1978", "1978-03-09"), "changed");
  assertEquals(build("1978-03-09", "1978"), "unchanged");
  assertEquals(build("1978-03-09", "1978-03-09"), "unchanged");
});
