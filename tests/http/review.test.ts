/** Review actions: decisions, locks and discard (§10.3). */
import { assertEquals } from "@std/assert";
import { reconcileUnit, upsertFile } from "../../server/db/repo/library.ts";
import { getProposal, saveProposal, setProposalState } from "../../server/db/repo/proposals.ts";
import type { LockDto, ProposalResponse } from "../../shared/types.ts";
import { makeTestApp, signIn, type TestApp } from "../helpers/app.ts";

/** Two files, each with a changed title and an added genre. */
function seed(t: TestApp) {
  const ids: number[] = [];
  for (const n of [1, 2]) {
    upsertFile(t.db, {
      path: `A/0${n}.flac`,
      folder: "A",
      size: 1,
      mtimeMs: 1,
      format: "flac",
      durationMs: 1000,
      sampleRate: null,
      channels: null,
      bitrateKbps: null,
      tags: { title: `Old ${n}` },
      pictures: [],
      readError: null,
      scannedAt: 1,
    });
  }
  const [candidateId] = reconcileUnit(t.db, "A", [{
    key: "k",
    folder: "A",
    paths: ["A/01.flac", "A/02.flac"],
    hintArtist: null,
    hintAlbum: null,
    hintMbid: null,
    contentHash: "h1",
  }], 1);
  for (const r of t.db.prepare("SELECT id FROM library_file ORDER BY path").all() as { id: number }[]) ids.push(r.id);
  const proposalId = saveProposal(t.db, {
    candidateId,
    releaseMbid: "00000000-0000-4000-8000-000000000001",
    chosenBy: "user",
    basedOnHash: "h1",
    snapshotIds: [],
    build: {
      fields: ids.flatMap((fileId, i) => [
        {
          fileId,
          field: "title" as const,
          current: `Old ${i + 1}`,
          proposed: `New ${i + 1}`,
          status: "changed" as const,
          locked: false,
          sources: [],
        },
        {
          fileId,
          field: "genre" as const,
          current: null,
          proposed: ["Jazz"],
          status: "added" as const,
          locked: false,
          sources: [],
        },
      ]),
      unmappedFiles: [],
    },
  }, 1);
  return { candidateId, proposalId, fileIds: ids };
}

async function withApp(fn: (t: TestApp, s: { cookie: string; csrf: string }) => Promise<void>) {
  const t = await makeTestApp();
  try {
    await fn(t, await signIn(t));
  } finally {
    await t.cleanup();
  }
}

const rows = (t: TestApp, proposalId: number, field: string) =>
  getProposal(t.db, proposalId)!.fields.filter((f) => f.field === field);

Deno.test("decisions apply to a set of rows; an edit is validated against the field's type", () =>
  withApp(async (t, { cookie, csrf }) => {
    const { proposalId } = seed(t);
    const post = (body: unknown) =>
      t.request(`/api/proposals/${proposalId}/decisions`, { method: "POST", cookie, csrf, body: JSON.stringify(body) });
    const genreIds = rows(t, proposalId, "genre").map((f) => f.id);
    assertEquals((await post({ fieldIds: genreIds, decision: "kept_current" })).status, 204);
    assertEquals(rows(t, proposalId, "genre").map((f) => f.decision), ["kept_current", "kept_current"]);

    const [title1] = rows(t, proposalId, "title");
    assertEquals((await post({ fieldIds: [title1.id], decision: "edited", edited: 42 })).status, 400, "title is text");
    assertEquals(
      (await post({ fieldIds: genreIds, decision: "edited", edited: "Jazz" })).status,
      400,
      "genre is a list",
    );
    assertEquals((await post({ fieldIds: [title1.id], decision: "edited", edited: "Mine" })).status, 204);
    assertEquals([rows(t, proposalId, "title")[0].decision, rows(t, proposalId, "title")[0].edited], [
      "edited",
      "Mine",
    ]);
    assertEquals((await post({ fieldIds: [999999], decision: "accepted" })).status, 409);
  }));

