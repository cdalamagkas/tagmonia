/** Add to MusicBrainz as a step panel: the steps and the artist rows (PR 4, D53). */
import { assertEquals } from "@std/assert";
import type { SubmissionArtistDto, SubmissionDto } from "../../shared/types.ts";
import { artistRow, stepsView } from "../../web/src/release/submission.ts";

const TEST = "https://test.musicbrainz.org";
const A = "aaaaaaaa-0000-4000-8000-000000000001";

function artist(over: Partial<SubmissionArtistDto> = {}): SubmissionArtistDto {
  return {
    name: "Niklas",
    links: [],
    mbid: A,
    via: "link",
    suggestions: [],
    createUrl: null,
    addLinksUrl: null,
    ...over,
  };
}

function sub(over: Partial<SubmissionDto> = {}): SubmissionDto {
  return {
    id: 1,
    candidateId: 1,
    proposalId: 1,
    server: TEST,
    state: "ready",
    duplicates: [],
    artists: [artist()],
    releaseMbid: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
    followUps: null,
    ...over,
  };
}

const dup = {
  mbid: A,
  title: "T",
  artist: null,
  date: null,
  country: null,
  barcode: null,
  trackCount: null,
  reasons: ["same barcode"],
};

Deno.test("the steps: check first; artists and duplicates are skipped when there is nothing to do", () => {
  for (const s of [null, sub({ state: "abandoned" }), sub({ state: "checking" }), sub({ state: "failed" })]) {
    assertEquals(stepsView(s).current, "check");
  }
  const clear = stepsView(sub());
  assertEquals([clear.current, clear.states.artists, clear.states.duplicates], ["editor", "skipped", "skipped"]);

  const unlinked = sub({ artists: [artist(), artist({ name: "Matthias", mbid: null, via: null })], duplicates: [dup] });
  const v = stepsView(unlinked);
  assertEquals([v.current, v.states.check, v.states.duplicates, v.states.editor], ["artists", "done", "todo", "todo"]);

  // Linked by hand or by name: the step was not skipped, it was done.
  const named = stepsView(sub({ artists: [artist({ via: "name" })], duplicates: [dup] }));
  assertEquals([named.current, named.states.artists], ["duplicates", "done"]);

  assertEquals(stepsView(sub({ state: "seeded", duplicates: [dup] })).current, "editor");
  const unfinished = stepsView(sub({ state: "seeded", artists: [artist({ mbid: null, via: null })] }));
  assertEquals(
    [unfinished.current, unfinished.states.artists],
    ["editor", "todo"],
    "an artist still to add is no tick",
  );
  assertEquals(stepsView(sub({ state: "verifying" })).current, "editor");
  const done = stepsView(sub({ state: "returned" }));
  assertEquals([done.current, done.states.editor], ["done", "done"]);
});

Deno.test("one row format per artist: the status says which action follows", () => {
  const rows = [
    artist(),
    artist({ via: "chosen" }),
    artist({ via: "name" }),
    artist({
      mbid: null,
      via: null,
      suggestions: [{ mbid: A, name: "N", disambiguation: null, country: null, score: 1 }],
    }),
    artist({ mbid: null, via: null }),
  ].map((a) => artistRow(a, TEST));
  assertEquals(rows.map((r) => [r.status, r.label, r.ok]), [
    ["link", "found by its provider page", true],
    ["chosen", "your choice", true],
    ["name", "same name, check it", true],
    ["unlinked", "not linked yet", false],
    ["missing", "not on test.musicbrainz.org", false],
  ]);
  assertEquals(rows[0].url, `${TEST}/artist/${A}`);
  assertEquals(rows[4].url, null);
});
