import { assert, assertEquals } from "@std/assert";
import { editionsOf, rank, verdict } from "../../server/identify/editions.ts";
import { toReleaseView } from "../../server/identify/release.ts";
import {
  declaredSize,
  DEFAULT_SCORING,
  durationSimilarity,
  mapTracks,
  scoreRelease,
  sizeAgreement,
} from "../../server/identify/score.ts";
import type { ScoredRelease } from "../../server/identify/types.ts";
import { BEETHOVEN_5, evidenceFor, filesFor, loadRelease, variant } from "./helpers.ts";

const release = await loadRelease(BEETHOVEN_5);
const view = toReleaseView(release);

Deno.test("the recorded release flattens to 4 tracks with an edition summary", () => {
  assertEquals(view.tracks.map((t) => t.position), [1, 2, 3, 4]);
  assertEquals(view.summary.format, '12" Vinyl');
  assertEquals(view.summary.catalogNumbers, ["2542 105"]);
  assertEquals(view.summary.labels, ["Deutsche Grammophon", "Deutsche Grammophon Accolade"]);
});

Deno.test("duration tolerance: within 3 s is a full match, 15 s off is none", () => {
  assertEquals(durationSimilarity(427_000, 429_900), 1);
  assertEquals(durationSimilarity(427_000, 442_000), 0);
  assertEquals(durationSimilarity(427_000, 436_000), 0.5);
});

Deno.test("a well-tagged rip of the release scores above the auto threshold", () => {
  const s = scoreRelease(evidenceFor(release), view);
  assert(s.score >= DEFAULT_SCORING.autoThreshold, `score ${s.score}`);
  assertEquals(s.signals.fingerprint, null, "no fingerprint evidence yet: excluded, not scored 0");
  assertEquals(s.coverage, 0.85);
  assertEquals(s.capped, false);
  assertEquals(s.mapping.pairs.map((p) => [p.fileId, p.position]), [[1, 1], [2, 2], [3, 3], [4, 4]]);
});

Deno.test("files in the wrong order without track numbers still map by duration and title", () => {
  const files = filesFor(release).map((f) => ({ ...f, tracknumber: undefined, discnumber: undefined }));
  const shuffled = [files[2], files[0], files[3], files[1]];
  const { mapping } = mapTracks(shuffled, view);
  assertEquals(
    mapping.pairs.map((p) => [p.fileId, p.position]).sort(),
    [[1, 1], [2, 2], [3, 3], [4, 4]],
  );
});

Deno.test("a missing track costs little and is listed as unmatched (D45)", () => {
  const full = scoreRelease(evidenceFor(release), view);
  const ev = evidenceFor(release);
  ev.files = ev.files.slice(0, 3);
  const s = scoreRelease(ev, view);
  assertEquals(s.signals.trackCount, 0.875, "3 of 4 tracks present");
  assertEquals(s.mapping.unmatchedTracks.map((t) => t.position), [4]);
  // Durations and titles describe the files: the fourth track's absence does not count against them.
  assertEquals([s.signals.durations, s.signals.titles], [full.signals.durations, full.signals.titles]);
  assert(s.score < full.score, `${s.score} vs ${full.score}`);
});

Deno.test("half an album still scores high enough to show, and the right release over a bigger edition (D45)", () => {
  const ev = evidenceFor(release);
  ev.files = ev.files.slice(2);
  const half = scoreRelease(ev, view);
  assertEquals(half.signals.trackCount, 0.75);
  assert(half.score >= 0.70, `half an album scores ${half.score}`);

  // An 8-track edition holding the same four tracks plus four more.
  const bigger = variant(release, "00000000-0000-4000-8000-0000000000b8");
  for (const t of release.media[0].tracks!) {
    bigger.media[0].tracks!.push({
      ...structuredClone(t),
      id: crypto.randomUUID(),
      position: t.position + 4,
      title: `Bonus ${t.position}`,
    });
  }
  bigger.media[0]["track-count"] = 8;
  const fullRip = evidenceFor(release);
  const right = scoreRelease(fullRip, view);
  const wrong = scoreRelease(fullRip, toReleaseView(bigger));
  assert(right.score - wrong.score > 0.03, `complete release ${right.score} vs bigger edition ${wrong.score}`);
});

