/** Noticing new arrivals in the inbox (D60): change events or a poll, then a quiet period, then one scan. */
import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { inboxSnapshot, InboxWatcher } from "../../server/inbox/watch.ts";
import { nullLogger } from "../../server/log.ts";

const QUIET = 150;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(opts: { watch?: boolean; pollMs?: number } = {}) {
  const dir = await Deno.makeTempDir({ prefix: "tagmonia-watch-" });
  const settled: number[] = [];
  const w = new InboxWatcher({
    inboxDir: dir,
    onSettled: () => settled.push(Date.now()),
    pollMs: () => opts.pollMs ?? 0,
    logger: nullLogger,
    quietMs: QUIET,
    watch: opts.watch ?? true,
  });
  return {
    dir,
    w,
    settled,
    [Symbol.asyncDispose]: async () => {
      await w.stop();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test("startup looks once; a new album is scanned once it settles, and nothing more while it stays", async () => {
  await using s = await setup();
  s.w.start();
  await pause(QUIET * 3);
  assertEquals(s.settled.length, 1, "startup: what arrived while Tagmonia was down");
  await Deno.mkdir(join(s.dir, "New Album"));
  await Deno.writeTextFile(join(s.dir, "New Album", "01.flac"), "x");
  await pause(QUIET * 4);
  await s.w.idle();
  assertEquals(s.settled.length, 2);
  // Reading files (as the scan does) is not a change.
  await Deno.readTextFile(join(s.dir, "New Album", "01.flac"));
  s.w.nudge();
  await pause(QUIET * 3);
  await s.w.idle();
  assertEquals(s.settled.length, 2, "the same inbox is not scanned twice");
});

Deno.test("a file still being copied holds the scan back until it stops growing", async () => {
  await using s = await setup();
  s.w.start();
  await pause(QUIET * 3);
  await s.w.idle();
  const start = s.settled.length;
  const f = await Deno.open(join(s.dir, "big.flac"), { create: true, write: true });
  let wrote = 0;
  for (let i = 0; i < 8; i++) {
    await f.write(new Uint8Array(1024));
    wrote = Date.now();
    await pause(QUIET / 2);
  }
  f.close();
  await pause(QUIET * 4);
  await s.w.idle();
  assertEquals(s.settled.length, start + 1, "one scan, after the copy");
  assertEquals(s.settled[start] >= wrote + QUIET, true, "not before the quiet period after the last write");
});

Deno.test("without change events, the poll finds new files", async () => {
  // Polls as often as the quiet period, so a look is nearly always under way: wait instead of idle().
  await using s = await setup({ watch: false, pollMs: QUIET * 2 });
  s.w.start();
  await pause(QUIET * 4);
  const start = s.settled.length;
  await Deno.writeTextFile(join(s.dir, "arrived.mp3"), "x");
  await pause(QUIET * 10);
  assertEquals(s.settled.length, start + 1);
});

Deno.test("the snapshot lists files with sizes, nested, and changes when a file grows", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "A"));
    await Deno.writeTextFile(join(dir, "A", "1.flac"), "ab");
    const a = await inboxSnapshot(dir);
    assertEquals(a.split("\0")[0], "A/1.flac");
    assertEquals(a.split("\0")[1], "2");
    await Deno.writeTextFile(join(dir, "A", "1.flac"), "abc");
    assertEquals(a === (await inboxSnapshot(dir)), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
