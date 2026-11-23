/**
 * Login throttling per IP and per account with exponential delay (ARCHITECTURE.md §14.1).
 * In memory: Tagmony is a single process, and a restart resetting counters is acceptable.
 */

export interface ThrottleOptions {
  /** Failures allowed before any delay applies. */
  freeAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Failures older than this are forgotten. */
  windowMs: number;
}

export const DEFAULT_THROTTLE: ThrottleOptions = {
  freeAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 15 * 60_000,
  windowMs: 60 * 60_000,
};

interface Entry {
  failures: number;
  lastFailure: number;
  blockedUntil: number;
}

export class LoginThrottle {
  #entries = new Map<string, Entry>();

  constructor(private opts: ThrottleOptions = DEFAULT_THROTTLE, private now: () => number = Date.now) {}

  /** Milliseconds the caller must wait before trying any of `keys`, or 0. */
  retryAfterMs(keys: string[]): number {
    const now = this.now();
    let wait = 0;
    for (const k of keys) {
      const e = this.#fresh(k, now);
      if (e) wait = Math.max(wait, e.blockedUntil - now);
    }
    return Math.max(0, wait);
  }

  fail(keys: string[]): void {
    const now = this.now();
    for (const k of keys) {
      const e = this.#fresh(k, now) ?? { failures: 0, lastFailure: now, blockedUntil: 0 };
      e.failures++;
      e.lastFailure = now;
      const over = e.failures - this.opts.freeAttempts;
      if (over > 0) e.blockedUntil = now + Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** (over - 1));
      this.#entries.set(k, e);
    }
    if (this.#entries.size > 10_000) this.#sweep(now);
  }

  succeed(keys: string[]): void {
    for (const k of keys) this.#entries.delete(k);
  }

  #fresh(k: string, now: number): Entry | undefined {
    const e = this.#entries.get(k);
    if (e && now - e.lastFailure > this.opts.windowMs && now >= e.blockedUntil) {
      this.#entries.delete(k);
      return undefined;
    }
    return e;
  }

  #sweep(now: number): void {
    for (const k of [...this.#entries.keys()]) this.#fresh(k, now);
  }
}
