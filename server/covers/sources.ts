/**
 * Where a release's front cover can come from, best first (§10.3, D49). Pure.
 * Cover Art Archive first; then the stores, iTunes before Deezer before Discogs,
 * since that is how large their images usually are. Only providers whose
 * release matched ("found") are asked: another edition may have another cover.
 *
 * Sizes come from each source's own resized variants, so Tagmonia needs no image
 * library: the Cover Art Archive's 1200 px thumbnail, and the stores' size-in-URL
 * images, which are never larger than the original (checked live, D49).
 */
import { z } from "zod";
import type { ProviderMatch } from "../providers/enrichment.ts";

export type CoverSource = "coverartarchive" | "itunes" | "deezer" | "discogs";

export type CoverMode = "embed_1200" | "embed_full" | "folder" | "both";

export interface CoverOption {
  source: CoverSource;
  /** The largest image the source serves. */
  full: string;
  /** About 1200 px, or the original when the source has no smaller variant. */
  sized: string;
}

/** What each mode writes: the embedded picture's size, and whether cover.jpg is saved (full size). */
export function modeWrites(mode: CoverMode): { embed: "sized" | "full" | null; folder: boolean } {
  switch (mode) {
    case "embed_1200":
      return { embed: "sized", folder: false };
    case "embed_full":
      return { embed: "full", folder: false };
    case "folder":
      return { embed: null, folder: true };
    case "both":
      return { embed: "sized", folder: true };
  }
}

export const caaListingSchema = z.looseObject({
  images: z.array(z.looseObject({
    front: z.boolean().default(false),
    image: z.string(),
    thumbnails: z.record(z.string(), z.string().nullable()).default({}),
  })).default([]),
});
export type CaaListing = z.infer<typeof caaListingSchema>;

/** The Cover Art Archive's front image, if it has one. */
export function caaOption(listing: CaaListing | null): CoverOption | null {
  const front = listing?.images.find((i) => i.front);
  if (!front) return null;
  return { source: "coverartarchive", full: front.image, sized: front.thumbnails["1200"] ?? front.image };
}

const STORE_ORDER = ["itunes", "deezer", "discogs"] as const;

function storeOption(provider: (typeof STORE_ORDER)[number], art: { url: string; thumbUrl?: string }) {
  switch (provider) {
    case "itunes": {
      // Harmony's url is the uploaded original, sometimes a TIFF; the thumbnail URL takes any size as JPEG.
      const thumb = art.thumbUrl ?? "";
      if (!/\/\d+x\d+bb\.\w+$/.test(thumb)) return null;
      const at = (n: number) => thumb.replace(/\/\d+x\d+bb\.\w+$/, `/${n}x${n}bb.jpg`);
      return { source: provider, full: at(9999), sized: at(1200) } satisfies CoverOption;
    }
    case "deezer": {
      // An album without a cover gets a placeholder with an empty hash: images/cover//1000x1000-…
      if (!/\/cover\/[0-9a-f]+\/\d+x\d+-/.test(art.url)) return null;
      const at = (n: number) => art.url.replace(/\/\d+x\d+-/, `/${n}x${n}-`);
      // Deezer refuses 3000 px but serves up to the original for 1900 (D49).
      return { source: provider, full: at(1900), sized: at(1200) } satisfies CoverOption;
    }
    case "discogs":
      return { source: provider, full: art.url, sized: art.url } satisfies CoverOption;
  }
}

/** Every usable front cover, best first. */
export function coverOptions(listing: CaaListing | null, matches: ProviderMatch[]): CoverOption[] {
  const out: CoverOption[] = [];
  const caa = caaOption(listing);
  if (caa) out.push(caa);
  for (const provider of STORE_ORDER) {
    const m = matches.find((x) => x.provider === provider && x.status === "found");
    const images = m?.release?.images ?? [];
    const front = images.find((i) => i.types?.includes("front"));
    const opt = front && storeOption(provider, front);
    if (opt) out.push(opt);
  }
  return out;
}
