/** Two roots, one path column (D58): "@inbox/…" paths resolve in the inbox, the rest in the library. */
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "node:path";
import { isInboxPath, PathEscapeError, Roots } from "../../server/fs/safe_path.ts";
import { checkInbox, loadConfig } from "../../server/config.ts";

Deno.test("stored paths resolve in their own root, and never leave it", async () => {
  const lib = await Deno.realPath(await Deno.makeTempDir({ prefix: "tagmonia-lib-" }));
  const inbox = await Deno.realPath(await Deno.makeTempDir({ prefix: "tagmonia-inbox-" }));
  try {
    await Deno.mkdir(join(inbox, "New"));
    await Deno.writeTextFile(join(inbox, "New", "a.flac"), "x");
    await Deno.writeTextFile(join(lib, "b.flac"), "y");
    const roots = new Roots(lib, inbox);
    assertEquals([isInboxPath("@inbox/New/a.flac"), isInboxPath("@inboxes/x"), isInboxPath("New/a.flac")], [
      true,
      false,
      false,
    ]);
    assertEquals(await roots.resolve("@inbox/New/a.flac"), join(inbox, "New", "a.flac"));
    assertEquals(await roots.resolve("@inbox"), inbox);
    assertEquals(await roots.resolve("b.flac"), join(lib, "b.flac"));
    assertEquals(await roots.resolve(""), lib);
    assertEquals(roots.target("Album/c.flac"), join(lib, "Album", "c.flac"));
    assertThrows(() => roots.target("@inbox/../../etc/passwd"), PathEscapeError);
    await assertRejects(() => roots.resolve("../outside"), PathEscapeError);
    await assertRejects(() => new Roots(lib).resolve("@inbox/New/a.flac"), PathEscapeError, "not configured");
  } finally {
    await Deno.remove(lib, { recursive: true });
    await Deno.remove(inbox, { recursive: true });
  }
});

Deno.test("the inbox must be a separate tree from the library", async () => {
  const base = await Deno.makeTempDir({ prefix: "tagmonia-roots-" });
  try {
    for (const d of ["music", "music/inbox", "inbox"]) await Deno.mkdir(join(base, d));
    const cfg = (music: string, inbox?: string) =>
      loadConfig({
        TAGMONIA_MUSIC_DIR: join(base, music),
        ...(inbox ? { TAGMONIA_INBOX_DIR: join(base, inbox) } : {}),
      });
    await checkInbox(cfg("music"));
    await checkInbox(cfg("music", "inbox"));
    for (const [m, i] of [["music", "music/inbox"], ["music/inbox", "music"], ["music", "music"]]) {
      await assertRejects(() => checkInbox(cfg(m, i)), Error, "must not be the music folder", `${m} / ${i}`);
    }
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
