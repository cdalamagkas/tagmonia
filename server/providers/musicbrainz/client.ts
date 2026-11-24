/**
 * Tagmonia's own MusicBrainz WS/2 client (D31). Harmony's client hard-codes
 * Harmony's User-Agent (D12) and has no search or relationship lookups, which
 * identification (§8) and classical credits (§6.3) need.
 *
 * Every request: snapshot cache first, then the shared 1 req/s limiter with
 * Tagmonia's User-Agent (CLAUDE.md safety rule 4). Read-only; nothing here
 * submits edits.
 */
import { z } from "zod";
import { politeFetch, type PoliteFetchOptions, ProviderHttpError } from "../http.ts";
import type { SnapshotCache } from "../snapshots.ts";
import {
  type MbBrowseRelease,
  mbidSchema,
  type MbRelease,
  type MbReleaseExtras,
  type MbReleaseSearch,
  type MbWork,
  releaseBrowseSchema,
  releaseExtrasSchema,
  releaseSchema,
  releaseSearchSchema,
  workSchema,
} from "./schema.ts";

export const PROVIDER_ID = "musicbrainz";
export const DEFAULT_BASE_URL = "https://musicbrainz.org/ws/2/";

/**
 * Everything §6.3 and §8 need in one lookup. `recording-level-rels` + `artist-rels`
 * give conductor/performer/arranger credits on each recording; `work-rels` +
 * `work-level-rels` add the performed work with its composer and its parent link.
 * Verified against the live API on 2026-11-23 (D32).
 */
export const RELEASE_INC = [
  "artist-credits",
  "labels",
  "recordings",
  "release-groups",
  "media",
  "isrcs",
  "recording-level-rels",
  "work-rels",
  "work-level-rels",
  "artist-rels",
].join("+");

/** Parent works and their composer, for `work` and movement fields (§6.3). */
export const WORK_INC = ["work-rels", "artist-rels"].join("+");

export interface Ttl {
  lookupMs: number;
  searchMs: number;
}

/** §9.4 defaults: lookups 30 days, searches 1 day. */
export const DEFAULT_TTL: Ttl = { lookupMs: 30 * 86_400_000, searchMs: 86_400_000 };

export interface MusicBrainzClientOptions {
  baseUrl?: string;
  http: PoliteFetchOptions;
  cache: SnapshotCache;
  ttl?: Ttl;
}

export interface Cited<T> {
  value: T;
  /** Snapshot the value came from, for provenance (§9.4). */
  snapshotId: number;
}

export interface ReleaseQuery {
  release?: string;
  artist?: string;
  /** Total track count; a boost, not a filter, so a release with a bonus track still appears. */
  tracks?: number;
  barcode?: string;
  catno?: string;
  /** Words instead of phrases, each fuzzy: a fallback for misspelt tags (D38). */
  fuzzy?: boolean;
}

/** Lucene word terms; fuzzy (~) only for words long enough not to match everything. */
function fuzzyTerms(s: string): string {
  const words = s.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return `(${words.map((w) => ([...w].length >= 4 ? `${w}~` : w)).join(" ")})`;
}

/** Inside a Lucene phrase only `"` and `\` are special. */
function phrase(s: string): string {
  return `"${s.replace(/[\\"]/g, (c) => "\\" + c)}"`;
}

/** Builds a Lucene release query; returns "" when nothing is searchable. */
export function buildReleaseQuery(q: ReleaseQuery): string {
  const must: string[] = [];
  const should: string[] = [];
  const text = (s: string) => (q.fuzzy ? fuzzyTerms(s) : phrase(s));
  if (q.release?.trim()) must.push(`release:${text(q.release.trim())}`);
  if (q.artist?.trim()) must.push(`artist:${text(q.artist.trim())}`);
  if (q.barcode?.trim()) must.push(`barcode:${phrase(q.barcode.trim())}`);
  if (q.catno?.trim()) must.push(`catno:${phrase(q.catno.trim())}`);
  if (q.tracks !== undefined && Number.isInteger(q.tracks) && q.tracks > 0) should.push(`tracks:${q.tracks}`);
  if (must.length === 0) return "";
  return [must.map((m) => `+${m}`).join(" "), ...should].join(" ");
}

export class MusicBrainzClient {
  readonly baseUrl: URL;
  readonly #ttl: Ttl;

  constructor(private readonly opts: MusicBrainzClientOptions) {
    const base = new URL(opts.baseUrl ?? DEFAULT_BASE_URL);
    if (base.protocol !== "https:" && base.protocol !== "http:") {
      throw new Error("MusicBrainz base URL must be http(s)");
    }
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    this.baseUrl = base;
    this.#ttl = opts.ttl ?? DEFAULT_TTL;
  }

