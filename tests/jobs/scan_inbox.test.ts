/** The watcher's scan (D60): the inbox alone, shown as the inbox's last scan, not the library's. */
import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { enqueueInboxScan, registerScanJob } from "../../server/jobs/scan.ts";
import { nullLogger } from "../../server/log.ts";
import { createTagIO } from "../../server/tagio/mod.ts";
import type { LibrarySummary } from "../../shared/types.ts";
import { makeTestApp, signIn } from "../helpers/app.ts";
import { AUDIO_DIR, fixturesPresent } from "../tagio/helpers.ts";

Deno.test({
  name: "an inbox scan reads only the inbox and is reported as the inbox's scan",
  ignore: !(await fixturesPresent()),
  sanitizeResources: false,
  async fn() {
    const inboxDir = await Deno.makeTempDir({ prefix: "tagmonia-inbox-" });
    const t = await makeTestApp({ config: { inboxDir } });
    const tagio = await createTagIO();
    try {
      await Deno.mkdir(join(t.musicDir, "Old"));
      await Deno.copyFile(join(AUDIO_DIR, "tagged.flac"), join(t.musicDir, "Old", "01.flac"));
      await Deno.mkdir(join(inboxDir, "New"));
      await Deno.copyFile(join(AUDIO_DIR, "tagged.flac"), join(inboxDir, "New", "01.flac"));
      const touched: number[] = [];
      registerScanJob(t.queue, {
        db: t.db,
        tagio,
        musicDir: t.musicDir,
        inboxDir,
        ignore: () => [],
        logger: nullLogger,
        onCandidatesTouched: (ids) => touched.push(...ids),
      });
      enqueueInboxScan(t.queue);
      await t.queue.drain();
      const paths = (t.db.prepare("SELECT path FROM library_file").all() as { path: string }[]).map((r) => r.path);
      assertEquals(paths, ["@inbox/New/01.flac"], "the library is not scanned");
      assertEquals(touched.length, 1, "the new album goes on to identification");
      const { cookie } = await signIn(t);
      const s = (await (await t.request("/api/library/summary", { cookie })).json()) as LibrarySummary;
      assertEquals(s.scan, null, "the library's last scan is unchanged");
      assertEquals([s.inbox?.releases, s.inbox?.lastScan?.state], [1, "done"]);
    } finally {
      await tagio.close?.();
      await t.cleanup();
      await Deno.remove(inboxDir, { recursive: true });
    }
  },
});
