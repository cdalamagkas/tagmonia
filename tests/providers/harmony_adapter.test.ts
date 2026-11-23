import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  buildReleaseSeed,
  createHarmonyRegistry,
  mergeProviderReleases,
  OPT_IN_PROVIDERS,
  UnsupportedUrlError,
} from "../../server/providers/harmony_adapter.ts";
import { installReplayFetch } from "../helpers/replay_fetch.ts";

const app = { name: "Tagmony", version: "0.0.0-test", contact: "https://example.invalid/tagmony" };

Deno.test({
  name: "Harmony lookup by URL works through the adapter (Phase 0 done-when)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const replay = installReplayFetch();
    const snapsDir = await Deno.makeTempDir({ prefix: "tagmony-snaps-" });
    try {
      const harmony = await createHarmonyRegistry({ app, snapsDir, providers: ["deezer", "itunes"] });
      const release = await harmony.lookupByUrl(new URL("https://www.deezer.com/en/album/629506181"), {
        withSeparateMedia: true,
        withAllTrackArtists: true,
        withISRC: true,
      });
      assertEquals(release.title, "Die With A Smile");
      assertEquals(release.gtin, "602475093060");
      const tracks = release.media.flatMap((m) => m.tracklist);
      assert(tracks.length > 0);
      assertEquals(tracks[0].artists?.length, 2);
      assert(tracks.every((t) => t.isrc), "every track has an ISRC");
      // Only the provider's fixed API host was contacted.
      assert(replay.requests.length > 0);
      assert(replay.requests.every((u) => u.hostname === "api.deezer.com"), replay.requests.join(", "));

      // Harmony merge and seeding modules run outside Fresh (§4.1 rule 6).
      const merged = mergeProviderReleases({ Deezer: release }, "Deezer");
      assertEquals(merged.title, "Die With A Smile");
      const seed = buildReleaseSeed(merged, {
        projectUrl: new URL(app.contact),
        redirectUrl: new URL("http://localhost:8080/mb/callback?submission=1"),
      });
      assertEquals(seed.name, "Die With A Smile");
      assertEquals(seed.barcode, "602475093060");
      assert(seed["mediums.0.track.0.name"], "tracklist seeded");
      assert(seed.redirect_uri?.startsWith("http://localhost:8080/mb/callback"), seed.redirect_uri);
    } finally {
      replay.restore();
    }
  },
});

Deno.test({
  name: "user URLs for unknown hosts or non-https are rejected before any request (§14.5)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const replay = installReplayFetch();
    try {
      const harmony = await createHarmonyRegistry({
        app,
        snapsDir: await Deno.makeTempDir({ prefix: "tagmony-snaps-" }),
        providers: ["deezer"],
      });
      for (
        const u of [
          "http://192.168.1.1/album/1",
          "https://evil.example/album/629506181",
          "http://www.deezer.com/album/629506181",
          "https://itunes.apple.com/album/1", // provider exists in Harmony but is not enabled
        ]
      ) {
        assertEquals(harmony.providerForUrl(new URL(u)), undefined, u);
        await assertRejects(() => harmony.lookupByUrl(new URL(u)), UnsupportedUrlError);
      }
      assertEquals(replay.requests, []);
    } finally {
      replay.restore();
    }
  },
});

Deno.test({
  name: "Bandcamp and Beatport are reachable only when explicitly enabled (D16)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const replay = installReplayFetch();
    const bandcamp = new URL("https://someartist.bandcamp.com/album/some-album");
    const beatport = new URL("https://www.beatport.com/release/some-release/123");
    try {
      assertEquals([...OPT_IN_PROVIDERS].sort(), ["bandcamp", "beatport"]);
      const off = await createHarmonyRegistry({
        app,
        snapsDir: await Deno.makeTempDir({ prefix: "tagmony-snaps-" }),
        providers: ["deezer"],
      });
      assertEquals(off.providerForUrl(bandcamp), undefined);
      assertEquals(off.providerForUrl(beatport), undefined);

      const on = await createHarmonyRegistry({
        app,
        snapsDir: await Deno.makeTempDir({ prefix: "tagmony-snaps-" }),
        providers: ["bandcamp", "beatport"],
      });
      assertEquals(on.providerForUrl(bandcamp), "bandcamp");
      assertEquals(on.providerForUrl(beatport), "beatport");
      assertEquals(on.providerForUrl(new URL("https://bandcamp.example/album/x")), undefined);
      assertEquals(replay.requests, []);
    } finally {
      replay.restore();
    }
  },
});