  async searchReleases(
    q: ReleaseQuery,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<Cited<MbReleaseSearch["releases"]>> {
    const query = buildReleaseQuery(q);
    if (!query) throw new Error("empty MusicBrainz release query");
    const limit = Math.min(100, Math.max(1, opts.limit ?? 25));
    const url = this.#url("release/", { query, limit: String(limit) });
    const got = await this.#get(url, this.#ttl.searchMs, releaseSearchSchema, opts.signal);
    if (!got) throw new ProviderHttpError(404, url.href);
    return { value: got.value.releases, snapshotId: got.snapshotId };
  }

  /**
   * Full release with recordings and relationships, or null when the MBID does
   * not exist. A merged MBID resolves to its target, so `value.id` may differ
   * from the requested `mbid` (§8 order 1).
   */
  async lookupRelease(mbid: string, signal?: AbortSignal): Promise<Cited<MbRelease> | null> {
    const id = mbidSchema.parse(mbid);
    const url = this.#url(`release/${id}`, { inc: RELEASE_INC });
    return await this.#get(url, this.#ttl.lookupMs, releaseSchema, signal, assertComplete);
  }

  /**
   * Releases of a release group, for the edition picker (§8.2, D38). Browse
   * pages hold at most 100; a few pages cover all but the most re-issued albums.
   */
  async browseReleaseGroup(
    releaseGroupId: string,
    opts: { maxPages?: number; signal?: AbortSignal } = {},
  ): Promise<Cited<MbBrowseRelease[]>> {
    const id = mbidSchema.parse(releaseGroupId);
    const out: MbBrowseRelease[] = [];
    let snapshotId = 0;
    for (let page = 0; page < (opts.maxPages ?? 3); page++) {
      const url = this.#url("release", {
        "release-group": id,
        inc: "media+labels+artist-credits",
        limit: "100",
        offset: String(page * 100),
      });
      const got = await this.#get(url, this.#ttl.lookupMs, releaseBrowseSchema, opts.signal);
      if (!got) break;
      if (page === 0) snapshotId = got.snapshotId;
      out.push(...got.value.releases);
      if (out.length >= got.value["release-count"] || got.value.releases.length === 0) break;
    }
    return { value: out, snapshotId };
  }

  /**
   * Genres of a release and its release group (§10.3, D27), and its links to the
   * same release on other providers (D47), in one request. Separate from the
   * identification lookup, whose URL every recorded fixture depends on (D40).
   */
  async lookupReleaseExtras(mbid: string, signal?: AbortSignal): Promise<Cited<MbReleaseExtras> | null> {
    const id = mbidSchema.parse(mbid);
    const url = this.#url(`release/${id}`, { inc: "genres+release-groups+url-rels" });
    return await this.#get(url, this.#ttl.lookupMs, releaseExtrasSchema, signal);
  }

  async lookupWork(mbid: string, signal?: AbortSignal): Promise<Cited<MbWork> | null> {
    const id = mbidSchema.parse(mbid);
    return await this.#get(this.#url(`work/${id}`, { inc: WORK_INC }), this.#ttl.lookupMs, workSchema, signal);
  }

  #url(path: string, params: Record<string, string>): URL {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("fmt", "json");
    return url;
  }

  /** `check` runs before caching, so a response it rejects is never stored. */
  async #get<T>(
    url: URL,
    ttlMs: number,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
    check: (value: T) => void = () => {},
  ): Promise<Cited<T> | null> {
    const key = url.href;
    const cached = await this.opts.cache.get(PROVIDER_ID, key, ttlMs);
    if (cached) {
      if (cached.status === 404) return null;
      const value = parse(schema, cached.body, key);
      check(value);
      return { value, snapshotId: cached.id };
    }

    const res = await politeFetch(url, this.opts.http, signal);
    const body = await res.text();
    if (res.status === 404) {
      await this.opts.cache.put(PROVIDER_ID, key, 404, body);
      return null;
    }
    if (!res.ok) throw new ProviderHttpError(res.status, key);
    // Validate before caching so a malformed response is never served from the cache later.
    const value = parse(schema, body, key);
    check(value);
    const snap = await this.opts.cache.put(PROVIDER_ID, key, res.status, body);
    return { value, snapshotId: snap.id };
  }
}

export class MusicBrainzResponseError extends Error {
  override name = "MusicBrainzResponseError";
}

function parse<T>(schema: z.ZodType<T>, body: string, url: string): T {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new MusicBrainzResponseError(`invalid JSON from ${url}`);
  }
  const r = schema.safeParse(json);
  if (!r.success) {
    const where = r.error.issues.slice(0, 3).map((i) => i.path.join(".") || "(root)").join(", ");
    throw new MusicBrainzResponseError(`unexpected MusicBrainz response shape at ${where}`);
  }
  return r.data;
}

/**
 * MusicBrainz caps some linked lists at 25 per entity (D32). Identification
 * must never score a silently truncated tracklist, so fail loudly instead.
 */
function assertComplete(release: MbRelease): void {
  for (const m of release.media) {
    if ((m.tracks?.length ?? 0) < m["track-count"]) {
      throw new MusicBrainzResponseError(
        `release ${release.id} medium ${m.position}: got ${m.tracks?.length ?? 0} of ${m["track-count"]} tracks`,
      );
    }
  }
}
