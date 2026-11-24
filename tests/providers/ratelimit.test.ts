import { assertEquals, assertRejects } from "@std/assert";
import { RateLimiter } from "../../server/providers/ratelimit.ts";
import { FakeClock } from "../helpers/fake_clock.ts";

Deno.test("1 req/s: the first request is immediate, the next ones are spaced 1 s apart", async () => {
  const clock = new FakeClock();
  const limiter = new RateLimiter({ requests: 1, perMs: 1000 }, clock);
  const times: number[] = [];
  await Promise.all([0, 1, 2, 3].map(() => limiter.acquire().then(() => times.push(clock.now()))));
  assertEquals(times, [0, 1000, 2000, 3000]);
});

Deno.test("idle time refills the bucket only up to its capacity", async () => {
  const clock = new FakeClock();
  const limiter = new RateLimiter({ requests: 1, perMs: 1000 }, clock);
  await limiter.acquire();
  clock.t += 60_000;
  await limiter.acquire();
  await limiter.acquire();
  // A long pause must not bank 60 tokens for a burst.
  assertEquals(clock.now(), 61_000);
});

Deno.test("pause holds every caller until the server's back-off ends", async () => {
  const clock = new FakeClock();
  const limiter = new RateLimiter({ requests: 1, perMs: 1000 }, clock);
  await limiter.acquire();
  limiter.pause(5_000);
  await limiter.acquire();
  assertEquals(clock.now(), 5_000);
});

Deno.test("an aborted waiter does not block the callers queued behind it", async () => {
  const clock = new FakeClock();
  const limiter = new RateLimiter({ requests: 1, perMs: 1000 }, clock);
  await limiter.acquire();
  const ac = new AbortController();
  ac.abort(new Error("cancelled"));
  const cancelled = limiter.acquire(ac.signal);
  const next = limiter.acquire();
  await assertRejects(() => cancelled, Error, "cancelled");
  await next;
  assertEquals(clock.now(), 1000);
});
