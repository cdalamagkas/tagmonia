/**
 * Downloading covers (§10.3, §14.5, D49). Every hop of a redirect is checked
 * against a host allowlist, downloads stop at 20 MB, and only real JPEG or PNG
 * bytes are kept. Images land in a content-addressed cache under /config, so a
 * write later needs no network and a cover shared by every track is stored once.
 */
import { join } from "node:path";
import type { RateLimiter } from "../providers/ratelimit.ts";
import { type ImageInfo, imageInfo } from "./image.ts";
import {
  type CaaListing,
  caaListingSchema,
  type CoverMode,
  coverOptions,
  type CoverSource,
  modeWrites,
} from "./sources.ts";
import type { ProviderMatch } from "../providers/enrichment.ts";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** Hosts covers may come from; subdomains included. The Cover Art Archive redirects to archive.org's servers. */
const ALLOWED_HOSTS = [
  "coverartarchive.org",
  "archive.org",
  "mzstatic.com",
  "dzcdn.net",
  "discogs.com",
  "bcbits.com",
  // Tidal's image CDN (resources.tidal.com) and Spotify's (i.scdn.co), D67.
  "resources.tidal.com",
  "scdn.co",
];

/**
 * The Cover Art Archive's listing still names older images with http:// links; for
 * an allowed host the request goes over HTTPS instead (checked live, D49).
 */
export function upgradeToHttps(url: URL): URL {
  if (url.protocol !== "http:") return url;
  const u = new URL(url);
  u.protocol = "https:";
  return isAllowedCoverUrl(u) && (u.port === "" || u.port === "80") ? (u.port = "", u) : url;
}

export function isAllowedCoverUrl(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

export class CoverError extends Error {
  override name = "CoverError";
}

export interface CachedImage extends ImageInfo {
  sha256: string;
  size: number;
  url: string;
}

export interface CoverFetcherOptions {
  cacheDir: string;
  userAgent: string;
  /** Shared by every cover request: the Cover Art Archive asks for the same politeness as MusicBrainz. */
  limiter: RateLimiter;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function coverCachePath(cacheDir: string, sha256: string, mime: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new CoverError("bad cover id");
  return join(cacheDir, `${sha256}.${mime === "image/png" ? "png" : "jpg"}`);
}

export class CoverFetcher {
  readonly #o: CoverFetcherOptions;
  constructor(o: CoverFetcherOptions) {
    this.#o = o;
  }

  /** GET with manual redirects, so every hop is checked against the allowlist. */
  async #get(url: URL, accept: string, signal?: AbortSignal): Promise<Response> {
    const doFetch = this.#o.fetch ?? globalThis.fetch;
    let current = upgradeToHttps(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isAllowedCoverUrl(current)) throw new CoverError(`cover host not allowed: ${current.host}`);
      await this.#o.limiter.acquire(signal);
      const timeout = AbortSignal.timeout(this.#o.timeoutMs ?? 60_000);
      const res = await doFetch(current, {
        headers: { "User-Agent": this.#o.userAgent, Accept: accept },
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel();
        if (!loc) throw new CoverError(`redirect without a location from ${current.host}`);
        current = upgradeToHttps(new URL(loc, current));
        continue;
      }
      return res;
    }
    throw new CoverError("too many redirects");
  }

  /** The Cover Art Archive's listing for a release; null when it has none. */
  async listing(mbid: string, signal?: AbortSignal): Promise<CaaListing | null> {
    const res = await this.#get(new URL(`https://coverartarchive.org/release/${mbid}`), "application/json", signal);
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new CoverError(`Cover Art Archive answered HTTP ${res.status}`);
    }
    const parsed = caaListingSchema.safeParse(await res.json());
    if (!parsed.success) throw new CoverError("unexpected Cover Art Archive response");
    return parsed.data;
  }

  /** Downloads one image into the cache (or finds it there) and describes it. */
  async download(url: string, signal?: AbortSignal): Promise<CachedImage> {
    const res = await this.#get(new URL(url), "image/jpeg, image/png", signal);
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      throw new CoverError(`HTTP ${res.status} from ${new URL(url).host}`);
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_IMAGE_BYTES) {
      await res.body.cancel();
      throw new CoverError("image larger than 20 MB");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) throw new CoverError("image larger than 20 MB");
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    // The bytes decide, not the Content-Type header.
    const info = imageInfo(bytes);
    if (!info) throw new CoverError(`not a JPEG or PNG image: ${new URL(url).host}`);
    const sha256 = await sha256Hex(bytes);
    const path = coverCachePath(this.#o.cacheDir, sha256, info.mime);
    await Deno.mkdir(this.#o.cacheDir, { recursive: true });
    try {
      await Deno.stat(path);
    } catch {
      const tmp = `${path}.${crypto.randomUUID()}.tmp`;
      await Deno.writeFile(tmp, bytes);
      await Deno.rename(tmp, path);
    }
    return { ...info, sha256, size, url };
  }

  read(sha256: string, mime: string): Promise<Uint8Array> {
    return Deno.readFile(coverCachePath(this.#o.cacheDir, sha256, mime));
  }
}

export interface ChosenCover {
  source: CoverSource;
  /** The picture to embed, or null when the mode embeds nothing. */
  embed: CachedImage | null;
  /** The full-size image for cover.jpg, or null when the mode saves none. */
  folder: CachedImage | null;
  /** Sources tried before this one, and why they were passed over. */
  skipped: { source: CoverSource; reason: string }[];
}

export interface CoverChoice {
  cover: ChosenCover | null;
  skipped: { source: CoverSource; reason: string }[];
}

/**
 * The best cover the release has, downloaded in the sizes the mode needs.
 * A source that fails (gone, too big, not an image) passes to the next one.
 */
export async function chooseCover(
  fetcher: Pick<CoverFetcher, "listing" | "download">,
  release: { id: string; "cover-art-archive"?: { front?: boolean; darkened?: boolean } },
  matches: ProviderMatch[],
  mode: CoverMode,
  signal?: AbortSignal,
): Promise<CoverChoice> {
  const skipped: CoverChoice["skipped"] = [];
  const caa = release["cover-art-archive"];
  let listing: CaaListing | null = null;
  // MusicBrainz says whether there is a front cover; a darkened release's images cannot be served.
  if (caa?.front && !caa.darkened) {
    try {
      listing = await fetcher.listing(release.id, signal);
    } catch (e) {
      skipped.push({ source: "coverartarchive", reason: (e as Error).message });
    }
  }
  const writes = modeWrites(mode);
  for (const opt of coverOptions(listing, matches)) {
    try {
      const full = writes.embed === "full" || writes.folder ? await fetcher.download(opt.full, signal) : null;
      const embed = writes.embed === "full"
        ? full
        : writes.embed === "sized"
        ? (opt.sized === opt.full && full ? full : await fetcher.download(opt.sized, signal))
        : null;
      return { cover: { source: opt.source, embed, folder: writes.folder ? full : null, skipped }, skipped };
    } catch (e) {
      if (signal?.aborted) throw e;
      skipped.push({ source: opt.source, reason: (e as Error).message });
    }
  }
  return { cover: null, skipped };
}
