/**
 * Before seeding: does MusicBrainz already have this release (§12.1)? Asked
 * fresh, never from the cache: by barcode, by the provider pages it may be
 * linked to, and by title and artist with the same track count.
 */
import type { MusicBrainzClient } from "../providers/musicbrainz/client.ts";
import type { MbSearchRelease } from "../providers/musicbrainz/schema.ts";
import { creditString } from "../identify/release.ts";

export interface PossibleDuplicate {
  mbid: string;
  title: string;
  artist: string | null;
  date: string | null;
  country: string | null;
  barcode: string | null;
  trackCount: number | null;
  /** Why it was found, e.g. "same barcode", "linked to the Deezer album". */
  reasons: string[];
}

export interface DuplicateQuery {
  title: string;
  artist: string;
  barcode: string | null;
  trackCount: number;
  /** Provider pages of the release, by provider display name. */
  urls: { name: string; url: string }[];
}

/** Search results under this score are other releases that merely share words. */
const MIN_TEXT_SCORE = 90;

export async function findDuplicates(
  mb: Pick<MusicBrainzClient, "searchReleases" | "releasesForUrl">,
  q: DuplicateQuery,
  signal?: AbortSignal,
): Promise<PossibleDuplicate[]> {
  const out = new Map<string, PossibleDuplicate>();
  const add = (r: Partial<MbSearchRelease> & { id: string; title: string }, reason: string) => {
    const d = out.get(r.id) ?? {
      mbid: r.id,
      title: r.title,
      artist: r["artist-credit"] ? creditString(r["artist-credit"]) : null,
      date: r.date ?? null,
      country: r.country ?? null,
      barcode: r.barcode ?? null,
      trackCount: r["track-count"] ?? null,
      reasons: [],
    };
    if (!d.reasons.includes(reason)) d.reasons.push(reason);
    out.set(r.id, d);
  };
  const fresh = { signal, maxAgeMs: 0 };
  if (q.barcode) {
    // MusicBrainz stores barcodes as printed; a UPC-A is often entered as a 13-digit EAN too.
    const digits = q.barcode.replace(/\D/g, "");
    for (const b of new Set([digits, digits.replace(/^0+/, "").padStart(13, "0")])) {
      for (const r of (await mb.searchReleases({ barcode: b }, { ...fresh, limit: 10 })).value) add(r, "same barcode");
    }
  }
  for (const { name, url } of q.urls) {
    for (const r of (await mb.releasesForUrl(url, fresh)).value) add(r, `linked to the ${name} page`);
  }
  const text = await mb.searchReleases({ release: q.title, artist: q.artist, tracks: q.trackCount }, {
    ...fresh,
    limit: 10,
  });
  for (const r of text.value) {
    if ((r.score ?? 0) >= MIN_TEXT_SCORE && r["track-count"] === q.trackCount) add(r, "same title, artist and tracks");
  }
  return [...out.values()];
}
