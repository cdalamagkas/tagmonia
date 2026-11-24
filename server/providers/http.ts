/**
 * Outbound provider HTTP (ARCHITECTURE.md §9.3, §14.5): every request takes a
 * rate-limit token, carries Tagmonia's User-Agent, and backs off on 429/503.
 * MusicBrainz answers its global overload with 503 + `Retry-After` even though
 * its docs do not mention the header (D32), so honouring it is not optional.
 */
import { type Clock, type RateLimiter, realClock } from "./ratelimit.ts";

export interface PoliteFetchOptions {
  limiter: RateLimiter;
  userAgent: string;
  fetch?: typeof fetch;
  clock?: Clock;
  /** Retries after the first attempt. */
  maxRetries?: number;
  baseDelayMs?: number;
  /** Upper bound for any single wait, including a server's Retry-After. */
  maxDelayMs?: number;
  timeoutMs?: number;
  random?: () => number;
}

export class ProviderHttpError extends Error {
  override name = "ProviderHttpError";
  constructor(readonly status: number, readonly url: string) {
    super(`HTTP ${status} from ${new URL(url).host}`);
  }
}

const RETRY_STATUS = new Set([429, 502, 503, 504]);

/** Seconds or an HTTP date, per RFC 9110 §10.2.3. Returns ms, or undefined when absent or invalid. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Exponential backoff with full jitter, never below the server's own request. */
export function backoffMs(attempt: number, base: number, max: number, random: () => number, retryAfter?: number) {
  const jittered = random() * base * 2 ** attempt;
  return Math.min(max, Math.max(retryAfter ?? 0, jittered));
}

/**
 * Returns the final response (2xx, or a non-retryable status such as 404) and
 * leaves interpreting it to the caller. Throws after retries run out.
 */
export async function politeFetch(url: URL, opts: PoliteFetchOptions, signal?: AbortSignal): Promise<Response> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const clock = opts.clock ?? realClock;
  const maxRetries = opts.maxRetries ?? 5;
  const base = opts.baseDelayMs ?? 1000;
  const maxDelay = opts.maxDelayMs ?? 60_000;
  const random = opts.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await opts.limiter.acquire(signal);
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: { "User-Agent": opts.userAgent, Accept: "application/json" },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: "follow",
      });
    } catch (e) {
      signal?.throwIfAborted();
      lastError = e;
      if (attempt < maxRetries) await clock.sleep(backoffMs(attempt, base, maxDelay, random), signal);
      continue;
    }
    if (!RETRY_STATUS.has(res.status)) return res;

    await res.body?.cancel();
    lastError = new ProviderHttpError(res.status, url.href);
    const retryAfter = parseRetryAfter(res.headers.get("retry-after"), clock.now());
    const wait = backoffMs(attempt, base, maxDelay, random, retryAfter);
    // Every caller sharing this provider backs off, not only this one; the next acquire() waits it out.
    opts.limiter.pause(wait);
  }
  throw lastError;
}