Deno.test("an unrelated file is left unmapped instead of forced onto a track", () => {
  const ev = evidenceFor(release);
  ev.files[3] = { fileId: 4, path: "Album/04.flac", durationMs: 95_000, title: "Hidden Bonus Jingle", tracknumber: 9 };
  const s = scoreRelease(ev, view);
  assertEquals(s.mapping.unmappedFiles, [4]);
  assertEquals(s.mapping.unmatchedTracks.map((t) => t.position), [4]);
});

Deno.test("untagged files matched on durations alone are held below the auto threshold (D36)", () => {
  const files = filesFor(release, { tagged: false, jitterMs: 500 });
  const s = scoreRelease({ files }, view);
  assertEquals([s.signals.titles, s.signals.album, s.signals.artist], [null, null, null]);
  assert(s.coverage < DEFAULT_SCORING.minCoverage);
  assertEquals(s.capped, true);
  assertEquals(s.score, DEFAULT_SCORING.autoThreshold - 0.01);
});

Deno.test("an exact catalog number sets the 0.95 floor when the files belong to the release", () => {
  const ev = evidenceFor(release, { album: "Fünfte", albumArtist: "Karajan", catalogNumbers: ["2542-105"] });
  ev.files = ev.files.map((f) => ({ ...f, durationMs: (f.durationMs ?? 0) + 9000 }));
  const s = scoreRelease(ev, view);
  assertEquals(s.identifierMatch, true);
  assertEquals(s.score, 0.95);

  // Part of the release is still the release (D45).
  assertEquals(scoreRelease({ ...ev, files: ev.files.slice(0, 1) }, view).score, 0.95);

  // Files that are not on the release get no floor, whatever their tags claim.
  const strangers = ev.files.map((f, i) => ({
    ...f,
    durationMs: 60_000 + i * 1000,
    title: `Something else ${i}`,
    tracknumber: 9 + i,
  }));
  assert(scoreRelease({ ...ev, files: strangers }, view).score < 0.95);
});

function scored(id: string, score: number, group: string | null): ScoredRelease {
  return { ...scoreRelease(evidenceFor(release), view), releaseId: id, score, releaseGroupId: group };
}

Deno.test("editions within 0.03 in one release group go to review, never silently picked (§8.2)", () => {
  const ranked = rank([scored("b", 0.95, "g1"), scored("a", 0.97, "g1"), scored("c", 0.80, "g1")]);
  assertEquals(ranked.map((r) => r.releaseId), ["a", "b", "c"]);
  assertEquals(editionsOf(ranked).map((r) => r.releaseId), ["a", "b"]);
  assertEquals(verdict(ranked), "needs_review");
});

Deno.test("verdict: clear winner is matched; near-tie across release groups needs review; weak is no match", () => {
  assertEquals(verdict(rank([scored("a", 0.97, "g1"), scored("b", 0.90, "g1")])), "matched");
  assertEquals(verdict(rank([scored("a", 0.97, "g1"), scored("b", 0.95, "g2")])), "needs_review");
  assertEquals(verdict(rank([scored("a", 0.80, "g1")])), "needs_review");
  assertEquals(verdict(rank([scored("a", 0.50, "g1")])), "no_match");
  assertEquals(verdict([]), "no_match");
});

Deno.test("variant editions keep the release group and change only what was asked", () => {
  const cd = variant(release, "00000000-0000-4000-8000-0000000000cd", { format: "CD", country: "DE" });
  assertEquals(cd["release-group"]?.id, release["release-group"]?.id);
  assertEquals(toReleaseView(cd).summary.format, "CD");
});

