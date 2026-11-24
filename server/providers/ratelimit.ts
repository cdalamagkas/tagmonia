/**
 * Per-provider token bucket (ARCHITECTURE.md §9.3). Callers are served in FIFO
 * order so a burst of identify jobs cannot starve an earlier request, and the
 * bucket starts full so a single interactive lookup is not delayed.
 */

export interface RateLimit {
  /** Bucket capacity and refill amount. */
  requests: number;
  /** Refill period. MusicBrainz: { requests: 1, perMs: 1000 }. */
  perMs: number;
}

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

export class RateLimiter {
  #tokens: number;
  #updated: number;
  #tail: Promise<void> = Promise.resolve();
  /** Set by `pause`: no token is handed out before this time. */
  #blockedUntil = 0;

  constructor(readonly limit: RateLimit, private readonly clock: Clock = realClock) {
    if (!(limit.requests > 0) || !(limit.perMs > 0)) throw new Error("rate limit must be positive");
    this.#tokens = limit.requests;
    this.#updated = clock.now();
  }

  /** Resolves when the caller may send one request. */
  acquire(signal?: AbortSignal): Promise<void> {
    const turn = this.#tail.then(() => this.#take(signal));
    // A cancelled waiter must not block the ones queued behind it.
    this.#tail = turn.catch(() => {});
    return turn;
  }

  /** The server asked us to back off (503/429 with Retry-After): hold every caller. */
  pause(ms: number): void {
    this.#blockedUntil = Math.max(this.#blockedUntil, this.clock.now() + ms);
  }

  async #take(signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      const now = this.clock.now();
      if (now < this.#blockedUntil) {
        await this.clock.sleep(this.#blockedUntil - now, signal);
        continue;
      }
      const rate = this.limit.requests / this.limit.perMs;
      this.#tokens = Math.min(this.limit.requests, this.#tokens + (now - this.#updated) * rate);
      this.#updated = now;
      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      await this.clock.sleep(Math.ceil((1 - this.#tokens) / rate), signal);
    }
  }
}
