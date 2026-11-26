/** The inbox in the library API (D57, D58): a filter, a badge, and how many albums wait. */
import { assertEquals } from "@std/assert";
import { reconcileUnit } from "../../server/db/repo/library.ts";
import type { LibrarySummary, ReleaseList } from "../../shared/types.ts";
import { makeTestApp, signIn } from "../helpers/app.ts";

function unit(t: Awaited<ReturnType<typeof makeTestApp>>, folder: string, album: string) {
  reconcileUnit(t.db, folder, [{
    key: `k:${folder}`,
    folder,
    paths: [],
    hintArtist: "A",
    hintAlbum: album,
    hintMbid: null,
    contentHash: "h",
  }], 1);
}

Deno.test("library list: all, the library only, or the inbox only; the summary counts the inbox", async () => {
  const inboxDir = await Deno.makeTempDir({ prefix: "tagmonia-inbox-" });
  const t = await makeTestApp({ config: { inboxDir } });
  try {
    const { cookie } = await signIn(t);
    unit(t, "Old Album", "Old");
    unit(t, "@inbox/New Download", "New");
    const list = async (q = "") =>
      ((await (await t.request(`/api/library/releases?limit=50${q}`, { cookie })).json()) as ReleaseList).items.map((
        r,
      ) => [r.folder, r.inInbox]);
    assertEquals(await list(), [["@inbox/New Download", true], ["Old Album", false]]);
    assertEquals(await list("&in=inbox"), [["@inbox/New Download", true]]);
    assertEquals(await list("&in=library"), [["Old Album", false]]);
    assertEquals((await t.request(`/api/library/releases?in=elsewhere`, { cookie })).status, 400);
    const summary = (await (await t.request("/api/library/summary", { cookie })).json()) as LibrarySummary;
    assertEquals(summary.inbox, { releases: 1, lastScan: null });
  } finally {
    await t.cleanup();
    await Deno.remove(inboxDir, { recursive: true });
  }
});

Deno.test("without an inbox, the summary says so", async () => {
  const t = await makeTestApp();
  try {
    const { cookie } = await signIn(t);
    const summary = (await (await t.request("/api/library/summary", { cookie })).json()) as LibrarySummary;
    assertEquals(summary.inbox, null);
  } finally {
    await t.cleanup();
  }
});
