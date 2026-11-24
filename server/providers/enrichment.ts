/**
 * Finding the chosen MusicBrainz release on Deezer, iTunes and Discogs (§9.2,
 * §10.1, D47): by the release's own MusicBrainz link when it has one, else by
 * barcode. A barcode can lead to another edition, so a result whose track count
 * differs is kept for display but marked, and never used for tags. Nothing here
 * fails the proposal: each provider ends in a status.
 */
import type { MbRelease } from "./musicbrainz/schema.ts";
import type { HarmonizedRelease, HarmonyRegistry, HarmonyReleaseOptions } from "./harmony_adapter.ts";

export type EnrichmentProvider = "deezer" | "itunes" | "discogs";
export const ENRICHMENT_PROVIDERS: readonly EnrichmentProvider[] = ["deezer", "itunes", "discogs"];

export type MatchStatus = "found" | "different_edition" | "not_found" | "skipped" | "error";

export interface ProviderMatch {
  provider: EnrichmentProvider;
  status: MatchStatus;
  via: "link" | "barcode" | null;
  /** The release's page on the provider. */
  url: string | null;
  /** Why it was skipped, not found, or a different edition. Never contains a credential. */
  reason: string | null;
  /** The provider's data, for "found" and "different_edition". */
  release: HarmonizedRelease | null;
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

/** iTunes and Deezer have region-specific catalogues: the release's own country first. */
function regions(mb: MbRelease): HarmonyReleaseOptions {
  const set = new Set<string>();
  if (mb.country && /^[A-Z]{2}$/.test(mb.country)) set.add(mb.country);
  for (const r of ["US", "GB"]) set.add(r);
  return { regions: set } as HarmonyReleaseOptions;
}

export async function findOnProviders(deps: EnrichmentDeps, mb: MbRelease, links: string[]): Promise<ProviderMatch[]> {
  const mbTracks = mb.media.reduce((n, m) => n + (m.tracks?.length ?? m["track-count"]), 0);
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
    const via = link ? "link" : mb.barcode ? "barcode" : null;
    if (!via) {
      out.push({ ...base, status: "skipped", reason: "no link on MusicBrainz and no barcode" });
      continue;
    }
    try {
      const release = link
        ? await lookupLink(deps, link, regions(mb))
        : await lookupBarcode(deps, provider, mb.barcode!, regions(mb));
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
async function lookupLink(deps: EnrichmentDeps, link: URL, options: HarmonyReleaseOptions) {
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
