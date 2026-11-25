/** Seed, edit note and duplicate check for a release missing from MusicBrainz (§12, D52). */
import { assert, assertEquals } from "@std/assert";
import type { ReleaseQuery } from "../../server/providers/musicbrainz/client.ts";
import { findDuplicates } from "../../server/submission/duplicates.ts";
import { artistCreateUrl, collectArtists, resolveArtists, withArtistMbids } from "../../server/submission/artists.ts";
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

Deno.test("artists: collected once across release and tracks, linked by MBID in the seed, seeded for creation", () => {
  const merged = mergedFromMatches(MATCHES, "deezer");
  const withGuest = {
    ...merged,
    media: merged.media.map((m) => ({
      ...m,
      tracklist: m.tracklist.map((t, i) =>
        i === 1 ? { ...t, artists: [...merged.artists, { name: "Guest", creditedName: "Guest" }] } : t
      ),
    })),
  };
  const links = (a: { name: string }) =>
    a.name === "Guest" ? [] : [{ url: "https://www.deezer.com/artist/9", linkTypeIds: [194] }];
  assertEquals(collectArtists(withGuest, links).map((a) => [a.name, a.links.length]), [["Niklas Blumenthaler", 1], [
    "Guest",
    0,
  ]]);

  const linked = withArtistMbids(withGuest, [
    {
      name: "Niklas Blumenthaler",
      links: [],
      mbid: "m1",
      via: "link",
      suggestions: [],
      createUrl: null,
      addLinksUrl: null,
    },
  ]);
  const seed = seedFor(linked, { returnUrl: new URL("https://t.example/mb/callback/1"), fetchedAt: 0 });
  assertEquals(seed["artist_credit.names.0.mbid"], "m1");
  assertEquals(seed["mediums.0.track.1.artist_credit.names.0.mbid"], "m1");
  assertEquals(seed["mediums.0.track.1.artist_credit.names.1.artist.name"], "Guest", "unknown artists stay names");

  const url = new URL(artistCreateUrl("https://test.musicbrainz.org", {
    name: "Niklas Blumenthaler",
    links: [{ url: "https://www.deezer.com/artist/9", linkTypeIds: [194] }, {
      url: "https://x.test/a",
      linkTypeIds: [],
    }],
  }, "https://www.deezer.com/album/1"));
  assertEquals(url.origin + url.pathname, "https://test.musicbrainz.org/artist/create");
  assertEquals([...url.searchParams.keys()], [
    "edit-artist.name",
    "edit-artist.url.0.text",
    "edit-artist.url.0.link_type_id",
    "edit-artist.url.1.text",
    "edit-artist.edit_note",
  ]);
});

Deno.test("the test server's search misses an artist: musicbrainz.org's search suggests it if the test server has it", async () => {
  // Seen live: test.musicbrainz.org's search found 0 for "Matthias Krauss"; musicbrainz.org found him, same MBID.
  const KRAUSS = "a0de8661-3d7c-4373-8971-7f429235d141";
  const asked: string[] = [];
  const test = {
    artistsForUrl: () => Promise.resolve({ value: [], snapshotId: 0 }),
    searchArtists: () => Promise.resolve({ value: [], snapshotId: 0 }),
    lookupArtist: (mbid: string) => {
      asked.push(`exists ${mbid}`);
      return Promise.resolve(mbid === KRAUSS ? { id: KRAUSS, name: "Matthias Krauss" } : null);
    },
  };
  const production = {
    searchArtists: () =>
      Promise.resolve({
        value: [
          { id: KRAUSS, name: "Matthias Krauss", score: 100, country: "DE" },
          { id: "only-on-production", name: "Matthias Krauss", score: 95 },
        ],
        snapshotId: 0,
      }),
  };
  const [r] = await resolveArtists(test, [{ name: "Matthias Krauss", links: [] }], {
    server: "https://test.musicbrainz.org",
    releaseUrl: "https://www.deezer.com/album/1",
    chosen: {},
    fallbackSearch: production,
  });
  assertEquals(r.suggestions.map((g) => [g.mbid, g.country]), [[KRAUSS, "DE"]]);
  assertEquals(asked, [`exists ${KRAUSS}`, "exists only-on-production"]);

  // Without the fallback (musicbrainz.org itself), nothing extra is asked.
  const [plain] = await resolveArtists(test, [{ name: "Matthias Krauss", links: [] }], {
    server: "https://musicbrainz.org",
    releaseUrl: "https://www.deezer.com/album/1",
    chosen: {},
  });
  assertEquals(plain.suggestions, []);
});
