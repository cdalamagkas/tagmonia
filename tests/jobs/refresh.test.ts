/** Music-server rescans after writes (§13, D44): debounced, and every written folder is refreshed. */
import { assertEquals } from "@std/assert";
import {
  type FolderRefreshResult,
  type JellyfinClient,
  JellyfinConfigError,
} from "../../server/integrations/jellyfin.ts";
import { JobQueue } from "../../server/jobs/queue.ts";
import { enqueueRefresh, REFRESH_INTERVAL_MS, REFRESH_JOB, registerRefreshJob } from "../../server/jobs/refresh.ts";
import { nullLogger } from "../../server/log.ts";
import { memoryDb } from "../helpers/app.ts";

async function setup(onRefresh: (folders: string[]) => Promise<FolderRefreshResult> | FolderRefreshResult) {
  const db = await memoryDb();
  let now = 1_000_000;
  const queue = new JobQueue(db, { logger: nullLogger, now: () => now, retryBaseMs: 10 });
  const calls: string[][] = [];
  const jellyfin = {
    refreshFolders: async (folders: string[]) => {
      calls.push(folders);
      return await onRefresh(folders);
    },
  } as unknown as JellyfinClient;
  registerRefreshJob(queue, { db, jellyfin, logger: nullLogger, now: () => now });
  return { db, queue, calls, now: () => now, advance: (ms: number) => (now += ms) };
}

const ok = (folders: string[]): FolderRefreshResult => ({ albums: folders, unknown: [], library: "MusicTest" });

Deno.test("batches while a refresh is queued join it, with all their folders", async () => {
  const s = await setup(ok);
  const a = enqueueRefresh(s.queue, s.db, ["A"], s.now());
  const b = enqueueRefresh(s.queue, s.db, ["B", "A"], s.now());
  assertEquals(a.id, b.id);
  await s.queue.drain();
  assertEquals(s.calls, [["A", "B"]]);
  assertEquals(s.queue.get(a.id)!.result, { server: "jellyfin", library: "MusicTest", albums: ["A", "B"] });
  assertEquals((s.db.prepare("SELECT count(*) n FROM refresh_pending").get() as { n: number }).n, 0);
  s.db.close();
});

Deno.test("a folder written during a running refresh is refreshed too, not stranded", async () => {
  // The callback runs later, inside the job, once `s` is set.
  const s: Awaited<ReturnType<typeof setup>> = await setup((folders) => {
    // A write lands while Jellyfin is being asked: it cannot start its own job.
    if (folders.includes("A")) enqueueRefresh(s.queue, s.db, ["C"], s.now());
    return ok(folders);
  });
  enqueueRefresh(s.queue, s.db, ["A"], s.now());
  await s.queue.drain();
  assertEquals(s.calls, [["A"], ["C"]]);
  assertEquals((s.db.prepare("SELECT count(*) n FROM refresh_pending").get() as { n: number }).n, 0);
  s.db.close();
});

Deno.test("a refresh never starts sooner than a minute after the previous one finished", async () => {
  const s = await setup(ok);
  enqueueRefresh(s.queue, s.db, ["A"], s.now());
  await s.queue.drain();
  const finished = s.queue.latest(REFRESH_JOB)!.finishedAt!;
  s.advance(10_000);
  const next = enqueueRefresh(s.queue, s.db, ["B"], s.now());
  assertEquals(next.runAfter, finished + REFRESH_INTERVAL_MS);
  await s.queue.drain();
  assertEquals(s.calls.length, 1, "not yet");
  s.advance(REFRESH_INTERVAL_MS);
  await s.queue.drain();
  assertEquals(s.calls, [["A"], ["B"]]);
  s.db.close();
});

Deno.test("a rejected key fails at once and keeps the folders for a later refresh", async () => {
  const s = await setup(() => Promise.reject(new JellyfinConfigError("Jellyfin rejected the API key")));
  const j = enqueueRefresh(s.queue, s.db, ["A"], s.now());
  await s.queue.drain();
  assertEquals([s.queue.get(j.id)!.state, s.queue.get(j.id)!.attempts], ["failed", 1]);
  assertEquals(
    (s.db.prepare("SELECT folder FROM refresh_pending").all() as { folder: string }[]).map((r) => r.folder),
    [
      "A",
    ],
  );
  s.db.close();
});

Deno.test("with Jellyfin no longer configured, the refresh clears its queue instead of failing", async () => {
  const db = await memoryDb();
  const queue = new JobQueue(db, { logger: nullLogger });
  registerRefreshJob(queue, { db, jellyfin: () => Promise.resolve(null), logger: nullLogger });
  const j = enqueueRefresh(queue, db, ["A"]);
  await queue.drain();
  assertEquals(queue.get(j.id)!.result, { server: "jellyfin", skipped: "not configured" });
  assertEquals((db.prepare("SELECT count(*) n FROM refresh_pending").get() as { n: number }).n, 0);
  db.close();
});
