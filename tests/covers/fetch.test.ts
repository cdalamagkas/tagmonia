/** Downloading covers: allowlist on every hop, size cap, sniffing, cache, fall-through (§14.5, D49). */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  chooseCover,
  CoverFetcher,
  isAllowedCoverUrl,
  MAX_IMAGE_BYTES,
  upgradeToHttps,
} from "../../server/covers/fetch.ts";
import { RateLimiter } from "../../server/providers/ratelimit.ts";
import type { ProviderMatch } from "../../server/providers/enrichment.ts";
import type { HarmonizedRelease } from "../../server/providers/harmony_adapter.ts";
import { fakeJpeg } from "./helpers.ts";

type Route = (url: URL) => Response;

async function withFetcher(routes: Record<string, Route>, fn: (f: CoverFetcher, seen: string[]) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "tagmonia-covers-" });
  const seen: string[] = [];
  const fetcher = new CoverFetcher({
    cacheDir: dir,
    userAgent: "Tagmonia/test",
    limiter: new RateLimiter({ requests: 1000, perMs: 1 }),
    fetch: (input, init) => {
      const url = new URL(String(input));
      seen.push(url.href);
      assertEquals(init?.redirect, "manual");
      const route = routes[url.href];
      return Promise.resolve(route ? route(url) : new Response("missing", { status: 404 }));
    },
  });
  try {
    await fn(fetcher, seen);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const redirect = (to: string): Route => () => new Response(null, { status: 307, headers: { location: to } });
const image = (bytes: Uint8Array<ArrayBuffer>): Route => () =>
  new Response(bytes, { headers: { "content-type": "image/jpeg" } });

Deno.test("allowed hosts: the cover services and their subdomains, over HTTPS only", () => {
  for (
    const u of ["https://coverartarchive.org/x", "https://ia800.us.archive.org/x", "https://is1-ssl.mzstatic.com/x"]
  ) {
    assert(isAllowedCoverUrl(new URL(u)), u);
  }
  for (const u of ["http://coverartarchive.org/x", "https://evil.example/x", "https://archive.org.evil.example/x"]) {
    assert(!isAllowedCoverUrl(new URL(u)), u);
  }
});

Deno.test("http:// links of allowed hosts are fetched over HTTPS; others stay refused", () =>
  withFetcher({
    "https://coverartarchive.org/release/r/old.jpg": image(fakeJpeg(500, 500)),
  }, async (f, seen) => {
    assertEquals(upgradeToHttps(new URL("http://evil.example/x")).protocol, "http:");
    assertEquals((await f.download("http://coverartarchive.org/release/r/old.jpg")).width, 500);
    assertEquals(seen, ["https://coverartarchive.org/release/r/old.jpg"]);
    await assertRejects(() => f.download("http://evil.example/x.jpg"), Error, "not allowed");
  }));

Deno.test("a redirect chain is followed only through allowed hosts", () =>
  withFetcher({
    "https://coverartarchive.org/release/r/1.jpg": redirect("https://archive.org/download/mbid-r/1.jpg"),
    "https://archive.org/download/mbid-r/1.jpg": redirect("https://ia601.us.archive.org/1/items/mbid-r/1.jpg"),
    "https://ia601.us.archive.org/1/items/mbid-r/1.jpg": image(fakeJpeg(1400, 1400)),
    "https://coverartarchive.org/release/r/2.jpg": redirect("https://internal.example/secret"),
  }, async (f, seen) => {
    const got = await f.download("https://coverartarchive.org/release/r/1.jpg");
    assertEquals([got.width, got.height, got.mime], [1400, 1400, "image/jpeg"]);
    assertEquals(seen.length, 3);
    await assertRejects(() => f.download("https://coverartarchive.org/release/r/2.jpg"), Error, "not allowed");
    assertEquals(seen.includes("https://internal.example/secret"), false, "never requested");
  }));

Deno.test("too large, not an image, or an error status: refused", () =>
  withFetcher({
    "https://i.discogs.com/big.jpg": () =>
      new Response("x", { headers: { "content-length": String(MAX_IMAGE_BYTES + 1) } }),
    "https://i.discogs.com/page.jpg": () =>
      new Response("<html>login</html>", { headers: { "content-type": "image/jpeg" } }),
  }, async (f) => {
    await assertRejects(() => f.download("https://i.discogs.com/big.jpg"), Error, "20 MB");
    await assertRejects(() => f.download("https://i.discogs.com/page.jpg"), Error, "not a JPEG or PNG");
    await assertRejects(() => f.download("https://i.discogs.com/gone.jpg"), Error, "HTTP 404");
  }));

Deno.test("the cache is content-addressed: the same image twice is stored once", () =>
  withFetcher({
    "https://i.discogs.com/a.jpg": image(fakeJpeg(600, 600, 1)),
    "https://i.discogs.com/b.jpg": image(fakeJpeg(600, 600, 1)),
  }, async (f) => {
    const a = await f.download("https://i.discogs.com/a.jpg");
    const b = await f.download("https://i.discogs.com/b.jpg");
    assertEquals(a.sha256, b.sha256);
    assertEquals((await f.read(a.sha256, a.mime)).length, a.size);
  }));

const R = "11111111-1111-4111-8111-111111111111";
const deezer = {
  provider: "deezer",
  status: "found",
  via: "link",
  url: null,
  reason: null,
  release: {
    images: [{
      url: "https://cdn-images.dzcdn.net/images/cover/abc123/1000x1000-000000-80-0-0.jpg",
      types: ["front"],
    }],
  } as unknown as HarmonizedRelease,
} as ProviderMatch;

Deno.test("a failing source passes to the next; 'both' downloads the sized and the full image", () =>
  withFetcher({
    [`https://coverartarchive.org/release/${R}`]: () =>
      Response.json({
        images: [{ front: true, image: "https://coverartarchive.org/release/r/9.jpg", thumbnails: {} }],
      }),
    // The Cover Art Archive's image is gone; Deezer serves both sizes.
    "https://cdn-images.dzcdn.net/images/cover/abc123/1900x1900-000000-80-0-0.jpg": image(fakeJpeg(1400, 1400, 2)),
    "https://cdn-images.dzcdn.net/images/cover/abc123/1200x1200-000000-80-0-0.jpg": image(fakeJpeg(1200, 1200, 3)),
  }, async (f) => {
    const { cover, skipped } = await chooseCover(f, { id: R, "cover-art-archive": { front: true } }, [deezer], "both");
    assertEquals(cover?.source, "deezer");
    assertEquals([cover?.embed?.width, cover?.folder?.width], [1200, 1400]);
    assertEquals(skipped.map((s) => s.source), ["coverartarchive"]);
  }));

Deno.test("no front cover on the Cover Art Archive, or a darkened release: it is not even asked", () =>
  withFetcher({}, async (f, seen) => {
    assertEquals(
      (await chooseCover(f, { id: R, "cover-art-archive": { front: false } }, [], "embed_full")).cover,
      null,
    );
    await chooseCover(f, { id: R, "cover-art-archive": { front: true, darkened: true } }, [], "embed_full");
    assertEquals(seen, []);
  }));
