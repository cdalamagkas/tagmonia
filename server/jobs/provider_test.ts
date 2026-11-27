/**
 * Provider health checks for the providers page (§9.2, D46): one cheap request
 * each, run as a job (never inside a request handler). Results are stored per
 * provider; messages never contain a credential.
 */
import { z } from "zod";
import type { Db } from "../db/db.ts";
import { JellyfinClient, JellyfinConfigError } from "../integrations/jellyfin.ts";
import type { CredentialStore, ProviderId } from "../providers/credentials.ts";
import type { MusicBrainzClient } from "../providers/musicbrainz/client.ts";
import { type Job, type JobQueue, PermanentJobError } from "./queue.ts";

export const PROVIDER_TEST_JOB = "provider_test";

export interface ProviderTestDeps {
  db: Db;
  creds: CredentialStore;
  mb: MusicBrainzClient;
  userAgent: string;
  version: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface TestResult {
  ok: boolean;
  message: string;
}

/** A release MusicBrainz will keep: Abbey Road. */
const KNOWN_MBID = "d5625820-d8fb-403a-a920-c40d62c406fe";

async function get(deps: ProviderTestDeps, url: string, headers: Record<string, string> = {}, init: RequestInit = {}) {
  return await (deps.fetch ?? fetch)(url, {
    ...init,
    headers: { "User-Agent": deps.userAgent, Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(15_000),
  });
}

export async function testProvider(id: ProviderId, deps: ProviderTestDeps): Promise<TestResult> {
  switch (id) {
    case "musicbrainz": {
      const r = await deps.mb.lookupRelease(KNOWN_MBID);
      return r
        ? { ok: true, message: "MusicBrainz answered" }
        : { ok: false, message: "MusicBrainz did not find a known release" };
    }
    case "acoustid": {
      const { apiKey } = await deps.creds.get("acoustid");
      if (!apiKey) return { ok: false, message: "no API key" };
      // An invalid fingerprint costs nothing; the error code tells whether the key was accepted.
      const res = await get(deps, "https://api.acoustid.org/v2/lookup", {
        "Content-Type": "application/x-www-form-urlencoded",
      }, { method: "POST", body: new URLSearchParams({ client: apiKey, duration: "30", fingerprint: "AQAA" }) });
      const body = await res.json().catch(() => ({}));
      const code = z.object({ error: z.object({ code: z.number() }) }).safeParse(body);
      if (code.success && code.data.error.code === 4) {
        // The usual cause: the user API key from the profile page, which lookups do not accept.
        return {
          ok: false,
          message:
            "AcoustID rejected the API key. Lookups need an application key (acoustid.org/my-applications), not the user API key from your profile.",
        };
      }
      if (res.ok || (code.success && code.data.error.code === 3)) return { ok: true, message: "API key accepted" };
      return { ok: false, message: `AcoustID answered HTTP ${res.status}` };
    }
    case "deezer": {
      const res = await get(deps, "https://api.deezer.com/album/302127");
      const body = await res.json().catch(() => ({}));
      return res.ok && !("error" in body)
        ? { ok: true, message: "Deezer answered" }
        : { ok: false, message: `Deezer answered HTTP ${res.status}` };
    }
    case "itunes": {
      const res = await get(deps, "https://itunes.apple.com/lookup?id=1440857781&entity=album");
      await res.body?.cancel();
      return res.ok
        ? { ok: true, message: "iTunes answered" }
        : { ok: false, message: `iTunes answered HTTP ${res.status}` };
    }
    case "discogs": {
      const { consumerKey, consumerSecret } = await deps.creds.get("discogs");
      if (!consumerKey || !consumerSecret) return { ok: false, message: "no consumer key and secret" };
      const res = await get(deps, "https://api.discogs.com/database/search?q=test&per_page=1", {
        Authorization: `Discogs key=${consumerKey}, secret=${consumerSecret}`,
      });
      await res.body?.cancel();
      if (res.status === 401) return { ok: false, message: "Discogs rejected the consumer key or secret" };
      return res.ok
        ? { ok: true, message: "key and secret accepted" }
        : { ok: false, message: `Discogs answered HTTP ${res.status}` };
    }
    case "tidal":
    case "spotify": {
      // A token with the client credentials is the test: it is what every lookup starts with (D67).
      const { clientId, clientSecret } = await deps.creds.get(id);
      if (!clientId || !clientSecret) return { ok: false, message: "no client ID and secret" };
      const name = id === "tidal" ? "Tidal" : "Spotify";
      const tokenUrl = id === "tidal"
        ? "https://auth.tidal.com/v1/oauth2/token"
        : "https://accounts.spotify.com/api/token";
      const res = await get(deps, tokenUrl, {
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      }, { method: "POST", body: "grant_type=client_credentials" });
      await res.body?.cancel();
      if (res.status === 400 || res.status === 401) {
        return { ok: false, message: `${name} rejected the client ID or secret` };
      }
      return res.ok
        ? { ok: true, message: "client ID and secret accepted" }
        : { ok: false, message: `${name} answered HTTP ${res.status}` };
    }
    case "bandcamp": {
      // One page request: Bandcamp is read from its public pages (D16).
      const res = await get(deps, "https://bandcamp.com/", { Accept: "text/html" });
      await res.body?.cancel();
      return res.ok
        ? { ok: true, message: "Bandcamp answered" }
        : { ok: false, message: `Bandcamp answered HTTP ${res.status}` };
    }
    case "youtube": {
      const { apiKey } = await deps.creds.get("youtube");
      if (!apiKey) return { ok: false, message: "no API key" };
      // One unit of the day's quota; the key goes in a header, never in the URL (§9.5).
      const res = await get(deps, "https://www.googleapis.com/youtube/v3/videos?part=id&id=jNQXAC9IVRw", {
        "X-Goog-Api-Key": apiKey,
      });
      if (res.ok) {
        await res.body?.cancel();
        return { ok: true, message: "the key works" };
      }
      const text = await res.text();
      if (/quotaExceeded|dailyLimitExceeded/.test(text)) return { ok: false, message: "the day's quota is used up" };
      if (/API key not valid|keyInvalid|API_KEY_INVALID/.test(text)) {
        return { ok: false, message: "the key was refused" };
      }
      if (/accessNotConfigured|SERVICE_DISABLED/.test(text)) {
        return { ok: false, message: "the YouTube Data API v3 is not enabled for this key's project" };
      }
      return { ok: false, message: `YouTube answered HTTP ${res.status}` };
    }
    case "jellyfin": {
      const { url, apiKey, library } = await deps.creds.get("jellyfin");
      if (!url || !apiKey) return { ok: false, message: "no server URL or API key" };
      try {
        const libs = await new JellyfinClient({
          baseUrl: url,
          apiKey,
          library,
          userAgent: deps.userAgent,
          version: deps.version,
          fetch: deps.fetch,
        }).libraries();
        if (library && !libs.some((l) => l.name.toLowerCase() === library.toLowerCase())) {
          return { ok: false, message: `no library named "${library}"` };
        }
        return {
          ok: true,
          message: `${libs.length} librar${libs.length === 1 ? "y" : "ies"}${library ? `, "${library}" found` : ""}`,
        };
      } catch (e) {
        return {
          ok: false,
          message: e instanceof JellyfinConfigError ? e.message : `cannot reach Jellyfin: ${(e as Error).message}`,
        };
      }
    }
  }
}

export function registerProviderTestJob(queue: JobQueue, deps: ProviderTestDeps): void {
  const now = deps.now ?? Date.now;
  queue.register(PROVIDER_TEST_JOB, async ({ job }) => {
    const p = z.object({
      provider: z.enum([
        "musicbrainz",
        "acoustid",
        "deezer",
        "itunes",
        "tidal",
        "spotify",
        "discogs",
        "bandcamp",
        "youtube",
        "jellyfin",
      ]),
    })
      .safeParse(job.payload);
    if (!p.success) throw new PermanentJobError("invalid provider test payload");
    let result: TestResult;
    try {
      result = await testProvider(p.data.provider, deps);
    } catch (e) {
      // Network failures are a result to show, not a job to retry.
      result = { ok: false, message: `request failed: ${(e as Error).message}` };
    }
    deps.db.prepare(
      `INSERT INTO provider_status (provider, ok, message, checked_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET ok = excluded.ok, message = excluded.message, checked_at = excluded.checked_at`,
    ).run(p.data.provider, result.ok ? 1 : 0, result.message, now());
    return result;
  });
}

export function providerTestDedupeKey(id: string): string {
  return `provider-test:${id}`;
}

export function enqueueProviderTest(queue: JobQueue, id: ProviderId): Job {
  return queue.enqueue(PROVIDER_TEST_JOB, { provider: id }, { dedupeKey: providerTestDedupeKey(id), maxAttempts: 1 });
}
