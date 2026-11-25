/** Seed, edit note and duplicate check for a release missing from MusicBrainz (§12, D52). */
import { assert, assertEquals } from "@std/assert";
import type { ReleaseQuery } from "../../server/providers/musicbrainz/client.ts";
import { findDuplicates } from "../../server/submission/duplicates.ts";
import { editNote, mergedFromMatches, seedFor } from "../../server/submission/seed.ts";
import { VERSION } from "../../server/version.ts";
import { MATCHES } from "./helpers.ts";

Deno.test("the seed: Harmony's release-editor fields, the return address in the path, Tagmonia's edit note", () => {
  const merged = mergedFromMatches(MATCHES, "deezer");
  const seed = seedFor(merged, {
    returnUrl: new URL("https://tagmonia.example/mb/callback/7"),
    fetchedAt: Date.UTC(2026, 10, 25, 11, 31),
  });
  assertEquals(seed.name, "Ambient Piano Vol.1");
  assertEquals(seed["mediums.0.track.1.name"], "Peaceful Blue");
  assertEquals(seed.barcode, "196292081398");
  // Harmony replaces the query with lookup details: the submission id must survive in the path.
  assert(new URL(seed.redirect_uri).pathname === "/mb/callback/7", seed.redirect_uri);
  assertEquals(seed.edit_note.split("\n"), [
    `Imported with Tagmonia ${VERSION} (https://github.com/cdalamagkas/tagmonia), using data from:`,
    "* Deezer: https://www.deezer.com/album/1 (API: https://api.deezer.com/album/1)",
    "* iTunes: https://www.itunes.com/album/1 (API: https://api.itunes.com/album/1)",
    "Data fetched 2026-11-25 11:31 UTC; merged with Harmony and reviewed by the editor before submission.",
  ]);
  assertEquals(editNote(merged, 0).includes("Harmony ("), false, "Tagmonia's note, not Harmony's");
});

Deno.test("the seed refuses when the linked provider's release is no longer stored", () => {
  let message = "";
  try {
    mergedFromMatches(MATCHES.filter((m) => m.provider !== "deezer"), "deezer");
  } catch (e) {
    message = (e as Error).message;
  }
  assert(message.includes("build it again"), message);
});

Deno.test("duplicates: by barcode (both spellings), by linked provider pages, by close title matches; always fresh", async () => {
  const asked: string[] = [];
  const ages: (number | undefined)[] = [];
  const hit = (id: string, score: number, tracks: number) => ({
    id,
    score,
    title: "Ambient Piano Vol.1",
    "artist-credit": [{
      name: "Niklas Blumenthaler",
      joinphrase: "",
      artist: { id: "a", name: "Niklas Blumenthaler" },
    }],
    "track-count": tracks,
  });
  const mb = {
    searchReleases: (q: ReleaseQuery, o?: { maxAgeMs?: number }) => {
      asked.push(JSON.stringify(q));
      ages.push(o?.maxAgeMs);
      const value = q.barcode === "0196292081398"
        ? [hit("same-barcode", 100, 2)]
        : q.release
        ? [hit("same-text", 100, 2), hit("other-edition", 100, 12), hit("weak", 60, 2), hit("same-barcode", 95, 2)]
        : [];
      return Promise.resolve({ value: value as never, snapshotId: 0 });
    },
    releasesForUrl: (url: string, o?: { maxAgeMs?: number }) => {
      asked.push(url);
      ages.push(o?.maxAgeMs);
      return Promise.resolve({
        value: url.includes("deezer") ? [{ id: "linked", title: "Ambient Piano Vol.1" }] : [],
        snapshotId: 0,
      });
    },
  };
  const d = await findDuplicates(mb, {
    title: "Ambient Piano Vol.1",
    artist: "Niklas Blumenthaler",
    barcode: "196292081398",
    trackCount: 2,
    urls: [{ name: "Deezer", url: "https://www.deezer.com/album/1" }, { name: "iTunes", url: "https://x/1" }],
  });
  assertEquals(d.map((x) => [x.mbid, x.reasons]), [
    ["same-barcode", ["same barcode", "same title, artist and tracks"]],
    ["linked", ["linked to the Deezer page"]],
    ["same-text", ["same title, artist and tracks"]],
  ]);
  assertEquals(asked.length, 5, "two barcode spellings, two pages, one text search");
  assertEquals(ages.every((a) => a === 0), true, "never answered from the cache");
});
