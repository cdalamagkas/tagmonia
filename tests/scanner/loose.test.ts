/** Untagged files on disk (D62): one release each, unless numbered; folders grouped the old way split on a rescan. */
import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { nullLogger } from "../../server/log.ts";
import { scanLibrary } from "../../server/scanner/scan.ts";
import { createTagIO } from "../../server/tagio/mod.ts";
import { listReleases } from "../../server/db/repo/library.ts";
import { memoryDb } from "../helpers/app.ts";
import { AUDIO_DIR, fixturesPresent } from "../tagio/helpers.ts";

Deno.test({
  name: "untagged singles are a release each, labelled by file name; an old Loose files release splits once",
  ignore: !(await fixturesPresent()),
  sanitizeResources: false,
  async fn() {
    const tagio = await createTagIO();
    const root = await Deno.makeTempDir({ prefix: "tagmonia-loose-" });
    const db = await memoryDb();
    try {
      await Deno.mkdir(join(root, "Misc"));
      await Deno.copyFile(join(AUDIO_DIR, "blank.flac"), join(root, "Misc", "song a.flac"));
      await Deno.copyFile(join(AUDIO_DIR, "blank.mp3"), join(root, "Misc", "song b.mp3"));
      await Deno.mkdir(join(root, "Rip"));
      await Deno.copyFile(join(AUDIO_DIR, "blank.flac"), join(root, "Rip", "01 one.flac"));
      await Deno.copyFile(join(AUDIO_DIR, "blank.flac"), join(root, "Rip", "02 two.flac"));
      const rootReal = await Deno.realPath(root);
      const scan = () => scanLibrary({ db, tagio, rootReal, ignore: [], logger: nullLogger });
      await scan();
      const shown = () =>
        listReleases(db, { limit: 50, offset: 0 }).items.map((r) => [r.folder, r.album ?? r.single, r.trackCount])
          .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
      assertEquals(shown(), [["Rip", null, 2], ["Misc", "song a.flac", 1], ["Misc", "song b.mp3", 1]]);

      // As grouped before D62: both singles in one release. A rescan with no file changed splits it.
      db.prepare("DELETE FROM candidate WHERE folder = 'Misc'").run();
      db.prepare(
        `INSERT INTO candidate (group_key, folder, file_count, content_hash, created_at, updated_at)
         VALUES ('["Misc","loose:Misc"]', 'Misc', 2, 'x', 1, 1)`,
      ).run();
      db.prepare("UPDATE library_file SET candidate_id = last_insert_rowid() WHERE folder = 'Misc'").run();
      const r = await scan();
      assertEquals(r.unitsRegrouped, 1, "only the old folder; the numbered one is already right");
      assertEquals(shown(), [["Rip", null, 2], ["Misc", "song a.flac", 1], ["Misc", "song b.mp3", 1]]);
      assertEquals((await scan()).unitsRegrouped, 0, "and then never again");
      assertEquals(
        listReleases(db, { q: "song b", limit: 50, offset: 0 }).items.map((x) => x.single),
        ["song b.mp3"],
        "found by its file name",
      );
    } finally {
      await tagio.close?.();
      db.close();
      await Deno.remove(root, { recursive: true });
    }
  },
});
