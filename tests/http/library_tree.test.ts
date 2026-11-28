/** The library's folder tree and the list's folder scope, status filter, sort and counts (D75). */
import { assertEquals } from "@std/assert";
import { reconcileUnit, upsertFile } from "../../server/db/repo/library.ts";
import { saveProposal } from "../../server/db/repo/proposals.ts";
import type { FolderTreeDto, ReleaseList } from "../../shared/types.ts";
import { makeTestApp, signIn, type TestApp } from "../helpers/app.ts";

function release(
  t: TestApp,
  folder: string,
  album: string,
  opts: { changes?: "ready" | "choices"; status?: string } = {},
) {
  const path = `${folder}/1.flac`;
  upsertFile(t.db, {
    path,
    folder,
    size: 1,
    mtimeMs: 1,
    format: "flac",
    durationMs: 1000,
    sampleRate: null,
    channels: null,
    bitrateKbps: null,
    tags: { title: "old" },
    pictures: [],
    readError: null,
    scannedAt: 1,
  });
  const [id] = reconcileUnit(t.db, folder, [{
    key: `k:${folder}`,
    folder,
    paths: [path],
    hintArtist: "Artist",
    hintAlbum: album,
    hintMbid: null,
    contentHash: "h",
  }], 1);
  if (opts.status) t.db.prepare("UPDATE candidate SET status = ? WHERE id = ?").run(opts.status, id);
  if (opts.changes) {
    const fileId = (t.db.prepare("SELECT id FROM library_file WHERE path = ?").get(path) as { id: number }).id;
    saveProposal(t.db, {
      candidateId: id,
      releaseMbid: "00000000-0000-4000-8000-000000000001",
      chosenBy: "auto",
      basedOnHash: "h",
      snapshotIds: [],
      build: {
        fields: [{
          fileId,
          field: "title",
          current: "old",
          proposed: "new",
          status: "changed",
          locked: false,
          sources: [],
          origin: "musicbrainz",
          conflict: opts.changes === "choices",
        }],
        unmappedFiles: [],
      },
    }, 1);
  }
  return id;
}

async function app() {
  const inboxDir = await Deno.makeTempDir({ prefix: "tagmonia-inbox-" });
  const t = await makeTestApp({ config: { inboxDir } });
  const { cookie } = await signIn(t);
  release(t, "Classical/Bach", "Goldberg", { changes: "ready" });
  release(t, "Classical/Bach/Cantatas", "Cantatas", { status: "no_match" });
  release(t, "Soundtracks/Dune", "Dune", { changes: "choices" });
  release(t, "Soundtracks/Dune 2", "Dune Part Two");
  release(t, "Loose", "Loose");
  release(t, "@inbox/New Download", "Fresh", { changes: "ready" });
  const get = async <T>(path: string) => (await (await t.request(path, { cookie })).json()) as T;
  return {
    t,
    get,
    async [Symbol.asyncDispose]() {
      await t.cleanup();
      await Deno.remove(inboxDir, { recursive: true });
    },
  };
}

Deno.test("the tree: one level at a time, with counts of releases and of those with changes", async () => {
  await using a = await app();
  const top = await a.get<FolderTreeDto>("/api/library/tree?root=library");
  assertEquals([top.releases, top.withChanges, top.here], [5, 2, 0]);
  assertEquals(top.children.map((c) => [c.name, c.releases, c.withChanges, c.hasChildren]), [
    ["Classical", 2, 1, true],
    ["Loose", 1, 0, false],
    ["Soundtracks", 2, 1, true],
  ]);
  const bach = await a.get<FolderTreeDto>("/api/library/tree?root=library&path=Classical/Bach");
  assertEquals([bach.here, bach.children.map((c) => c.path)], [1, ["Classical/Bach/Cantatas"]]);
  // "Dune" is not a prefix of "Dune 2": folders match whole names.
  const dune = await a.get<ReleaseList>("/api/library/releases?root=library&folder=Soundtracks/Dune");
  assertEquals(dune.items.map((r) => r.album), ["Dune"]);
  const inbox = await a.get<FolderTreeDto>("/api/library/tree?root=inbox");
  assertEquals([inbox.releases, inbox.children.map((c) => c.path)], [1, ["New Download"]]);
});

Deno.test("the list: a folder and below, a status, a sort; counts per status before the status filter", async () => {
  await using a = await app();
  const list = (q: string) => a.get<ReleaseList>(`/api/library/releases?${q}`);
  const classical = await list("root=library&folder=Classical");
  assertEquals(classical.items.map((r) => r.album).sort(), ["Cantatas", "Goldberg"]);
  assertEquals(classical.counts, { all: 2, ready: 1, choices: 0, stale: 0, complete: 0, unidentified: 0, nomatch: 1 });
  const ready = await list("root=library&status=ready");
  assertEquals([ready.total, ready.items.map((r) => r.album)], [1, ["Goldberg"]]);
  assertEquals(ready.counts.all, 5, "the counts ignore the status filter");
  assertEquals((await list("root=library&status=choices")).items[0].changes, {
    state: "choices",
    count: 1,
    choices: 1,
  });
  assertEquals((await list("root=library&status=unidentified")).total, 2, "Dune 2 and Loose");
  const byChanges = await list("root=library&sort=changes");
  assertEquals(byChanges.items.slice(0, 2).map((r) => r.album).sort(), ["Dune", "Goldberg"]);
  const byAlbum = await list("root=library&sort=album");
  assertEquals(byAlbum.items.map((r) => r.album), ["Cantatas", "Dune", "Dune Part Two", "Goldberg", "Loose"]);
  assertEquals((await list("root=inbox")).items.map((r) => r.album), ["Fresh"]);
  assertEquals((await list("")).total, 6, "no root: everything, inbox included");
  assertEquals((await a.t.request("/api/library/releases?folder=X", {})).status, 401);
});
