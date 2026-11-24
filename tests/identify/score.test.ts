import { assert, assertEquals } from "@std/assert";
import { editionsOf, rank, verdict } from "../../server/identify/editions.ts";
import { toReleaseView } from "../../server/identify/release.ts";
import { DEFAULT_SCORING, durationSimilarity, mapTracks, scoreRelease } from "../../server/identify/score.ts";
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

Deno.test("a missing track lowers the score and is listed as unmatched", () => {
  const ev = evidenceFor(release);
  ev.files = ev.files.slice(0, 3);
  const s = scoreRelease(ev, view);
  assertEquals(s.signals.trackCount, 0.5);
  assertEquals(s.mapping.unmatchedTracks.map((t) => t.position), [4]);
  assert(s.score < DEFAULT_SCORING.autoThreshold, `score ${s.score}`);
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

Deno.test("an exact catalog number sets the 0.95 floor, but only with a plausible track count", () => {
  const ev = evidenceFor(release, { album: "Fünfte", albumArtist: "Karajan", catalogNumbers: ["2542-105"] });
  ev.files = ev.files.map((f) => ({ ...f, durationMs: (f.durationMs ?? 0) + 9000 }));
  const s = scoreRelease(ev, view);
  assertEquals(s.identifierMatch, true);
  assertEquals(s.score, 0.95);

  const few = { ...ev, files: ev.files.slice(0, 1) };
  assert(scoreRelease(few, view).score < 0.95);
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
  assertEquals([original.signals.trackCount, withBonus.signals.trackCount], [0.5, 0.5]);
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
