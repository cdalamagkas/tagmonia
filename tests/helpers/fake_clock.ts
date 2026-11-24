import type { Clock } from "../../server/providers/ratelimit.ts";

/** Virtual time: sleep() advances the clock at once, so rate-limit tests take no real time. */
export class FakeClock implements Clock {
  t = 0;
  readonly sleeps: number[] = [];
  now = () => this.t;
  sleep = (ms: number, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    this.sleeps.push(ms);
    this.t += ms;
    return Promise.resolve();
  };
}
