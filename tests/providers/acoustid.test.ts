/** AcoustID client against scripted responses (never the live API, D34). */
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { openMigratedDb } from "../../server/db/db.ts";
import { AcoustIdClient, AcoustIdError, AcoustIdKeyError, LOOKUP_URL } from "../../server/providers/acoustid.ts";
import { RateLimiter } from "../../server/providers/ratelimit.ts";
import { SnapshotCache } from "../../server/providers/snapshots.ts";
import { USER_AGENT } from "../../server/version.ts";
import { FakeClock } from "../helpers/fake_clock.ts";

const KEY = "app-key-123";
const OK = {
  status: "ok",
  results: [{
    id: "9ff43b6a-4f16-427c-93c2-92307ca505e0",
    score: 0.97,
    recordings: [{
      id: "11111111-1111-4111-8111-111111111111",
      title: "Song",
      releases: [{ id: "22222222-2222-4222-8222-222222222222" }],
    }],
  }],
};

async function setup(responses: Response[]) {
  const dir = await Deno.makeTempDir({ prefix: "tagmonia-acoustid-" });
  const db = await openMigratedDb(":memory:");
  const seen: { url: string; method: string; body: string; ua: string | null }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: String(init?.body ?? ""),
      ua: new Headers(init?.headers).get("user-agent"),
    });
    return await Promise.resolve(responses.shift() ?? new Response("{}", { status: 500 }));
  };
  const clock = new FakeClock();
  const client = new AcoustIdClient({
    apiKey: KEY,
    cache: new SnapshotCache(db, dir),
    http: { userAgent: USER_AGENT, fetch, clock, limiter: new RateLimiter({ requests: 1, perMs: 334 }, clock) },
  });
  return {
    client,
    db,
    seen,
    [Symbol.asyncDispose]: async () => {
      db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test("lookup POSTs the key in the body, never in the URL or the cache key", async () => {
  await using s = await setup([new Response(JSON.stringify(OK))]);
  const { value } = await s.client.lookup("AQAAfingerprint", 241);
  assertEquals(value[0].recordings?.[0].releases?.[0].id, "22222222-2222-4222-8222-222222222222");
  assertEquals([s.seen[0].method, s.seen[0].url, s.seen[0].ua], ["POST", LOOKUP_URL, USER_AGENT]);
  const form = new URLSearchParams(s.seen[0].body);
  assertEquals([form.get("client"), form.get("meta"), form.get("duration")], [KEY, "recordings+releaseids", "241"]);
  const keys = s.db.prepare("SELECT request_key FROM snapshot").all() as { request_key: string }[];
  assertEquals(keys.length, 1);
  assertEquals(keys[0].request_key.includes(KEY), false);
  assertEquals(keys[0].request_key.includes("AQAAfingerprint"), false);
});

Deno.test("a repeated lookup is served from the snapshot cache", async () => {
  await using s = await setup([new Response(JSON.stringify(OK))]);
  await s.client.lookup("AQAAfp", 100);
  await s.client.lookup("AQAAfp", 100);
  assertEquals(s.seen.length, 1);
});

Deno.test("error code 4 is an invalid key; other codes are AcoustIdError", async () => {
  // Shape as returned by the live API on 2026-11-24 (D37).
  const err = (code: number, message: string) =>
    new Response(JSON.stringify({ error: { code, message }, status: "error" }), { status: 400 });
  {
    await using s = await setup([err(4, "invalid API key")]);
    await assertRejects(() => s.client.lookup("AQAAfp", 100), AcoustIdKeyError);
  }
  {
    await using s = await setup([err(3, "invalid fingerprint")]);
    const e = await assertRejects(() => s.client.lookup("AQAAfp", 100), AcoustIdError);
    assertStringIncludes(e.message, "invalid fingerprint");
  }
});

Deno.test("a 429 from AcoustID is retried", async () => {
  await using s = await setup([
    new Response(JSON.stringify({ status: "error", error: { code: 14, message: "rate limit" } }), {
      status: 429,
    }),
    new Response(JSON.stringify(OK)),
  ]);
  const { value } = await s.client.lookup("AQAAfp", 100);
  assertEquals(value.length, 1);
  assertEquals(s.seen.length, 2);
});
