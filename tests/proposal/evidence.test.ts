/** YouTube as evidence (§9.5, D55): it fills only gaps and never makes a conflict. */
import { assertEquals } from "@std/assert";
import { applyEvidence, type TagsWithProvenance, youtubeMatch } from "../../server/proposal/evidence.ts";
import type { YouTubeEvidence } from "../../server/providers/youtube.ts";

function evidence(over: Partial<YouTubeEvidence> = {}): YouTubeEvidence {
  return {
    kind: "playlist",
    url: "https://www.youtube.com/playlist?list=OLAK5uy_test0001",
    title: "Album - Ambient Piano Vol.1",
    channel: null,
    tracks: [1, 2, 3].map((i) => ({ videoId: `v${i}`, title: `t${i}`, durationMs: 1000, name: null, artists: [] })),
    label: "LKult",
    date: "2021-07-23",
    album: null,
    providedBy: "DistroKid",
    ...over,
  };
}

function tags(release: TagsWithProvenance["release"]): TagsWithProvenance {
  const provenance = new Map();
  for (const [field, value] of Object.entries(release)) {
    provenance.set(field, { origin: "musicbrainz", sources: [{ provider: "musicbrainz", value }], conflict: false });
  }
  return { release: { ...release }, provenance };
}

Deno.test("a playlist with as many videos as tracks is found; another count is another edition, unused", () => {
  assertEquals(youtubeMatch(evidence(), 3).status, "found");
  const other = youtubeMatch(evidence(), 4);
  assertEquals([other.status, other.reason], ["different_edition", "3 videos; the release has 4 tracks"]);
  const t = tags({});
  applyEvidence(t, other);
  assertEquals([t.release, t.provenance.size], [{}, 0]);
});

Deno.test("it fills an empty date and label, marked as YouTube's", () => {
  const t = tags({});
  applyEvidence(t, youtubeMatch(evidence(), 3));
  assertEquals(t.release, { date: "2021-07-23", label: ["LKult"] });
  assertEquals(t.provenance.get("date"), {
    origin: "youtube",
    sources: [{ provider: "youtube", value: "2021-07-23" }],
    conflict: false,
  });
});

Deno.test("it refines a year-only date of the same year; otherwise it is only listed, never a conflict", () => {
  const year = tags({ date: "2021", label: ["Other Label"] });
  applyEvidence(year, youtubeMatch(evidence(), 3));
  assertEquals(year.release, { date: "2021-07-23", label: ["Other Label"] });
  assertEquals(year.provenance.get("date")?.origin, "youtube");
  assertEquals(year.provenance.get("label"), {
    origin: "musicbrainz",
    sources: [{ provider: "musicbrainz", value: ["Other Label"] }, { provider: "youtube", value: ["LKult"] }],
    conflict: false,
  });

  const other = tags({ date: "2019-01-01" });
  applyEvidence(other, youtubeMatch(evidence(), 3));
  assertEquals(other.release.date, "2019-01-01");
  assertEquals(other.provenance.get("date")?.conflict, false);
  assertEquals(other.provenance.get("date")?.sources.map((s) => s.provider), ["musicbrainz", "youtube"]);
});

Deno.test("uploads that are not auto-generated say nothing", () => {
  const t = tags({});
  applyEvidence(t, youtubeMatch(evidence({ label: null, date: null }), 3));
  assertEquals(t.release, {});
});
