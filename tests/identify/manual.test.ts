import { assertEquals } from "@std/assert";
import { releaseMbidFromInput } from "../../server/identify/manual.ts";
import { identify } from "../../server/identify/identify.ts";
import { BEETHOVEN_5, evidenceFor, FakeMb, loadRelease, variant } from "./helpers.ts";

const ID = "f390ab14-095d-42aa-ade3-fbbafe093f9d";

Deno.test("MusicBrainz release links and bare MBIDs are accepted", () => {
  assertEquals(releaseMbidFromInput(`https://musicbrainz.org/release/${ID}`), ID);
  assertEquals(releaseMbidFromInput(` https://beta.musicbrainz.org/release/${ID.toUpperCase()}/discids `), ID);
  assertEquals(releaseMbidFromInput(ID), ID);
});

Deno.test("anything that is not a MusicBrainz release link is refused before any request (§14.5)", () => {
  for (
    const bad of [
      `http://musicbrainz.org/release/${ID}`,
      `https://musicbrainz.org.evil.example/release/${ID}`,
      `https://user:pw@musicbrainz.org/release/${ID}`,
      `https://musicbrainz.org:8443/release/${ID}`,
      `https://musicbrainz.org/release-group/${ID}`,
      `https://musicbrainz.org/release/${ID}/../../admin`,
      "https://www.discogs.com/release/1234",
      "not a url",
      "",
    ]
  ) {
    assertEquals(releaseMbidFromInput(bad), null, bad);
  }
});

const base = await loadRelease(BEETHOVEN_5);

Deno.test("a manual choice is scored, pinned, and skips the automatic search", async () => {
  const mb = new FakeMb([base]);
  mb.search = () => {
    throw new Error("must not search");
  };
  const r = await identify(evidenceFor(base), mb, "Album", undefined, undefined, undefined, {
    manualMbid: BEETHOVEN_5,
  });
  assertEquals(r.methodsTried, ["manual"]);
  assertEquals([r.ranked[0].method, r.ranked[0].pinned, r.verdict], ["manual", true, "matched"]);
});

Deno.test("a manual choice that does not fit the files still shows as a poor match", async () => {
  const other = variant(base, "00000000-0000-4000-8000-00000000000b", {
    releaseGroup: crypto.randomUUID(),
    shiftMs: 90_000,
    title: "Something Else",
  });
  const mb = new FakeMb([base, other]);
  const r = await identify(evidenceFor(base), mb, "Album", undefined, undefined, undefined, {
    manualMbid: other.id,
  });
  assertEquals(r.ranked[0].releaseId, other.id);
  assertEquals(r.verdict === "matched", false);
});
