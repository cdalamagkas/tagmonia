/**
 * Finding the chosen MusicBrainz release on Deezer, iTunes and Discogs (§9.2,
 * §10.1, D47): by the release's own MusicBrainz link when it has one, else by
 * barcode. A barcode can lead to another edition, so a result whose track count
 * differs is kept for display but marked, and never used for tags. Nothing here
 * fails the proposal: each provider ends in a status.
 */
import type { MbRelease } from "./musicbrainz/schema.ts";
import type { HarmonizedRelease, HarmonyRegistry, HarmonyReleaseOptions } from "./harmony_adapter.ts";
import type { YouTubeEvidence } from "./youtube.ts";

export type EnrichmentProvider = "deezer" | "itunes" | "discogs";
/** Providers a proposal can start from (§10.4): the enrichment ones, and Bandcamp when switched on (D16). */
export type SourceProvider = EnrichmentProvider | "bandcamp";
export const ENRICHMENT_PROVIDERS: readonly EnrichmentProvider[] = ["deezer", "itunes", "discogs"];

export type MatchStatus = "found" | "different_edition" | "not_found" | "skipped" | "error";

export interface ProviderMatch {
  /** YouTube: evidence from a pasted link (§9.5, D55), or the source itself when the proposal is built from it (D64). */
  provider: SourceProvider | "youtube";
  status: MatchStatus;
  via: "link" | "barcode" | null;
  /** The release's page on the provider. */
  url: string | null;
  /** Why it was skipped, not found, or a different edition. Never contains a credential. */
  reason: string | null;
  /** The provider's data, for "found" and "different_edition". */
  release: HarmonizedRelease | null;
  /** YouTube's facts, in place of `release`. */
  evidence?: YouTubeEvidence;
}

export interface EnrichmentDeps {
  registry: Pick<HarmonyRegistry, "providerIds" | "providerForUrl" | "lookupByUrl" | "lookupByGtin">;
  /** The providers page switch (settings.providers.<id>.enabled). */
  enabled: (id: EnrichmentProvider) => boolean;
}

/** Includes Deezer's "no data (code 800)" for an unknown barcode. */
const NOT_FOUND = /not found|no (results?|release|album|data)|could not find|does not exist|404/i;
/** Harmony refuses a provider that serves another ID than asked (e.g. a moved Deezer album). */
const REDIRECTED = /returned (https?:\/\/\S+) instead of/i;

/**
 * The same barcode as providers store it: MusicBrainz often has the 14-digit
 * GTIN ("00602547071538") where Discogs keeps 12 or 13 digits. Tried in order,
 * only after a miss.
 */
export function barcodeVariants(barcode: string): string[] {
  const digits = barcode.replace(/\D/g, "");
  const bare = digits.replace(/^0+/, "");
  const out = [digits, bare, bare.padStart(13, "0"), bare.padStart(12, "0")];
  return [...new Set(out.filter((b) => b.length >= 8 && b.length <= 14))];
}

function trackCount(r: { media: { tracklist: unknown[] }[] }): number {
  return r.media.reduce((n, m) => n + m.tracklist.length, 0);
}

/** What is looked for: a MusicBrainz release, or a release found on a provider (§10.4). */
export interface EnrichmentTarget {
  barcode: string | null;
  country: string | null;
  trackCount: number;
}

export function targetOfMb(mb: MbRelease): EnrichmentTarget {
  return {
    barcode: mb.barcode || null,
    country: mb.country ?? null,
    trackCount: mb.media.reduce((n, m) => n + (m.tracks?.length ?? m["track-count"]), 0),
  };
}

export function targetOfHarmony(r: HarmonizedRelease): EnrichmentTarget {
  return { barcode: r.gtin ? String(r.gtin) : null, country: null, trackCount: trackCount(r) };
}

/**
 * Every provider lookup asks for ISRCs (Deezer's album response has none; Harmony
 * fetches them per track only when asked, D51), all track artists and separate
 * media, as Harmony's own release lookups do.
 */
export const LOOKUP_OPTIONS = { withISRC: true, withAllTrackArtists: true, withSeparateMedia: true } as const;

/** iTunes and Deezer have region-specific catalogues: the release's own country first. */
function regions(t: EnrichmentTarget): HarmonyReleaseOptions {
  const set = new Set<string>();
  if (t.country && /^[A-Z]{2}$/.test(t.country)) set.add(t.country);
  for (const r of ["US", "GB"]) set.add(r);
  return { ...LOOKUP_OPTIONS, regions: set } as HarmonyReleaseOptions;
}

export async function findOnProviders(
  deps: EnrichmentDeps,
  target: EnrichmentTarget,
  links: string[],
): Promise<ProviderMatch[]> {
  const mbTracks = target.trackCount;
  const urls = links.flatMap((l) => {
    try {
      return [new URL(l)];
    } catch {
      return [];
    }
  });
  const out: ProviderMatch[] = [];
  for (const provider of ENRICHMENT_PROVIDERS) {
    const base = { provider, via: null, url: null, release: null };
    if (!deps.enabled(provider)) {
      out.push({ ...base, status: "skipped", reason: "turned off" });
      continue;
    }
    if (!deps.registry.providerIds.includes(provider)) {
      out.push({ ...base, status: "skipped", reason: "not set up" });
      continue;
    }
    const link = urls.find((u) => deps.registry.providerForUrl(u) === provider);
    const via = link ? "link" : target.barcode ? "barcode" : null;
    if (!via) {
      out.push({ ...base, status: "skipped", reason: "no link and no barcode" });
      continue;
    }
    try {
      const release = link
        ? await lookupLink(deps, link, regions(target))
        : await lookupBarcode(deps, provider, target.barcode!, regions(target));
      const url = release.info?.providers?.[0]?.url ?? link?.href ?? null;
      const n = trackCount(release);
      out.push(
        n === mbTracks ? { provider, via, url, release, status: "found", reason: null } : {
          provider,
          via,
          url,
          release,
          status: "different_edition",
          reason: `${n} track${n === 1 ? "" : "s"}; the release has ${mbTracks}`,
        },
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      out.push({
        ...base,
        via,
        status: NOT_FOUND.test(message) ? "not_found" : "error",
        reason: message.slice(0, 300),
      });
    }
  }
  return out;
}

/** By link; once more at the new address when the provider has moved the release. */
export async function lookupLink(deps: EnrichmentDeps, link: URL, options: HarmonyReleaseOptions) {
  try {
    return await deps.registry.lookupByUrl(link, options);
  } catch (e) {
    const moved = REDIRECTED.exec(e instanceof Error ? e.message : "");
    if (!moved) throw e;
    return await deps.registry.lookupByUrl(new URL(moved[1]), options);
  }
}

/** By barcode, then by its other spellings while the provider reports "not found". */
async function lookupBarcode(
  deps: EnrichmentDeps,
  provider: EnrichmentProvider,
  barcode: string,
  options: HarmonyReleaseOptions,
) {
  let last: unknown;
  for (const b of barcodeVariants(barcode)) {
    try {
      return await deps.registry.lookupByGtin(provider, b, options);
    } catch (e) {
      if (!NOT_FOUND.test(e instanceof Error ? e.message : String(e))) throw e;
      last = e;
    }
  }
  throw last;
}

/** The links on a MusicBrainz release ("url-rels"), for providers to recognise. */
export function linksOf(extras: { relations: { url?: { resource: string } }[] } | null): string[] {
  return (extras?.relations ?? []).map((r) => r.url?.resource).filter((u): u is string => !!u);
}
