/** A release not on MusicBrainz as canonical tags, through Harmony's own merge (§10.4, D51). */
import { assertEquals } from "@std/assert";
import { type HarmonizedRelease, mergeProviderReleases } from "../../server/providers/harmony_adapter.ts";
import { providerReleaseView, providerTrackId, tagsFromProviders } from "../../server/proposal/harmony_tags.ts";

function release(
  provider: { name: string; internalName: string; id: string },
  opts: { date?: { year: number; month?: number; day?: number }; isrcs?: (string | undefined)[]; labels?: boolean },
): HarmonizedRelease {
  const isrc = (i: number) => opts.isrcs?.[i];
  return {
    title: "Night Ferry",
    artists: [{ name: "Ana Example", creditedName: "Ana Example", joinPhrase: " & " }, { name: "The Rowers" }],
    gtin: "0198765432109",
    externalLinks: [{ url: `https://example.test/${provider.internalName}`, types: ["free streaming"] }],
    status: "Official",
    types: ["Album"],
    releaseDate: opts.date ? { date: opts.date, quality: "assumed-valid" } : undefined,
    labels: opts.labels ? [{ name: "Harbour Records", catalogNumber: "HR-012" }] : undefined,
    media: [
      {
        number: 1,
        format: "Digital Media",
        tracklist: [
          { title: "Departure", number: 1, length: 201_000, isrc: isrc(0) },
          {
            title: "Open Water",
            number: 2,
            length: 245_500,
            isrc: isrc(1),
            artists: [{ name: "Ana Example", creditedName: "Ana Example", joinPhrase: " feat. " }, { name: "Guest" }],
          },
        ],
      },
      {
        number: 2,
        format: "Digital Media",
        tracklist: [{ title: "Return", number: 1, length: 180_000, isrc: isrc(2) }],
      },
    ],
    info: { providers: [{ ...provider, url: `https://example.test/${provider.id}` }], messages: [] },
  } as unknown as HarmonizedRelease;
}

const deezer = release({ name: "Deezer", internalName: "deezer", id: "4242" }, {
  date: { year: 2024 },
  isrcs: ["DEX111111111", undefined, undefined],
});
const itunes = release({ name: "iTunes", internalName: "itunes", id: "99" }, {
  date: { year: 2024, month: 3, day: 1 },
  isrcs: ["ITX111111111", "ITX222222222", "ITX333333333"],
  labels: true,
});

Deno.test("release and track tags from the linked provider, with credits, positions and provider IDs", () => {
  const merged = mergeProviderReleases({ Deezer: deezer, iTunes: itunes }, "Deezer");
  const t = tagsFromProviders(merged, "deezer");
  assertEquals(t.release.album, "Night Ferry");
  assertEquals([t.release.albumartist, t.release.albumartists], ["Ana Example & The Rowers", [
    "Ana Example",
    "The Rowers",
  ]]);
  assertEquals([t.release.barcode, t.release.releasestatus, t.release.releasetype], ["0198765432109", "official", [
    "album",
  ]]);
  assertEquals(t.release.deezer_album_id, "4242");
  assertEquals("musicbrainz_albumid" in t.release, false, "no MusicBrainz identifiers before the release exists there");
  const second = t.tracks.get(providerTrackId(1, 2))!;
  assertEquals([second.title, second.artist, second.artists], ["Open Water", "Ana Example feat. Guest", [
    "Ana Example",
    "Guest",
  ]]);
  const last = t.tracks.get(providerTrackId(2, 1))!;
  assertEquals([last.tracknumber, last.totaltracks, last.discnumber, last.totaldiscs, last.media], [
    1,
    1,
    2,
    2,
    "Digital Media",
  ]);
});

Deno.test("the linked provider wins; what it lacks is filled by another and marked so", () => {
  const merged = mergeProviderReleases({ Deezer: deezer, iTunes: itunes }, "Deezer");
  const t = tagsFromProviders(merged, "deezer");
  // Deezer has a date, so it is used; Deezer has no labels, so iTunes fills them.
  assertEquals([t.release.date, t.provenance.get("date")?.origin], ["2024", "deezer"]);
  assertEquals([t.release.label, t.release.catalognumber], [["Harbour Records"], ["HR-012"]]);
  assertEquals(t.provenance.get("label")?.origin, "itunes");
  assertEquals(t.provenance.get(`${providerTrackId(1, 1)}:title`)?.origin, "deezer");
});

Deno.test("the release view scores like a MusicBrainz one: media, positions, lengths", () => {
  const v = providerReleaseView(deezer, "https://example.test/4242");
  assertEquals(v.tracks.map((t) => [t.medium, t.position, t.lengthMs, t.trackId]), [
    [1, 1, 201_000, "p1-1"],
    [1, 2, 245_500, "p1-2"],
    [2, 1, 180_000, "p2-1"],
  ]);
  assertEquals([v.summary.title, v.summary.artist, v.summary.trackCount, v.summary.format], [
    "Night Ferry",
    "Ana Example & The Rowers",
    3,
    "2×Digital Media",
  ]);
});
