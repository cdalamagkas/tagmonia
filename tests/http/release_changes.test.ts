/** The library list's Changes column (D61): each release's prepared changes, counted as the Changes tab counts them. */
import { assertEquals } from "@std/assert";
import { reconcileUnit, upsertFile } from "../../server/db/repo/library.ts";
import { saveProposal, setProposalState } from "../../server/db/repo/proposals.ts";
import type { ReleaseList } from "../../shared/types.ts";
import { makeTestApp, signIn } from "../helpers/app.ts";

type T = Awaited<ReturnType<typeof makeTestApp>>;

function release(t: T, folder: string, tags: Record<string, unknown>[]) {
  const paths = tags.map((_, i) => `${folder}/${i + 1}.flac`);
  for (const [i, p] of paths.entries()) {
    upsertFile(t.db, {
      path: p,
      folder,
      size: 1,
      mtimeMs: 1,
      format: "flac",
      durationMs: 1000,
      sampleRate: null,
      channels: null,
      bitrateKbps: null,
      tags: tags[i],
      pictures: [],
      readError: null,
      scannedAt: 1,
    });
  }
  const [id] = reconcileUnit(t.db, folder, [{
    key: `k:${folder}`,
    folder,
    paths,
    hintArtist: null,
    hintAlbum: folder,
    hintMbid: null,
    contentHash: "h",
  }], 1);
  const ids = paths.map((p) =>
    (t.db.prepare("SELECT id FROM library_file WHERE path = ?").get(p) as { id: number }).id
  );
  return { id, ids };
}

const row = (fileId: number, field: string, status: string, extra: Record<string, unknown> = {}) => ({
  fileId,
  field,
  current: status === "added" ? null : "old",
  proposed: "new",
  status,
  locked: false,
  sources: [],
  origin: "musicbrainz",
  conflict: false,
  ...extra,
});

function propose(t: T, candidateId: number, fields: ReturnType<typeof row>[], hash = "h") {
  return saveProposal(t.db, {
    candidateId,
    releaseMbid: "00000000-0000-4000-8000-000000000001",
    chosenBy: "auto",
    basedOnHash: hash,
    snapshotIds: [],
    // deno-lint-ignore no-explicit-any
    build: { fields: fields as any, unmappedFiles: [] },
  }, 1);
}

Deno.test("each release says what its prepared changes would do", async () => {
  const t = await makeTestApp();
  try {
    const { cookie } = await signIn(t);
    release(t, "A None", [{}]);
    const ready = release(t, "B Ready", [{}, {}]);
    // An album field is one change for the whole album; a track field one per track.
    propose(t, ready.id, [
      row(ready.ids[0], "album", "changed"),
      row(ready.ids[1], "album", "changed"),
      row(ready.ids[0], "title", "added"),
      row(ready.ids[1], "title", "added"),
      row(ready.ids[1], "genre", "changed", { locked: true }),
    ]);
    const choose = release(t, "C Choose", [{}]);
    propose(t, choose.id, [
      row(choose.ids[0], "date", "changed", { conflict: true }),
      row(choose.ids[0], "title", "added"),
    ]);
    const complete = release(t, "D Complete", [{}]);
    propose(t, complete.id, [row(complete.ids[0], "title", "unchanged")]);
    const stale = release(t, "E Stale", [{}]);
    propose(t, stale.id, [row(stale.ids[0], "title", "added")], "older");
    const written = release(t, "F Written", [{}]);
    setProposalState(t.db, propose(t, written.id, [row(written.ids[0], "title", "added")]), "written", 2);

    const list = (await (await t.request("/api/library/releases?limit=50", { cookie })).json()) as ReleaseList;
    const by = new Map(list.items.map((r) => [r.album, r.changes]));
    assertEquals(by.get("A None"), null);
    assertEquals(by.get("B Ready"), { state: "ready", count: 3, choices: 0 });
    assertEquals(by.get("C Choose"), { state: "choices", count: 2, choices: 1 });
    assertEquals(by.get("D Complete"), { state: "none", count: 0, choices: 0 });
    assertEquals(by.get("E Stale")?.state, "stale");
    assertEquals(by.get("F Written"), { state: "written", count: 0, choices: 0 });
  } finally {
    await t.cleanup();
  }
});
