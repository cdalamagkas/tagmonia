/**
 * AcoustID lookup client (ARCHITECTURE.md §8 order 4, §9.2). Requests are form
 * POSTs (AcoustID prefers POST because fingerprints are long), which also keeps
 * the API key out of URLs and logs. The snapshot cache key leaves the key out.
 *
 * Limits and formats were checked on 2026-11-24 (D37): at most 3 requests per
 * second; errors are `{"status":"error","error":{"code","message"}}`, with code 4
 * for an invalid API key.
 */
import { z } from "zod";
import { politeFetch, type PoliteFetchOptions, ProviderHttpError } from "./http.ts";
import type { SnapshotCache } from "./snapshots.ts";

export const PROVIDER_ID = "acoustid";
export const LOOKUP_URL = "https://api.acoustid.org/v2/lookup";
/** Recording MBIDs and, nested in each, the MBIDs of releases containing it. */
export const META = "recordings+releaseids";
const TTL_MS = 30 * 86_400_000;

const lookupSchema = z.object({
  status: z.literal("ok"),
  results: z.array(z.looseObject({
    id: z.string(),
    score: z.number(),
    recordings: z.array(z.looseObject({
      id: z.string(),
      title: z.string().optional(),
      duration: z.number().optional(),
      releases: z.array(z.looseObject({ id: z.string() })).optional(),
    })).optional(),
  })),
});

const errorSchema = z.object({
  status: z.literal("error"),
  error: z.object({ code: z.number(), message: z.string() }),
});

export type AcoustIdResult = z.infer<typeof lookupSchema>["results"][number];

/** The configured key was rejected: retrying cannot help, and no other lookup will succeed either. */
export class AcoustIdKeyError extends Error {
  override name = "AcoustIdKeyError";
  constructor() {
    super(
      "AcoustID rejected the API key: lookups need an application key (acoustid.org/my-applications), not the user API key",
    );
  }
}

export class AcoustIdError extends Error {
  override name = "AcoustIdError";
}

export interface AcoustIdClientOptions {
  apiKey: string;
  http: PoliteFetchOptions;
  cache: SnapshotCache;
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class AcoustIdClient {
  constructor(private readonly opts: AcoustIdClientOptions) {}

  async lookup(
    fingerprint: string,
    durationSec: number,
    signal?: AbortSignal,
  ): Promise<{ value: AcoustIdResult[]; snapshotId: number }> {
    // Identifies the request without the key, and without storing the long fingerprint twice.
    const key = `${LOOKUP_URL}?meta=${META}&duration=${durationSec}&fingerprint-sha256=${await sha256Hex(
      fingerprint,
    )}`;
    const cached = await this.opts.cache.get(PROVIDER_ID, key, TTL_MS);
    if (cached) return { value: parse(cached.body), snapshotId: cached.id };

    const form = new URLSearchParams({
      client: this.opts.apiKey,
      meta: META,
      duration: String(durationSec),
      fingerprint,
    });
    const res = await politeFetch(new URL(LOOKUP_URL), this.opts.http, signal, { form });
    const body = await res.text();
    if (!res.ok) throw errorFrom(res.status, body);
    const value = parse(body);
    const snap = await this.opts.cache.put(PROVIDER_ID, key, res.status, body);
    return { value, snapshotId: snap.id };
  }
}

function errorFrom(status: number, body: string): Error {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return new ProviderHttpError(status, LOOKUP_URL);
  }
  const e = errorSchema.safeParse(json);
  if (!e.success) return new ProviderHttpError(status, LOOKUP_URL);
  if (e.data.error.code === 4) return new AcoustIdKeyError();
  return new AcoustIdError(`AcoustID error ${e.data.error.code}: ${e.data.error.message}`);
}

function parse(body: string): AcoustIdResult[] {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new AcoustIdError("invalid JSON from AcoustID");
  }
  const r = lookupSchema.safeParse(json);
  if (!r.success) throw new AcoustIdError("unexpected AcoustID response shape");
  return r.data.results;
}
