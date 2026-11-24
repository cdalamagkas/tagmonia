/** Write, history and undo endpoints (§11.3). The jobs themselves are tested in tests/write/. */
import { assert, assertEquals } from "@std/assert";
import { reconcileUnit, upsertFile } from "../../server/db/repo/library.ts";
import { getProposal, saveProposal } from "../../server/db/repo/proposals.ts";
import type { HistoryResponse, JobDto } from "../../shared/types.ts";
import { makeTestApp, signIn, type TestApp } from "../helpers/app.ts";

function seed(t: TestApp): { candidateId: number; proposalId: number } {
  upsertFile(t.db, {
    path: "A/01.flac",
    folder: "A",
    size: 1,
    mtimeMs: 1,
    format: "flac",
    durationMs: 1000,
    sampleRate: null,
    channels: null,
    bitrateKbps: null,
    tags: { title: "Old" },
    pictures: [],
    readError: null,
    scannedAt: 1,
  });
  const [candidateId] = reconcileUnit(t.db, "A", [{
    key: "k",
    folder: "A",
    paths: ["A/01.flac"],
    hintArtist: null,
    hintAlbum: null,
    hintMbid: null,
    contentHash: "h1",
  }], 1);
  const fileId = (t.db.prepare("SELECT id FROM library_file").get() as { id: number }).id;
  const proposalId = saveProposal(t.db, {
    candidateId,
    releaseMbid: "00000000-0000-4000-8000-000000000001",
    chosenBy: "user",
    basedOnHash: "h1",
    snapshotIds: [],
    build: {
      fields: [{
        fileId,
        field: "title",
        current: "Old",
        proposed: "New",
        status: "changed",
        locked: false,
        sources: [],
      }],
      unmappedFiles: [],
    },
  }, 1);
  return { candidateId, proposalId };
}

async function withApp(
  fn: (t: TestApp, s: { cookie: string; csrf: string }) => Promise<void>,
  env: Record<string, string> = {},
) {
  const t = await makeTestApp({ env });
  try {
    await fn(t, await signIn(t));
  } finally {
    await t.cleanup();
  }
}

Deno.test("writing a proposal approves it and queues one write per release", () =>
  withApp(async (t, { cookie, csrf }) => {
    const { proposalId } = seed(t);
    const path = `/api/proposals/${proposalId}/write`;
    assertEquals((await t.request(path, { method: "POST", cookie })).status, 403, "CSRF required");
    const res = await t.request(path, { method: "POST", cookie, csrf });
    assertEquals(res.status, 202);
    const job: JobDto = await res.json();
    assertEquals([job.kind, t.queue.get(job.id)!.payload], ["write", { proposalId }]);
    assertEquals(getProposal(t.db, proposalId)!.state, "approved");
    assertEquals((await t.request(path, { method: "POST", cookie, csrf })).status, 409, "one write at a time");
  }));

Deno.test("a proposal whose files changed since it was built is not written", () =>
  withApp(async (t, { cookie, csrf }) => {
    const { candidateId, proposalId } = seed(t);
    t.db.prepare("UPDATE candidate SET content_hash = 'h2' WHERE id = ?").run(candidateId);
    const res = await t.request(`/api/proposals/${proposalId}/write`, { method: "POST", cookie, csrf });
    assertEquals(res.status, 409);
    assert((await res.json()).error.includes("changed"));
    assertEquals(getProposal(t.db, proposalId)!.state, "needs_review");
  }));

Deno.test("read-only mode refuses writes and undos with 403", () =>
  withApp(async (t, { cookie, csrf }) => {
    const { proposalId } = seed(t);
    assertEquals((await t.request(`/api/proposals/${proposalId}/write`, { method: "POST", cookie, csrf })).status, 403);
    assertEquals((await t.request("/api/batches/1/undo", { method: "POST", cookie, csrf })).status, 403);
  }, { TAGMONIA_READ_ONLY: "true" }));

Deno.test("history lists batches with per-file results; only finished writes are undoable", () =>
  withApp(async (t, { cookie, csrf }) => {
    const { candidateId, proposalId } = seed(t);
    const batch = (status: string, kind = "write", written = 1) =>
      (t.db.prepare(
        `INSERT INTO write_batch (kind, candidate_id, proposal_id, status, files_written, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, 1, 2) RETURNING id`,
      ).get(kind, candidateId, proposalId, status, written) as { id: number }).id;
    const done = batch("done");
    const failed = batch("failed", "write", 0);
    const undo = batch("done", "undo");
    t.db.prepare("INSERT INTO file_backup (write_batch_id, path, status) VALUES (?, 'A/01.flac', 'written')").run(done);
    const body: HistoryResponse = await (await t.request(`/api/library/releases/${candidateId}/history`, { cookie }))
      .json();
    assertEquals(body.batches.map((b) => [b.id, b.undoable]), [[undo, false], [failed, false], [done, true]]);
    assertEquals(body.batches.at(-1)!.files, [{ path: "A/01.flac", status: "written", error: null }]);
    const post = (id: number) => t.request(`/api/batches/${id}/undo`, { method: "POST", cookie, csrf });
    assertEquals((await post(failed)).status, 409);
    assertEquals((await post(undo)).status, 409);
    assertEquals((await post(999)).status, 404);
    const res = await post(done);
    assertEquals(res.status, 202);
    assertEquals(((await res.json()) as JobDto).kind, "undo");
  }));
