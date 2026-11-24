import { assertEquals, assertRejects } from "@std/assert";
import { backoffMs, parseRetryAfter, politeFetch, ProviderHttpError } from "../../server/providers/http.ts";
import { RateLimiter } from "../../server/providers/ratelimit.ts";
import { USER_AGENT } from "../../server/version.ts";
import { FakeClock } from "../helpers/fake_clock.ts";

const URL_ = new URL("https://musicbrainz.org/ws/2/release/x?fmt=json");

function scripted(responses: (Response | Error)[]) {
  const seen: { ua: string | null; at: number }[] = [];
  const clock = new FakeClock();
  const fetch: typeof globalThis.fetch = (_input, init) => {
    seen.push({ ua: new Headers(init?.headers).get("user-agent"), at: clock.now() });
    const next = responses.shift();
    if (!next) throw new Error("no more scripted responses");
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  const limiter = new RateLimiter({ requests: 1, perMs: 1000 }, clock);
  return { seen, clock, opts: { limiter, userAgent: USER_AGENT, fetch, clock, random: () => 0.5 } };
}

Deno.test("parseRetryAfter reads seconds and HTTP dates", () => {
  assertEquals(parseRetryAfter("3", 0), 3000);
  assertEquals(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6000);
  assertEquals(parseRetryAfter("soon", 0), undefined);
  assertEquals(parseRetryAfter(null, 0), undefined);
});

Deno.test("backoff grows exponentially, is capped, and never undercuts Retry-After", () => {
  assertEquals(backoffMs(0, 1000, 60_000, () => 1), 1000);
  assertEquals(backoffMs(3, 1000, 60_000, () => 1), 8000);
  assertEquals(backoffMs(10, 1000, 60_000, () => 1), 60_000);
  assertEquals(backoffMs(0, 1000, 60_000, () => 0, 4000), 4000);
});

Deno.test("every request carries Tagmonia's User-Agent", async () => {
  const s = scripted([new Response("{}")]);
  await politeFetch(URL_, s.opts);
  assertEquals(s.seen[0].ua, USER_AGENT);
});

Deno.test("a 503 with Retry-After is retried no sooner than the server asked", async () => {
  // MusicBrainz answers global overload like this (D32).
  const s = scripted([new Response("", { status: 503, headers: { "retry-after": "5" } }), new Response("{}")]);
  const res = await politeFetch(URL_, s.opts);
  assertEquals(res.status, 200);
  assertEquals(s.seen.map((x) => x.at), [0, 5000]);
});

Deno.test("a 404 is returned at once, not retried", async () => {
  const s = scripted([new Response("{}", { status: 404 })]);
  assertEquals((await politeFetch(URL_, s.opts)).status, 404);
  assertEquals(s.seen.length, 1);
});

Deno.test("network errors are retried, then the last error is thrown", async () => {
  const s = scripted([new TypeError("reset"), new TypeError("reset"), new TypeError("reset")]);
  await assertRejects(() => politeFetch(URL_, { ...s.opts, maxRetries: 2 }), TypeError, "reset");
  assertEquals(s.seen.length, 3);
});

Deno.test("retries give up with ProviderHttpError and never exceed the rate limit", async () => {
  const s = scripted([503, 503, 503].map((status) => new Response("", { status })));
  await assertRejects(() => politeFetch(URL_, { ...s.opts, maxRetries: 2 }), ProviderHttpError, "HTTP 503");
  const gaps = s.seen.slice(1).map((x, i) => x.at - s.seen[i].at);
  for (const g of gaps) assertEquals(g >= 1000, true, `gap ${g} ms is under 1 s`);
});
