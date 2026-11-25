/** Choosing where a cover comes from and in which size (§10.3, D49). */
import { assertEquals } from "@std/assert";
import type { ProviderMatch } from "../../server/providers/enrichment.ts";
import type { HarmonizedRelease } from "../../server/providers/harmony_adapter.ts";
import { caaListingSchema, coverOptions, modeWrites } from "../../server/covers/sources.ts";

const DEEZER = "https://cdn-images.dzcdn.net/images/cover/8c39b232a5edecdf5fffc14f551fa42b/1000x1000-000000-80-0-0.jpg";
const ITUNES_THUMB =
  "https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/a7/98/d8/a798d867/14UMDIM03793.rgb.jpg/250x250bb.jpg";

const match = (
  provider: ProviderMatch["provider"],
  images: { url: string; thumbUrl?: string; types?: string[] }[],
  status: ProviderMatch["status"] = "found",
) =>
  ({
    provider,
    status,
    via: "link",
    url: null,
    reason: null,
    release: { images } as unknown as HarmonizedRelease,
  }) as ProviderMatch;

const caa = caaListingSchema.parse({
  images: [
    { front: false, image: "https://coverartarchive.org/release/x/2.jpg", thumbnails: {} },
    {
      front: true,
      image: "https://coverartarchive.org/release/x/1.jpg",
      thumbnails: { "1200": "https://coverartarchive.org/release/x/1-1200.jpg" },
    },
  ],
});

Deno.test("the Cover Art Archive's front image comes first, its 1200 px thumbnail as the sized variant", () => {
  const [first] = coverOptions(caa, [match("deezer", [{ url: DEEZER, types: ["front"] }])]);
  assertEquals(first, {
    source: "coverartarchive",
    full: "https://coverartarchive.org/release/x/1.jpg",
    sized: "https://coverartarchive.org/release/x/1-1200.jpg",
  });
});

Deno.test("store covers by size order, with each store's own size-in-URL variants", () => {
  const opts = coverOptions(null, [
    match("deezer", [{ url: DEEZER, types: ["front"] }]),
    match("discogs", [{ url: "https://i.discogs.com/abc.jpeg", types: ["front"] }]),
    match("itunes", [{ url: "https://a1.mzstatic.com/us/r1000/063/x.tif", thumbUrl: ITUNES_THUMB, types: ["front"] }]),
  ]);
  assertEquals(opts.map((o) => o.source), ["itunes", "deezer", "discogs"]);
  assertEquals(opts[0].full, ITUNES_THUMB.replace("250x250bb.jpg", "9999x9999bb.jpg"));
  assertEquals(opts[0].sized, ITUNES_THUMB.replace("250x250bb.jpg", "1200x1200bb.jpg"));
  assertEquals(opts[1].full, DEEZER.replace("1000x1000", "1900x1900"));
  assertEquals(opts[1].sized, DEEZER.replace("1000x1000", "1200x1200"));
  assertEquals(opts[2].full, opts[2].sized, "Discogs has only its original");
});

Deno.test("another edition, a placeholder or a back cover never becomes the front cover", () => {
  assertEquals(
    coverOptions(null, [
      match("itunes", [{ url: "x", thumbUrl: ITUNES_THUMB, types: ["front"] }], "different_edition"),
      match("deezer", [{
        url: "https://cdn-images.dzcdn.net/images/cover//1000x1000-000000-80-0-0.jpg",
        types: ["front"],
      }]),
      match("discogs", [{ url: "https://i.discogs.com/back.jpeg", types: ["back"] }]),
    ]),
    [],
  );
});

Deno.test("the four modes", () => {
  assertEquals(modeWrites("embed_full"), { embed: "full", folder: false });
  assertEquals(modeWrites("embed_1200"), { embed: "sized", folder: false });
  assertEquals(modeWrites("folder"), { embed: null, folder: true });
  assertEquals(modeWrites("both"), { embed: "sized", folder: true });
});