Deno.test("changing a decision after approval sends the proposal back to review; a written one cannot change", () =>
  withApp(async (t, { cookie, csrf }) => {
    const { proposalId } = seed(t);
    const [title1] = rows(t, proposalId, "title");
    const post = () =>
      t.request(`/api/proposals/${proposalId}/decisions`, {
        method: "POST",
        cookie,
        csrf,
        body: JSON.stringify({ fieldIds: [title1.id], decision: "accepted" }),
      });
    setProposalState(t.db, proposalId, "approved", 2);
    assertEquals((await post()).status, 204);
    assertEquals(getProposal(t.db, proposalId)!.state, "needs_review");
    setProposalState(t.db, proposalId, "written", 3);
    assertEquals((await post()).status, 409);
  }));

Deno.test("a lock keeps the field on the open proposal; removing it restores the proposal unless another lock still applies", () =>
  withApp(async (t, { cookie, csrf }) => {
    const { candidateId, proposalId, fileIds } = seed(t);
    const lock = async (body: unknown) =>
      await t.request("/api/locks", { method: "POST", cookie, csrf, body: JSON.stringify(body) });
    const rel = await lock({ scope: "release", target: String(candidateId), field: "genre" });
    assertEquals(rel.status, 201);
    const relLock: LockDto = await rel.json();
    assertEquals(rows(t, proposalId, "genre").map((f) => [f.locked, f.decision]), [[true, "kept_current"], [
      true,
      "kept_current",
    ]]);
    // A locked row refuses decisions.
    const res = await t.request(`/api/proposals/${proposalId}/decisions`, {
      method: "POST",
      cookie,
      csrf,
      body: JSON.stringify({ fieldIds: [rows(t, proposalId, "genre")[0].id], decision: "accepted" }),
    });
    assertEquals(res.status, 409);

    // A file lock on the first file overlaps; removing the release lock leaves that file locked.
    const fileLock: LockDto = await (await lock({ scope: "file", target: String(fileIds[0]), field: "genre" })).json();
    assertEquals((await t.request(`/api/locks/${relLock.id}`, { method: "DELETE", cookie, csrf })).status, 204);
    assertEquals(rows(t, proposalId, "genre").map((f) => [f.locked, f.decision]), [[true, "kept_current"], [
      false,
      "auto",
    ]]);
    const body: ProposalResponse = await (await t.request(`/api/library/releases/${candidateId}/proposal`, { cookie }))
      .json();
    assertEquals(body.locks.map((l) => l.id), [fileLock.id]);
    assertEquals(body.readOnly, false);
  }));

Deno.test("lock targets must exist; global locks have an empty target", () =>
  withApp(async (t, { cookie, csrf }) => {
    seed(t);
    const lock = (body: unknown) =>
      t.request("/api/locks", { method: "POST", cookie, csrf, body: JSON.stringify(body) });
    assertEquals((await lock({ scope: "release", target: "999", field: "genre" })).status, 400);
    assertEquals((await lock({ scope: "global_field", target: "x", field: "genre" })).status, 400);
    assertEquals((await lock({ scope: "global_field", target: "", field: "nonsense" })).status, 400);
    assertEquals((await lock({ scope: "global_field", target: "", field: "genre" })).status, 201);
    assertEquals((await t.request("/api/locks/999", { method: "DELETE", cookie, csrf })).status, 404);
  }));

Deno.test("a proposal can be discarded, but a written one is undone instead", () =>
  withApp(async (t, { cookie, csrf }) => {
    const { proposalId } = seed(t);
    const discard = () => t.request(`/api/proposals/${proposalId}/discard`, { method: "POST", cookie, csrf });
    setProposalState(t.db, proposalId, "written", 2);
    assertEquals((await discard()).status, 409);
    setProposalState(t.db, proposalId, "needs_review", 3);
    assertEquals((await discard()).status, 204);
    assertEquals(getProposal(t.db, proposalId)!.state, "discarded");
  }));
