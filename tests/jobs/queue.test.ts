import { assert, assertEquals } from "@std/assert";
import { JobQueue, PermanentJobError } from "../../server/jobs/queue.ts";
import { registerWriteJobs } from "../../server/jobs/write.ts";
import { registerProviderTestJob } from "../../server/jobs/provider_test.ts";
import { registerFollowUpJob, registerSubmissionJobs } from "../../server/jobs/submission.ts";
import { nullLogger } from "../../server/log.ts";
import { memoryDb } from "../helpers/app.ts";

async function setup() {
  const db = await memoryDb();
  let now = 1_000_000;
  const queue = new JobQueue(db, { logger: nullLogger, retryBaseMs: 1000, now: () => now });
  return { db, queue, advance: (ms: number) => (now += ms) };
}

Deno.test("jobs run with their payload and store the result", async () => {
  const { db, queue } = await setup();
  queue.register("echo", ({ job }) => Promise.resolve({ got: job.payload }));
  const j = queue.enqueue("echo", { n: 1 });
  await queue.drain();
  const done = queue.get(j.id)!;
  assertEquals([done.state, done.result, done.attempts], ["done", { got: { n: 1 } }, 1]);
  db.close();
});

Deno.test("a dedupe key allows one live job; a new one can start after it finishes", async () => {
  const { db, queue } = await setup();
  queue.register("scan", () => Promise.resolve(null));
  const a = queue.enqueue("scan", {}, { dedupeKey: "scan" });
  const b = queue.enqueue("scan", {}, { dedupeKey: "scan" });
  assertEquals(a.id, b.id);
  await queue.drain();
  const c = queue.enqueue("scan", {}, { dedupeKey: "scan" });
  assert(c.id !== a.id);
  db.close();
});

Deno.test("failures retry with backoff, then fail; permanent errors fail at once", async () => {
  const { db, queue, advance } = await setup();
  let calls = 0;
  queue.register("flaky", () => {
    calls++;
    return Promise.reject(new Error(`boom ${calls}`));
  });
  queue.register("fatal", () => Promise.reject(new PermanentJobError("no")));
  const j = queue.enqueue("flaky", {}, { maxAttempts: 3 });
  await queue.drain();
  assertEquals([queue.get(j.id)!.state, calls], ["queued", 1]);
  assertEquals(queue.get(j.id)!.error, "boom 1");
  await queue.drain();
  assertEquals(calls, 1, "not before its backoff delay");
  advance(1_300);
  await queue.drain();
  assertEquals(calls, 2);
  advance(2_600);
  await queue.drain();
  const failed = queue.get(j.id)!;
  assertEquals([failed.state, failed.attempts, failed.error, calls], ["failed", 3, "boom 3", 3]);

  const f = queue.enqueue("fatal", {}, { maxAttempts: 5 });
  await queue.drain();
  assertEquals([queue.get(f.id)!.state, queue.get(f.id)!.attempts], ["failed", 1]);
  db.close();
});

Deno.test("a job interrupted by a restart runs again on start", async () => {
  const { db, queue } = await setup();
  const j = queue.enqueue("work", {});
  db.prepare("UPDATE job SET state = 'running', attempts = 1 WHERE id = ?").run(j.id); // as if the process died
  const restarted = new JobQueue(db, { logger: nullLogger });
  let ran = false;
  restarted.register("work", () => {
    ran = true;
    return Promise.resolve(null);
  });
  restarted.start();
  for (let i = 0; i < 50 && restarted.get(j.id)!.state !== "done"; i++) await new Promise((r) => setTimeout(r, 10));
  await restarted.stop();
  assert(ran);
  assertEquals(restarted.get(j.id)!.state, "done");
  db.close();
});

Deno.test("cancel: queued jobs never run; running jobs see their signal abort", async () => {
  const { db, queue } = await setup();
  let ran = false;
  queue.register("never", () => {
    ran = true;
    return Promise.resolve(null);
  });
  const q = queue.enqueue("never", {});
  assertEquals(queue.cancel(q.id)!.state, "cancelled");
  await queue.drain();
  assertEquals(ran, false);

  let started!: () => void;
  const isRunning = new Promise<void>((r) => (started = r));
  queue.register("long", ({ signal }) =>
    new Promise((_, reject) => {
      started();
      signal.addEventListener("abort", () => reject(signal.reason));
    }));
  const l = queue.enqueue("long", {});
  const draining = queue.drain();
  await isRunning;
  queue.cancel(l.id);
  await draining;
  assertEquals(queue.get(l.id)!.state, "cancelled");
  db.close();
});

Deno.test("an unknown job kind fails instead of blocking the queue", async () => {
  const { db, queue } = await setup();
  const j = queue.enqueue("mystery", {});
  await queue.drain();
  assertEquals(queue.get(j.id)!.state, "failed");
  db.close();
});

Deno.test("kinds registered first run before older queued jobs, oldest first among them (D76)", async () => {
  const { db, queue, advance } = await setup();
  const ran: string[] = [];
  const record = ({ job }: { job: { kind: string; payload: unknown } }) => {
    ran.push(`${job.kind}${(job.payload as { n: number }).n}`);
    return Promise.resolve(null);
  };
  queue.register("identify", record);
  queue.register("write", record, { first: true });
  queue.register("undo", record, { first: true });
  for (let n = 1; n <= 3; n++) queue.enqueue("identify", { n });
  queue.enqueue("write", { n: 1 });
  queue.enqueue("undo", { n: 1 });
  queue.enqueue("write", { n: 2 }, { runAfter: 1_000_000 + 60_000 });
  await queue.drain();
  assertEquals(ran, ["write1", "undo1", "identify1", "identify2", "identify3"], "a later write waits for its time");
  advance(60_000);
  await queue.drain();
  assertEquals(ran.at(-1), "write2");
  db.close();
});

Deno.test("jobs the user started and waits on do not wait behind identification (D76)", async () => {
  const { db, queue } = await setup();
  const kinds = ["write", "undo", "provider_test", "submission_check", "submission_verify", "submission_follow_ups"];
  const ids: number[] = [];
  let seen: (string | undefined)[] = [];
  queue.register("identify", () => {
    seen = ids.map((id) => queue.get(id)?.state);
    return Promise.resolve(null);
  });
  // The payloads are invalid, so the handlers fail before touching their dependencies: only the order matters here.
  const deps = { logger: nullLogger, db } as never;
  registerWriteJobs(queue, deps);
  registerProviderTestJob(queue, deps);
  registerSubmissionJobs(queue, deps);
  registerFollowUpJob(queue, deps);
  queue.enqueue("identify", {});
  for (const k of kinds) ids.push(queue.enqueue(k, {}).id);
  await queue.drain();
  assertEquals(seen, kinds.map(() => "failed"), "all had run when the older identification started");
  db.close();
});