Deno.test("an extra file does not give a bonus edition an exact track count (D38)", () => {
  const ev = evidenceFor(release);
  ev.files.push({ fileId: 5, path: "Album/99.flac", durationMs: 75_000, title: "Hidden Track", tracknumber: 99 });
  // A 5-track edition whose bonus track has nothing to do with the hidden file.
  const bonus = variant(release, "00000000-0000-4000-8000-0000000000b5");
  bonus.media[0].tracks!.push({
    ...structuredClone(bonus.media[0].tracks![3]),
    id: crypto.randomUUID(),
    position: 5,
    number: "B3",
    title: "Coriolan Overture, op. 62",
    length: 480_000,
  });
  bonus.media[0]["track-count"] = 5;
  const original = scoreRelease(ev, view);
  const withBonus = scoreRelease(ev, toReleaseView(bonus));
  // One file not on either release halves both; the bonus edition also misses its fifth track (D45).
  assertEquals([original.signals.trackCount, withBonus.signals.trackCount], [0.5, 0.45]);
  assert(withBonus.score <= original.score, `${withBonus.score} > ${original.score}`);
});

Deno.test("a release the files name ranks first once confident and only competes with other named ones", () => {
  const named = { ...scored("n", 0.95, "g1"), pinned: true };
  const ranked = rank([scored("a", 1.0, "g1"), scored("b", 0.99, "g1"), named]);
  assertEquals(ranked[0].releaseId, "n");
  assertEquals(verdict(ranked), "matched");
  // Below the auto threshold, naming the release earns nothing.
  const weak = rank([scored("a", 0.9, "g1"), { ...scored("n", 0.85, "g1"), pinned: true }]);
  assertEquals([weak[0].releaseId, verdict(weak)], ["a", "needs_review"]);
  // Two named releases that tie still go to review.
  const two = rank([named, { ...scored("m", 0.96, "g1"), pinned: true }]);
  assertEquals(verdict(two), "needs_review");
});

// ---- the files' own "of N" tags (D45)

Deno.test("declared size: the majority total per disc and total discs; absent when no file says", () => {
  const f = (disc: number, total: number | undefined, discs?: number) => ({
    fileId: 1,
    path: "a.flac",
    durationMs: 1,
    discnumber: disc,
    totaltracks: total,
    totaldiscs: discs,
  });
  const d = declaredSize([f(1, 9, 2), f(1, 9, 2), f(1, 10, 2), f(2, 7, 2)])!;
  assertEquals([...d.perDisc], [[1, 9], [2, 7]]);
  assertEquals(d.discs, 2);
  assertEquals(declaredSize([f(1, undefined)]), null);
  assertEquals(sizeAgreement(d, [9, 7]), 1);
  assertEquals(sizeAgreement(d, [9]), 0.25, "disc 2 missing, and one disc instead of two");
  assertEquals(sizeAgreement(null, [9]), null);
});

Deno.test("one track tagged 'of 4' prefers the 4-track release over a 2-track single of the same name", () => {
  const one = { ...filesFor(release)[1], totaltracks: 4 };
  const single = variant(release, "00000000-0000-4000-8000-00000000005e", { releaseGroup: crypto.randomUUID() });
  single.media[0].tracks = single.media[0].tracks!.slice(0, 2);
  single.media[0]["track-count"] = 2;
  const ev = {
    files: [one],
    album: release.title,
    albumArtist: "Beethoven; Berlin Philharmonic Orchestra, Herbert von Karajan",
  };
  const album = scoreRelease(ev, view);
  const other = scoreRelease(ev, toReleaseView(single));
  assertEquals(album.signals.trackCount, 1);
  assert(album.score > other.score, `${album.score} vs ${other.score}`);
});

Deno.test("a file whose title contradicts a track is not mapped onto it by duration alone", () => {
  const ev = evidenceFor(release);
  // Same length as track 4, nothing else in common.
  ev.files[3] = {
    fileId: 4,
    path: "Album/99.flac",
    durationMs: release.media[0].tracks![3].length!,
    title: "Hidden Jingle",
    tracknumber: 99,
  };
  assertEquals(scoreRelease(ev, view).mapping.unmappedFiles, [4]);
  // A generic title is no contradiction: with its track number it still maps.
  ev.files[3] = { ...ev.files[3], title: "Track 04", tracknumber: 4 };
  assertEquals(scoreRelease(ev, view).mapping.unmappedFiles, []);
});
