import { assertEquals, assertNotEquals } from "@std/assert";
import { openMigratedDb } from "../../server/db/db.ts";
import { SnapshotCache } from "../../server/providers/snapshots.ts";

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: "tagmonia-snaps-" });
  const db = await openMigratedDb(":memory:");
  let t = 1_000_000;
  const cache = new SnapshotCache(db, dir, () => t);
  return {
    dir,
    cache,
    advance: (ms: number) => void (t += ms),
    [Symbol.asyncDispose]: async () => {
      db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test("a stored snapshot is served until its TTL runs out", async () => {
  await using s = await setup();
  const put = await s.cache.put("musicbrainz", "https://x/a", 200, '{"a":1}');
  assertEquals((await s.cache.get("musicbrainz", "https://x/a", 1000))?.body, '{"a":1}');
  s.advance(1001);
  assertEquals(await s.cache.get("musicbrainz", "https://x/a", 1000), null);
  // Still retrievable by id for provenance, after it expired for lookups.
  assertEquals((await s.cache.byId(put.id))?.body, '{"a":1}');
});

Deno.test("a refetch adds a new snapshot instead of overwriting the old one", async () => {
  await using s = await setup();
  const first = await s.cache.put("musicbrainz", "k", 200, "old");
  s.advance(10);
  const second = await s.cache.put("musicbrainz", "k", 200, "new");
  assertNotEquals(first.id, second.id);
  assertEquals((await s.cache.get("musicbrainz", "k", 1000))?.body, "new");
  assertEquals((await s.cache.byId(first.id))?.body, "old");
});

Deno.test("a body file deleted from disk counts as a miss", async () => {
  await using s = await setup();
  await s.cache.put("musicbrainz", "k", 200, "x");
  await Deno.remove(s.dir, { recursive: true });
  await Deno.mkdir(s.dir);
  assertEquals(await s.cache.get("musicbrainz", "k", 1000), null);
});

Deno.test("provider ids cannot steer the body path outside the snaps directory", async () => {
  await using s = await setup();
  let threw = false;
  try {
    await s.cache.put("../escape", "k", 200, "x");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
