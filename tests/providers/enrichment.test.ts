/** Finding the chosen release on Deezer, iTunes and Discogs (D47). */
import { assertEquals } from "@std/assert";
import { barcodeVariants, type EnrichmentDeps, findOnProviders, linksOf } from "../../server/providers/enrichment.ts";
import type { HarmonizedRelease } from "../../server/providers/harmony_adapter.ts";
import { createHarmonyRegistry } from "../../server/providers/harmony_adapter.ts";
import type { MbRelease } from "../../server/providers/musicbrainz/schema.ts";
import { installReplayFetch, readSnap, snapPath } from "../helpers/replay_fetch.ts";
import { loadRelease } from "../identify/helpers.ts";

const IS_THIS_IT = "9920c28f-e1a6-36a5-9fb4-31fde24b2c43";
const T1989 = "f5818519-29a6-4eac-a58f-bdb73757e658";

/** A Harmony release with `n` tracks. */
const harmony = (n: number, url = "https://example.test/r") =>
  ({
    title: "T",
    artists: [],
    externalLinks: [],
    media: [{ tracklist: Array.from({ length: n }, (_, i) => ({ title: `t${i}` })) }],
    info: { providers: [{ name: "X", internalName: "x", id: "1", url }], messages: [] },
  }) as unknown as HarmonizedRelease;

function fake(opts: {
  ids?: string[];
  byUrl?: (u: URL) => Promise<HarmonizedRelease>;
  byGtin?: (p: string, g: string) => Promise<HarmonizedRelease>;
  enabled?: (id: string) => boolean;
}) {
  const calls: string[] = [];
  const deps: EnrichmentDeps = {
    registry: {
      providerIds: (opts.ids ?? ["deezer", "itunes", "discogs"]) as EnrichmentDeps["registry"]["providerIds"],
      providerForUrl: (
        u,
      ) => (u.host.includes("deezer") ? "deezer" : u.host.includes("discogs") ? "discogs" : undefined),
      lookupByUrl: (u) => {
        calls.push(`url ${u.href}`);
        return opts.byUrl ? opts.byUrl(u) : Promise.resolve(harmony(4, u.href));
      },
      lookupByGtin: (p, g) => {
        calls.push(`gtin ${p} ${g}`);
        return opts.byGtin ? opts.byGtin(p, g) : Promise.resolve(harmony(4));
      },
    },
    enabled: opts.enabled ?? (() => true),
  };
  return { deps, calls };
}

const mb = (barcode: string | null, tracks = 4) =>
  ({
    id: "m",
    title: "T",
    barcode,
    country: "GB",
    media: [{ position: 1, "track-count": tracks, tracks: Array.from({ length: tracks }) }],
  }) as unknown as MbRelease;

Deno.test("a MusicBrainz link is used before the barcode; a different track count is another edition", async () => {
  const f = fake({ byGtin: () => Promise.resolve(harmony(6)) });
  const r = await findOnProviders(f.deps, mb("5050294107621"), ["https://www.deezer.com/album/1"]);
  assertEquals(r.map((m) => [m.provider, m.status, m.via]), [
    ["deezer", "found", "link"],
    ["itunes", "different_edition", "barcode"],
    ["discogs", "different_edition", "barcode"],
  ]);
  assertEquals(r[1].reason, "6 tracks; the release has 4");
});

Deno.test("providers turned off, not set up, or with nothing to look up are skipped without a request", async () => {
  const f = fake({ ids: ["deezer", "itunes"], enabled: (id) => id !== "deezer" });
  const r = await findOnProviders(f.deps, mb(null), []);
  assertEquals(r.map((m) => [m.provider, m.status, m.reason]), [
    ["deezer", "skipped", "turned off"],
    ["itunes", "skipped", "no link on MusicBrainz and no barcode"],
    ["discogs", "skipped", "not set up"],
  ]);
  assertEquals(f.calls, []);
});

Deno.test("other spellings of the barcode are tried only after a miss", async () => {
  const f = fake({
    byGtin: (_p, g) =>
      g === "0602547071538" ? Promise.resolve(harmony(4)) : Promise.reject(new Error("API returned no results")),
  });
  const r = await findOnProviders({ ...f.deps, enabled: (id) => id === "discogs" }, mb("00602547071538"), []);
  assertEquals(r[2].status, "found");
  assertEquals(f.calls, ["gtin discogs 00602547071538", "gtin discogs 602547071538", "gtin discogs 0602547071538"]);
  assertEquals(barcodeVariants("5050294107621"), ["5050294107621"]);
});

Deno.test("a moved release is looked up once more at its new address; other errors are errors", async () => {
  const moved = "API returned https://www.deezer.com/album/9 instead of the requested https://www.deezer.com/album/1";
  const f = fake({
    byUrl: (u) => (u.pathname.endsWith("/1") ? Promise.reject(new Error(moved)) : Promise.resolve(harmony(4, u.href))),
    byGtin: () => Promise.reject(new Error("HTTP 500")),
  });
  const r = await findOnProviders(f.deps, mb("123456789012"), ["https://www.deezer.com/album/1"]);
  assertEquals([r[0].status, r[0].url], ["found", "https://www.deezer.com/album/9"]);
  assertEquals([r[1].status, r[1].reason], ["error", "HTTP 500"]);
});

Deno.test("linksOf reads URL relations", () => {
  assertEquals(linksOf({ relations: [{ url: { resource: "https://a" } }, {}] }), ["https://a"]);
  assertEquals(linksOf(null), []);
});

Deno.test({
  name: "through Harmony on recorded responses: link, barcode, moved album, other edition, not found",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const replay = installReplayFetch();
    const dir = await Deno.makeTempDir({ prefix: "tagmonia-harmony-" });
    try {
      const registry = await createHarmonyRegistry({
        app: { name: "Tagmonia", version: "test", contact: "https://example.test" },
        snapsDir: dir,
        providers: ["deezer", "itunes", "discogs"],
      });
      const deps = { registry, enabled: () => true };
      // The path exactly as the replay helper computes it (a URL would decode the file name's escapes).
      const extrasOf = async (id: string) => {
        const url = new URL(`https://musicbrainz.org/ws/2/release/${id}`);
        url.searchParams.set("inc", "genres+release-groups+url-rels");
        url.searchParams.set("fmt", "json");
        return JSON.parse(new TextDecoder().decode((await readSnap(snapPath(url)))!));
      };
      const isThisIt = await findOnProviders(deps, await loadRelease(IS_THIS_IT), linksOf(await extrasOf(IS_THIS_IT)));
      assertEquals(isThisIt.map((m) => [m.provider, m.status, m.via]), [
        ["deezer", "not_found", "barcode"],
        ["itunes", "found", "barcode"],
        ["discogs", "found", "link"],
      ]);
      const t1989 = await findOnProviders(deps, await loadRelease(T1989), linksOf(await extrasOf(T1989)));
      assertEquals(t1989.map((m) => [m.provider, m.status, m.via]), [
        ["deezer", "found", "link"],
        ["itunes", "different_edition", "barcode"],
        ["discogs", "not_found", "barcode"],
      ]);
      assertEquals(t1989[0].url, "https://www.deezer.com/album/9007779", "the moved album");
      assertEquals(
        [...new Set(replay.requests.map((u) => u.host))].sort(),
        ["api.deezer.com", "api.discogs.com", "itunes.apple.com"],
      );
    } finally {
      replay.restore();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
