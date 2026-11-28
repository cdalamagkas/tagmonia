/** Bulk actions from the library (D75): each release checked as its own button would, the rest listed with why. */
import { assertEquals } from "@std/assert";
import { reconcileUnit, upsertFile } from "../../server/db/repo/library.ts";
import { saveProposal } from "../../server/db/repo/proposals.ts";
import type { BulkResponse, LibrarySummary } from "../../shared/types.ts";
import { makeTestApp, signIn, type TestApp } from "../helpers/app.ts";

type Kind = "ready" | "choices" | "stale" | "none" | "nothing";

function release(t: TestApp, folder: string, kind: Kind): number {
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
    hintArtist: "A",
    hintAlbum: folder.split("/").pop()!,
    hintMbid: null,
    contentHash: "h",
  }], 1);
  if (kind === "nothing") return id;
  const fileId = (t.db.prepare("SELECT id FROM library_file WHERE path = ?").get(path) as { id: number }).id;
  saveProposal(t.db, {
    candidateId: id,
    releaseMbid: "00000000-0000-4000-8000-000000000001",
    chosenBy: "auto",
    basedOnHash: kind === "stale" ? "older" : "h",
    snapshotIds: [],
    build: {
      fields: [{
        fileId,
        field: "title",
        current: "old",
        proposed: kind === "none" ? "old" : "new",
        status: kind === "none" ? "unchanged" : "changed",
        locked: false,
        sources: [],
        origin: "musicbrainz",
        conflict: kind === "choices",
      }],
      unmappedFiles: [],
    },
  }, 1);
  return id;
}

async function app(readOnly = false) {
  const t = await makeTestApp({ config: { readOnly } });
  const auth = await signIn(t);
  const ids = {
    ready1: release(t, "Rock/Ready One", "ready"),
    ready2: release(t, "Rock/Ready Two", "ready"),
    choices: release(t, "Rock/Choice", "choices"),
    stale: release(t, "Rock/Stale", "stale"),
    none: release(t, "Jazz/Complete", "none"),
    nothing: release(t, "Jazz/Bare", "nothing"),
  };
  const bulk = (body: unknown) =>
    t.request("/api/library/bulk", { method: "POST", ...auth, body: JSON.stringify(body) });
  const jobs = (kind: string) =>
    (t.db.prepare("SELECT payload FROM job WHERE kind = ?").all(kind) as { payload: string }[]).map((r) =>
      JSON.parse(r.payload)
    );
  return { t, auth, ids, bulk, jobs };
}

const VIEW = { root: "library", folder: "", status: null, sort: "artist", q: "" };

Deno.test("writing in bulk: only the ready ones are queued; the others say why", async () => {
  const { t, auth, ids, bulk, jobs } = await app();
  try {
    const res = await bulk({ action: "write", ids: Object.values(ids) });
    const body = (await res.json()) as BulkResponse;
    assertEquals([res.status, body.queued, body.skippedTotal], [202, 2, 4]);
    assertEquals(Object.fromEntries(body.skipped.map((s) => [s.name, s.reason])), {
      Choice: "needs a choice first",
      Stale: "the files changed since the changes were prepared",
      Complete: "nothing to change",
      Bare: "no changes prepared",
    });
    assertEquals(jobs("write").length, 2);
    const approved = t.db.prepare("SELECT count(*) n FROM proposal WHERE state = 'approved'").get() as { n: number };
    assertEquals(approved.n, 2, "asking to write is the approval, as with the button");
    // Again at once: those two are already being written.
    const again = (await (await bulk({ action: "write", ids: [ids.ready1] })).json()) as BulkResponse;
    assertEquals([again.queued, again.skipped[0].reason], [0, "A write or undo is already running for this release"]);
    const summary = (await (await t.request("/api/library/summary", { cookie: auth.cookie })).json()) as LibrarySummary;
    assertEquals(summary.jobs, { identify: 0, write: 2 });
  } finally {
    await t.cleanup();
  }
});

Deno.test("everything a view shows: the same folder and status as the list", async () => {
  const { t, ids, bulk, jobs } = await app();
  try {
    const ready = (await (await bulk({ action: "write", view: { ...VIEW, status: "ready" } })).json()) as BulkResponse;
    assertEquals([ready.queued, ready.skippedTotal], [2, 0]);
    const jazz = (await (await bulk({ action: "identify", view: { ...VIEW, folder: "Jazz" } })).json()) as BulkResponse;
    assertEquals(jazz.queued, 2);
    assertEquals(jobs("identify").map((p) => p.candidateId).sort(), [ids.none, ids.nothing].sort());
  } finally {
    await t.cleanup();
  }
});

Deno.test("read-only mode refuses writes, not identification; bad requests and CSRF", async () => {
  const { t, auth, ids, bulk } = await app(true);
  try {
    assertEquals((await bulk({ action: "write", ids: [ids.ready1] })).status, 403);
    assertEquals((await bulk({ action: "identify", ids: [ids.ready1] })).status, 202);
    assertEquals((await bulk({ action: "write" })).status, 400, "neither ids nor a view");
    assertEquals((await bulk({ action: "write", ids: [1], view: VIEW })).status, 400, "both");
    assertEquals((await bulk({ action: "erase", ids: [1] })).status, 400);
    assertEquals((await bulk({ action: "identify", ids: Array.from({ length: 501 }, (_, i) => i + 1) })).status, 400);
    const noCsrf = await t.request("/api/library/bulk", {
      method: "POST",
      cookie: auth.cookie,
      body: JSON.stringify({ action: "identify", ids: [ids.ready1] }),
    });
    assertEquals(noCsrf.status, 403);
  } finally {
    await t.cleanup();
  }
});
