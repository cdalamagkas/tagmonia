/**
 * The ONLY module that imports from vendor/harmony (CLAUDE.md, ARCHITECTURE.md §4.1).
 * Never import Harmony's Fresh `server/` code or its global `providers/mod.ts`
 * registry (which pins Harmony's own User-Agent and data dir at import time).
 *
 * Phase 0 findings (Decision log D12):
 * - Harmony providers read credentials from Deno.env *when their module loads*,
 *   so credentials are placed in the env before provider modules are imported
 *   dynamically, and changing them requires a restart.
 * - Bandcamp and Beatport providers read the public web pages (no official API).
 *   D16 approves them as opt-in only: never in a default provider list.
 */
import { ProviderRegistry } from "../../vendor/harmony/providers/registry.ts";
import { mergeRelease } from "../../vendor/harmony/harmonizer/merge.ts";
import { createReleaseSeed } from "../../vendor/harmony/musicbrainz/seeding.ts";
import type { MetadataProvider, MetadataProviderConstructor } from "../../vendor/harmony/providers/base.ts";
import type { HarmonyRelease, MergedHarmonyRelease, ReleaseOptions } from "../../vendor/harmony/harmonizer/types.ts";

/** Harmony's harmonized release, re-exported so the rest of Tagmonia is independent of Harmony's layout. */
export type HarmonizedRelease = HarmonyRelease;
export type MergedRelease = MergedHarmonyRelease;
export type HarmonyReleaseOptions = ReleaseOptions;

export interface AppIdentity {
  name: string;
  version: string;
  /** Contact URL sent in the User-Agent (MusicBrainz requires a meaningful one). */
  contact: string;
}

/** Providers backed by an official API. */
export type ApiProviderId = "musicbrainz" | "deezer" | "itunes" | "discogs" | "spotify" | "tidal";
/** Page-reading providers, approved as opt-in only (D16; CLAUDE.md safety rule 6). */
export type OptInProviderId = "bandcamp" | "beatport";
export type HarmonyProviderId = ApiProviderId | OptInProviderId;

/** Must stay disabled unless the user turns them on explicitly. */
export const OPT_IN_PROVIDERS: ReadonlySet<HarmonyProviderId> = new Set<OptInProviderId>(["bandcamp", "beatport"]);

const PROVIDER_MODULES: Record<HarmonyProviderId, () => Promise<{ default: MetadataProviderConstructor }>> = {
  musicbrainz: () => import("../../vendor/harmony/providers/MusicBrainz/mod.ts"),
  deezer: () => import("../../vendor/harmony/providers/Deezer/mod.ts"),
  itunes: () => import("../../vendor/harmony/providers/iTunes/mod.ts"),
  discogs: () => import("../../vendor/harmony/providers/Discogs/mod.ts"),
  spotify: () => import("../../vendor/harmony/providers/Spotify/mod.ts"),
  tidal: () => import("../../vendor/harmony/providers/Tidal/mod.ts"),
  bandcamp: () => import("../../vendor/harmony/providers/Bandcamp/mod.ts"),
  beatport: () => import("../../vendor/harmony/providers/Beatport/mod.ts"),
};

export interface HarmonyCredentials {
  discogsConsumerKey?: string;
  discogsConsumerSecret?: string;
  spotifyClientId?: string;
  spotifyClientSecret?: string;
  tidalClientId?: string;
  tidalClientSecret?: string;
}

const CREDENTIAL_ENV: Record<keyof HarmonyCredentials, string> = {
  discogsConsumerKey: "HARMONY_DISCOGS_CONSUMER_KEY",
  discogsConsumerSecret: "HARMONY_DISCOGS_CONSUMER_SECRET",
  spotifyClientId: "HARMONY_SPOTIFY_CLIENT_ID",
  spotifyClientSecret: "HARMONY_SPOTIFY_CLIENT_SECRET",
  tidalClientId: "HARMONY_TIDAL_CLIENT_ID",
  tidalClientSecret: "HARMONY_TIDAL_CLIENT_SECRET",
};

export interface HarmonyRegistryOptions {
  app: AppIdentity;
  /** Snapshot cache directory, e.g. /config/snaps (§9.4). Created if missing. */
  snapsDir: string;
  /** Explicit list; callers include an opt-in provider only when the user enabled it. */
  providers: HarmonyProviderId[];
  credentials?: HarmonyCredentials;
}

