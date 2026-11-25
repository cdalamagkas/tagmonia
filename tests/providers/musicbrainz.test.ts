/** MusicBrainz client against recorded responses (scripts/record_mb.ts); never the live API. */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { openMigratedDb } from "../../server/db/db.ts";
import {
  buildReleaseQuery,
  MusicBrainzClient,
  MusicBrainzResponseError,
} from "../../server/providers/musicbrainz/client.ts";
import { RateLimiter } from "../../server/providers/ratelimit.ts";
import { SnapshotCache } from "../../server/providers/snapshots.ts";
import { USER_AGENT } from "../../server/version.ts";
import { FakeClock } from "../helpers/fake_clock.ts";
import { replayFetch } from "../helpers/replay_fetch.ts";

const SIBELIUS = "f390ab14-095d-42aa-ade3-fbbafe093f9d";
const SYMPHONY_5 = "d03bff61-26fc-301b-98ac-4d8e85771cbc";
const MISSING = "00000000-0000-4000-8000-000000000000";

async function setup(fetchImpl?: typeof fetch) {
  const dir = await Deno.makeTempDir({ prefix: "tagmonia-mb-" });
  const db = await openMigratedDb(":memory:");
  const requests: URL[] = [];
  const agents: (string | null)[] = [];
  const replay = replayFetch(requests);
  const fetch: typeof globalThis.fetch = (input, init) => {
    agents.push(new Headers(init?.headers).get("user-agent"));
    return (fetchImpl ?? replay)(input, init);
  };
  const clock = new FakeClock();
  const client = new MusicBrainzClient({
    cache: new SnapshotCache(db, dir),
    http: { userAgent: USER_AGENT, limiter: new RateLimiter({ requests: 1, perMs: 1000 }, clock), fetch, clock },
  });
  return {
    client,
    requests,
    agents,
    [Symbol.asyncDispose]: async () => {
      db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test("buildReleaseQuery requires title/artist terms and only boosts the track count", () => {
  assertEquals(
    buildReleaseQuery({ release: "Symphony No. 5", artist: "Karajan", tracks: 4 }),
    '+release:"Symphony No. 5" +artist:"Karajan" tracks:4',
  );
  assertEquals(buildReleaseQuery({ tracks: 4 }), "");
  assertEquals(buildReleaseQuery({ release: "  " }), "");
});

Deno.test("buildReleaseQuery escapes quotes and backslashes inside phrases", () => {
  assertEquals(buildReleaseQuery({ release: 'Say "Hi" \\o/' }), '+release:"Say \\"Hi\\" \\\\o/"');
});

Deno.test("buildReleaseQuery fuzzy mode uses words, fuzzy only when long enough", () => {
  assertEquals(
    buildReleaseQuery({ release: "Dmumy", artist: "The Portishead", fuzzy: true }),
    "+release:(dmumy~) +artist:(the portishead~)",
  );
  assertEquals(buildReleaseQuery({ release: 'AND "x" OR', fuzzy: true }), "+release:(and x or)");
});

Deno.test("browseReleaseGroup pages until it has every release", async () => {
  const page = (offset: number, n: number, total: number) =>
    new Response(JSON.stringify({
      "release-count": total,
      "release-offset": offset,
      releases: Array.from({ length: n }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(offset + i).padStart(12, "0")}`,
        title: "T",
        media: [{ format: "CD", "track-count": 10 }],
      })),
    }));
  const pages = [page(0, 100, 130), page(100, 30, 130)];
  const urls: string[] = [];
  await using s = await setup((input) => {
    urls.push(String(input));
    return Promise.resolve(pages.shift()!);
  });
  const { value } = await s.client.browseReleaseGroup("d5cb0b10-ddeb-4879-b343-5af4e01712e3");
  assertEquals(value.length, 130);
  assertEquals(urls.map((u) => new URL(u).searchParams.get("offset")), ["0", "100"]);
  assertEquals(new URL(urls[0]).searchParams.get("release-group"), "d5cb0b10-ddeb-4879-b343-5af4e01712e3");
});

Deno.test("searchReleases returns scored releases", async () => {
  await using s = await setup();
  const { value, snapshotId } = await s.client.searchReleases({
    release: "Symphony No. 5",
    artist: "Karajan",
    tracks: 4,
  });
  assert(snapshotId > 0);
  assertEquals(value[0].id, SIBELIUS);
  assertEquals(value[0].score, 100);
  assertEquals(s.agents, [USER_AGENT]);
});

Deno.test("lookupRelease returns tracks with recording credits and performed works", async () => {
  await using s = await setup();
  const got = await s.client.lookupRelease(SIBELIUS);
  assert(got);
  const release = got.value;
  assertEquals(release.media.map((m) => m.tracks?.length), [4]);
  const rec = release.media[0].tracks![0].recording;
  const types = new Set(rec.relations?.map((r) => r.type));
  assert(types.has("conductor") && types.has("performing orchestra"), [...types].join(", "));
  const work = rec.relations?.find((r) => r.type === "performance")?.work;
  assert(work);
  const parent = work.relations?.find((r) => r.type === "parts" && r.direction === "backward");
  assertEquals(parent?.work?.id, SYMPHONY_5);
  assertEquals(parent?.["ordering-key"], 1);
});

Deno.test("lookupWork lists the parent work's ordered parts", async () => {
  await using s = await setup();
  const got = await s.client.lookupWork(SYMPHONY_5);
  const parts = got?.value.relations?.filter((r) => r.type === "parts" && r.direction === "forward");
  assertEquals(parts?.map((p) => p["ordering-key"]).sort(), [1, 2, 3, 4]);
});

Deno.test("a second lookup is served from the snapshot cache without a request", async () => {
  await using s = await setup();
  const a = await s.client.lookupRelease(SIBELIUS);
  const b = await s.client.lookupRelease(SIBELIUS);
  assertEquals(s.requests.length, 1);
  assertEquals(a?.snapshotId, b?.snapshotId);
});

Deno.test("an unknown MBID resolves to null, and the 404 is cached", async () => {
  await using s = await setup();
  assertEquals(await s.client.lookupRelease(MISSING), null);
  assertEquals(await s.client.lookupRelease(MISSING), null);
  assertEquals(s.requests.length, 1);
});

Deno.test("a malformed MBID is rejected before any request", async () => {
  await using s = await setup();
  await assertRejects(() => s.client.lookupRelease("../../admin"));
  assertEquals(s.requests.length, 0);
});

Deno.test("a truncated tracklist is an error and is not cached", async () => {
  const body = JSON.parse(
    await Deno.readTextFile(
      (await Array.fromAsync(Deno.readDir(new URL("../fixtures/snaps/musicbrainz.org/ws/2/release/", import.meta.url))))
        .filter((e) => e.name.startsWith(SIBELIUS))
        .map((e) => new URL(`../fixtures/snaps/musicbrainz.org/ws/2/release/${e.name}`, import.meta.url))[0],
    ),
  );
  body.media[0].tracks = body.media[0].tracks.slice(0, 2);
  await using s = await setup(() => Promise.resolve(new Response(JSON.stringify(body))));
  await assertRejects(() => s.client.lookupRelease(SIBELIUS), MusicBrainzResponseError, "got 2 of 4 tracks");
  await assertRejects(() => s.client.lookupRelease(SIBELIUS), MusicBrainzResponseError);
  assertEquals(s.agents.length, 2);
});

Deno.test("releasesForUrl: the releases a provider page is linked to; none for an unknown URL (D52)", async () => {
  const fetchImpl: typeof fetch = (input) => {
    const url = new URL(String(input));
    if (url.searchParams.get("resource") === "https://www.deezer.com/album/1") {
      return Promise.resolve(Response.json({
        id: "u1",
        resource: "https://www.deezer.com/album/1",
        relations: [{ type: "free streaming", release: { id: SIBELIUS, title: "Symphony no. 5" } }, { type: "x" }],
      }));
    }
    return Promise.resolve(Response.json({ error: "Not Found" }, { status: 404 }));
  };
  await using s = await setup(fetchImpl);
  assertEquals((await s.client.releasesForUrl("https://www.deezer.com/album/1")).value, [
    { id: SIBELIUS, title: "Symphony no. 5" },
  ]);
  assertEquals((await s.client.releasesForUrl("https://www.deezer.com/album/2")).value, []);
});

Deno.test("lookupReleaseFresh never answers from the cache: a just-submitted release is asked for again", async () => {
  await using s = await setup();
  await s.client.lookupRelease(SIBELIUS);
  await s.client.lookupRelease(SIBELIUS);
  assertEquals(s.requests.length, 1, "the normal lookup is cached");
  await s.client.lookupReleaseFresh(SIBELIUS);
  assertEquals(s.requests.length, 2);
  assertEquals(s.agents.every((a) => a === USER_AGENT), true);
});

Deno.test("artistsForUrl and searchArtists: a release's artists by their provider pages, else by name (D52)", async () => {
  const asked: URL[] = [];
  const fetchImpl: typeof fetch = (input) => {
    const url = new URL(String(input));
    asked.push(url);
    if (url.pathname.endsWith("/url")) {
      return Promise.resolve(Response.json({
        id: "u",
        relations: [{ artist: { id: "a1", name: "Niklas" } }, { artist: { id: "a1", name: "Niklas" } }],
      }));
    }
    return Promise.resolve(Response.json({ artists: [{ id: "a2", name: 'Say "Hi"', score: 100 }] }));
  };
  await using s = await setup(fetchImpl);
  assertEquals((await s.client.artistsForUrl("https://www.deezer.com/artist/9")).value, [{ id: "a1", name: "Niklas" }]);
  assertEquals(asked[0].searchParams.get("inc"), "artist-rels");
  assertEquals((await s.client.searchArtists('Say "Hi"')).value.map((a) => a.id), ["a2"]);
  assertEquals(asked[1].searchParams.get("query"), 'artist:"Say \\"Hi\\""');
});
