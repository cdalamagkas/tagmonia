/** MusicBrainz → canonical tags on the recorded Karajan Beethoven 5 (full relationships, §6.3). */
import { assertEquals } from "@std/assert";
import {
  mergeGenres,
  missingParentWorks,
  performerRoles,
  tagsFromMusicBrainz,
} from "../../server/proposal/musicbrainz_tags.ts";
import type { MbRelation } from "../../server/providers/musicbrainz/schema.ts";
import { BEETHOVEN_5, loadRelease, loadWork, SYMPHONY_5 } from "../identify/helpers.ts";

const release = await loadRelease(BEETHOVEN_5);
const symphony = await loadWork(SYMPHONY_5);

Deno.test("release-level tags follow Picard: credits, sort names, dates, label, type, script", () => {
  const { release: r } = tagsFromMusicBrainz({ release });
  assertEquals(r.album, "Symphony no. 5");
  assertEquals(r.albumartist, "Beethoven; Berlin Philharmonic Orchestra, Herbert von Karajan");
  assertEquals(r.albumartists, ["Beethoven", "Berlin Philharmonic Orchestra", "Herbert von Karajan"]);
  assertEquals(r.albumartistsort, "Beethoven, Ludwig van; Berliner Philharmoniker, Karajan, Herbert von");
  assertEquals([r.date, r.originaldate, r.releasecountry, r.releasestatus], ["1978", "1978", "GB", "official"]);
  assertEquals([r.catalognumber, r.releasetype, r.script, r.language], [["2542 105"], ["album"], "Latn", "eng"]);
  assertEquals([r.musicbrainz_albumid, r.musicbrainz_releasegroupid], [BEETHOVEN_5, release["release-group"]!.id]);
  // No barcode on this release: nothing to propose, never an empty value.
  assertEquals("barcode" in r, false);
});

Deno.test("track tags carry positions, recording and release-track MBIDs, ISRC and medium format", () => {
  const t = [...tagsFromMusicBrainz({ release }).tracks.values()][0];
  assertEquals([t.title, t.tracknumber, t.totaltracks, t.discnumber, t.totaldiscs], [
    "Symphony no. 5 in C minor, op. 67: I. Allegro con brio",
    1,
    4,
    1,
    1,
  ]);
  assertEquals([t.media, t.isrc], ['12" Vinyl', ["DEF056201641"]]);
  assertEquals(t.musicbrainz_trackid, release.media[0].tracks![0].id);
  assertEquals(t.musicbrainz_recordingid, release.media[0].tracks![0].recording.id);
});

Deno.test("classical credits: composer, conductor, orchestra, work and movement from the parent work (§6.3)", () => {
  const t = [...tagsFromMusicBrainz({ release, parentWorks: new Map([[SYMPHONY_5, symphony]]) }).tracks.values()][1];
  assertEquals([t.composer, t.composersort], [["Ludwig van Beethoven"], ["Beethoven, Ludwig van"]]);
  assertEquals([t.conductor, t.performer], [["Herbert von Karajan"], { orchestra: ["Berliner Philharmoniker"] }]);
  assertEquals(t.work, "Symphony no. 5 in C minor, op. 67");
  assertEquals([t.movement, t.movementnumber, t.movementtotal, t.showmovement], ["II. Andante con moto", 2, 4, 1]);
});

Deno.test("without the parent work looked up, the movement total is left out rather than guessed", () => {
  const t = [...tagsFromMusicBrainz({ release }).tracks.values()][0];
  assertEquals([t.movementnumber, t.movementtotal], [1, undefined]);
  assertEquals(missingParentWorks(release, new Map()), [SYMPHONY_5]);
  assertEquals(missingParentWorks(release, new Map([[SYMPHONY_5, symphony]])), []);
});

Deno.test("genres: release and release-group votes merged, top 5, stable order (D27)", () => {
  const g = (name: string, count: number) => ({ id: name, name, count });
  const genres = {
    id: BEETHOVEN_5,
    genres: [g("classical", 1)],
    "release-group": { genres: [g("romantic", 3), g("classical", 4), g("symphony", 1), g("a", 1), g("b", 1)] },
    relations: [],
  };
  assertEquals(mergeGenres(genres, 3), ["classical", "romantic", "a"]);
  assertEquals(mergeGenres(null), []);
});

Deno.test("performer roles read like Picard's: instruments, vocals, orchestra, modifiers first", () => {
  const rel = (type: string, attributes: string[]) => ({ type, "target-type": "artist", attributes }) as MbRelation;
  assertEquals(performerRoles(rel("instrument", ["piano", "harpsichord"])), ["piano", "harpsichord"]);
  assertEquals(performerRoles(rel("instrument", ["guest", "violin"])), ["guest violin"]);
  assertEquals(performerRoles(rel("vocal", ["soprano vocals"])), ["soprano vocals"]);
  assertEquals(performerRoles(rel("vocal", ["lead"])), ["lead vocals"]);
  assertEquals(performerRoles(rel("vocal", [])), ["vocals"]);
  assertEquals(performerRoles(rel("performing orchestra", [])), ["orchestra"]);
  assertEquals(performerRoles(rel("producer", [])), []);
});

Deno.test('"[none]" is not a catalog number', () => {
  const r = structuredClone(release);
  r["label-info"] = [{ "catalog-number": "[none]", label: { id: r["label-info"]![0].label!.id, name: "DG" } }];
  assertEquals("catalognumber" in tagsFromMusicBrainz({ release: r }).release, false);
});