export interface HarmonyRegistry {
  readonly providerIds: readonly HarmonyProviderId[];
  /** Internal name of the provider that would handle this URL, or undefined (unsupported host). */
  providerForUrl(url: URL): string | undefined;
  /** Whether the URL is a release (album) page of a registered provider, not an artist or a track (D51). */
  isReleaseUrl(url: URL): boolean;
  lookupByUrl(url: URL, options?: HarmonyReleaseOptions): Promise<HarmonizedRelease>;
  /** By barcode, on one enabled provider (D47). Rejects when that provider is not registered. */
  lookupByGtin(provider: HarmonyProviderId, gtin: string, options?: HarmonyReleaseOptions): Promise<HarmonizedRelease>;
}

export class UnsupportedUrlError extends Error {
  constructor(url: URL) {
    super(`No enabled provider supports ${url.hostname}`);
    this.name = "UnsupportedUrlError";
  }
}

let credentialsApplied = false;

function applyCredentials(creds: HarmonyCredentials | undefined): void {
  if (!creds) return;
  if (credentialsApplied) {
    throw new Error("Harmony credentials can only be applied once per process (read at module load)");
  }
  for (const [key, env] of Object.entries(CREDENTIAL_ENV) as [keyof HarmonyCredentials, string][]) {
    const value = creds[key];
    if (value) Deno.env.set(env, value);
  }
  credentialsApplied = true;
}

export async function createHarmonyRegistry(opts: HarmonyRegistryOptions): Promise<HarmonyRegistry> {
  applyCredentials(opts.credentials);
  await Deno.mkdir(opts.snapsDir, { recursive: true });
  const registry = new ProviderRegistry({ appInfo: opts.app, dataDir: opts.snapsDir });
  const enabled = [...new Set(opts.providers)];
  for (const id of enabled) {
    const mod = await PROVIDER_MODULES[id]();
    registry.add(mod.default);
  }

  function find(url: URL): MetadataProvider | undefined {
    // Only https, and only hosts a registered provider claims: user-pasted URLs never reach other hosts (§14.5).
    if (url.protocol !== "https:") return undefined;
    return registry.findByUrl(url);
  }

  return {
    providerIds: enabled,
    providerForUrl: (url) => find(url)?.internalName,
    isReleaseUrl(url) {
      const provider = find(url);
      const entity = provider?.extractEntityFromUrl(url);
      if (!provider || !entity) return false;
      const release = provider.entityTypeMap.release;
      return (Array.isArray(release) ? release : [release]).includes(entity.type);
    },
    lookupByUrl(url, options = {}) {
      const provider = find(url);
      if (!provider) return Promise.reject(new UnsupportedUrlError(url));
      return provider.getRelease(url, options);
    },
    lookupByGtin(id, gtin, options = {}) {
      if (!enabled.includes(id)) return Promise.reject(new Error(`provider ${id} is not enabled`));
      // Harmony's internal names are the simplified display names: "deezer", "itunes", "discogs".
      const provider = registry.findByName(id);
      if (!provider) return Promise.reject(new Error(`provider ${id} is not registered`));
      return provider.getRelease(["gtin", gtin], options);
    },
  };
}

/** Merges per-provider releases with Harmony's algorithm (§10.1). Keys are provider display names. */
export function mergeProviderReleases(
  releases: Record<string, HarmonizedRelease | Error>,
  primaryProvider?: string,
): MergedRelease {
  return mergeRelease(releases, { primaryProvider });
}

export interface SeedOptions {
  /** Tagmonia project URL, cited in the edit note. */
  projectUrl: URL;
  /** Where MusicBrainz sends the browser after submission (§12.2). */
  redirectUrl?: URL;
}

/**
 * Release-editor seed form fields (§12). Phase 5 adds Tagmonia's edit note on top.
 * The result is only ever POSTed by the user's browser, never by the server.
 */
export function buildReleaseSeed(release: HarmonizedRelease, opts: SeedOptions): Record<string, string> {
  const seed = createReleaseSeed(release, { projectUrl: opts.projectUrl, redirectUrl: opts.redirectUrl });
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(seed)) out[k] = String(v);
  return out;
}
