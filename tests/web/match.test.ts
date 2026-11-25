/** The Match tab's model: the link box, the source, certainty, the mapping and the alternatives (PR 3, D53). */
import { assertEquals } from "@std/assert";
import type { EditionDto, IdentificationDto, MatchDto, ProposalDto } from "../../shared/types.ts";
import { classifyLink, GOOD_FIT, mappingView, matchView } from "../../web/src/release/match.ts";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const D = "dddddddd-0000-4000-8000-000000000004";

function match(mbid: string, over: Partial<MatchDto> = {}): MatchDto {
  return {
    rank: 1,
    releaseMbid: mbid,
    releaseGroupMbid: "rg",
    score: 1,
    method: "text",
    signals: { trackCount: 1, durations: 1, titles: 1, album: 1, artist: 1, fingerprint: null },
    coverage: 1,
    capped: false,
    identifierMatch: false,
    pinned: false,
    summary: {
      title: "T",
      artist: "Ar",
      date: null,
      country: null,
      labels: [],
      catalogNumbers: [],
      barcode: null,
      format: "CD",
      trackCount: 2,
      status: null,
    },
    mapping: {
      pairs: [
        { fileId: 1, medium: 1, position: 1, trackId: "t1", recordingId: "r1", cost: 0 },
        { fileId: 2, medium: 1, position: 2, trackId: "t2", recordingId: "r2", cost: 0.05 },
      ],
      unmappedFiles: [],
      unmatchedTracks: [],
    },
    ...over,
  };
}

const edition = (mbid: string) =>
  ({ releaseMbid: mbid, summary: match(mbid).summary, examined: true, score: 0.9 }) as EditionDto;

function ident(over: Partial<IdentificationDto> = {}): IdentificationDto {
  return {
    status: "matched",
    identifiedAt: 1,
    error: null,
    stale: false,
    matches: [match(A), match(B, { score: 0.8 }), match(C, { score: 0.5 })],
    editions: [edition(A), edition(B)],
    thresholds: { auto: 0.92, review: 0.7 },
    job: null,
    ...over,
  };
}

const proposal = (over: Partial<ProposalDto>) =>
  ({ releaseMbid: null, sourceUrl: null, mbServer: null, chosenBy: "auto", ...over }) as ProposalDto;

Deno.test("one link box: MusicBrainz releases and bare IDs; any other https link goes to the server", () => {
  assertEquals(classifyLink(` https://musicbrainz.org/release/${A} `), { kind: "musicbrainz", mbid: A });
  assertEquals(classifyLink(`https://musicbrainz.org/release/${A.toUpperCase()}/discids`), {
    kind: "musicbrainz",
    mbid: A,
  });
  assertEquals(classifyLink(A.toUpperCase()), { kind: "musicbrainz", mbid: A });
  assertEquals(classifyLink("https://www.deezer.com/album/771280491"), {
    kind: "provider",
    url: "https://www.deezer.com/album/771280491",
  });
  assertEquals(classifyLink("https://music.youtube.com/playlist?list=OLAK5uy_abcdefghijk").kind, "youtube");
  assertEquals(classifyLink("https://youtu.be/jNQXAC9IVRw").kind, "youtube");
  assertEquals(classifyLink("https://notyoutube.com/watch?v=jNQXAC9IVRw").kind, "provider", "the server refuses it");
  assertEquals(classifyLink(`https://musicbrainz.org/release-group/${A}`).kind, "invalid");
  assertEquals(classifyLink("http://www.deezer.com/album/1").kind, "invalid");
  assertEquals(classifyLink("Ambient Piano").kind, "invalid");
});

Deno.test("the chosen MusicBrainz release: its match, its other editions, the other releases", () => {
  const v = matchView(ident(), proposal({ releaseMbid: B, chosenBy: "user" }));
  assertEquals(v.source.kind === "musicbrainz" ? [v.source.mbid, v.source.match?.releaseMbid] : null, [B, B]);
  assertEquals(v.subject?.releaseMbid, B);
  assertEquals(v.editions.map((e) => e.releaseMbid), [A], "the chosen one is not listed again");
  assertEquals(v.others.map((m) => m.releaseMbid), [C], "editions are not repeated as other releases");
  assertEquals(v.uncertain, false, "the user chose it, even at 80%");
});

Deno.test("certainty: an automatic choice below the threshold or held for review opens its evidence", () => {
  assertEquals(matchView(ident(), proposal({ releaseMbid: A })).uncertain, false);
  const low = ident({ matches: [match(A, { score: 0.85 })] });
  assertEquals(matchView(low, proposal({ releaseMbid: A })).uncertain, true);
  const capped = ident({ matches: [match(A, { capped: true })] });
  assertEquals(matchView(capped, proposal({ releaseMbid: A })).uncertain, true);
  const named = ident({ matches: [match(A, { score: 0.85, pinned: true })] });
  assertEquals(matchView(named, proposal({ releaseMbid: A })).uncertain, false, "the files name it");
  // No proposal yet, several releases fit: the best is a suggestion and it is uncertain.
  const v = matchView(ident({ status: "needs_review" }), null);
  assertEquals([v.source.kind, v.subject?.releaseMbid, v.uncertain], ["none", A, true]);
});

Deno.test("tags from a provider: no MusicBrainz subject; the old guesses are alternatives, behind a fold", () => {
  const v = matchView(ident({ status: "no_match" }), proposal({ sourceUrl: "https://www.deezer.com/album/1" }));
  assertEquals([v.source.kind, v.subject, v.mapping], ["provider", null, null]);
  assertEquals(v.others.map((m) => m.releaseMbid), [C]);
});

Deno.test("nothing fits: no suggestion headlines the tab; every guess is an alternative, folded", () => {
  const v = matchView(ident({ status: "no_match", editions: [] }), null);
  assertEquals([v.source.kind, v.subject, v.mapping, v.uncertain], ["none", null, null, false]);
  assertEquals(v.others.map((m) => m.releaseMbid), [A, B, C], "the best guess is listed with the others");
});

Deno.test("the mapping: one line when every file fits; otherwise only what is off", () => {
  const good = mappingView(match(A));
  assertEquals([good.allGood, good.files, good.weak.length], [true, 2, 0]);
  const off = mappingView(match(A, {
    mapping: {
      pairs: [
        { fileId: 2, medium: 1, position: 2, trackId: "t2", recordingId: "r2", cost: 1 - GOOD_FIT + 0.01 },
        { fileId: 1, medium: 1, position: 1, trackId: "t1", recordingId: "r1", cost: 0 },
      ],
      unmappedFiles: [3],
      unmatchedTracks: [{ medium: 1, position: 3, title: "Bonus" }],
    },
  }));
  assertEquals(
    [off.allGood, off.files, off.weak.map((p) => p.position), off.unmappedFiles, off.unmatchedTracks.length],
    [
      false,
      3,
      [2],
      [3],
      1,
    ],
  );
});

Deno.test("a lone release has no edition list; other releases are capped at five", () => {
  const many = ident({ editions: [edition(A)], matches: [A, B, C, D, "e", "f", "g"].map((id) => match(id)) });
  const v = matchView(many, proposal({ releaseMbid: A }));
  assertEquals([v.editions.length, v.others.length], [0, 5]);
});
