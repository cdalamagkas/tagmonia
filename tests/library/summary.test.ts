/** The library's summary cache (D75): recomputed exactly when something it depends on changed. */
import { assertEquals } from "@std/assert";
import type { Db } from "../../server/db/db.ts";
import { reconcileUnit, upsertFile } from "../../server/db/repo/library.ts";
import {
  addLock,
  latestProposal,
  removeLock,
  saveProposal,
  setDecisions,
  setProposalState,
  setRenameSkip,
} from "../../server/db/repo/proposals.ts";
import { setCoverDecision } from "../../server/db/repo/covers.ts";
import { setDestination } from "../../server/files/rename.ts";
import { bumpGeneration, refreshSummaries } from "../../server/library/summary.ts";
import { memoryDb } from "../helpers/app.ts";

const NAMING = { template: "{album}/{title}", renameLibrary: false };

function release(db: Db, folder: string, hash = "h"): { id: number; fileId: number } {
  const path = `${folder}/1.flac`;
  upsertFile(db, {
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
  const [id] = reconcileUnit(db, folder, [{
    key: `k:${folder}`,
    folder,
    paths: [path],
    hintArtist: null,
    hintAlbum: folder,
    hintMbid: null,
    contentHash: hash,
  }], 1);
  const fileId = (db.prepare("SELECT id FROM library_file WHERE path = ?").get(path) as { id: number }).id;
  return { id, fileId };
}

function propose(db: Db, r: { id: number; fileId: number }, conflict = false): number {
  return saveProposal(db, {
    candidateId: r.id,
    releaseMbid: "00000000-0000-4000-8000-000000000001",
    chosenBy: "auto",
    basedOnHash: "h",
    snapshotIds: [],
    build: {
      fields: [{
        fileId: r.fileId,
        field: "title",
        current: "old",
        proposed: "new",
        status: "changed",
        locked: false,
        sources: [],
        origin: "musicbrainz",
        conflict,
      }],
      unmappedFiles: [],
    },
  }, 1);
}

const row = (db: Db, id: number) =>
  db.prepare("SELECT state, count, choices FROM release_summary WHERE candidate_id = ?").get(id) as
    | { state: string | null; count: number; choices: number }
    | undefined;

Deno.test("computed once, then only when something it depends on changed", async () => {
  const db = await memoryDb();
  const a = release(db, "A");
  const b = release(db, "B");
  const pid = propose(db, a);
  assertEquals(refreshSummaries(db, NAMING), 2, "both, the first time");
  assertEquals(row(db, a.id), { state: "ready", count: 1, choices: 0 });
  assertEquals(row(db, b.id), { state: null, count: 0, choices: 0 });
  assertEquals(refreshSummaries(db, NAMING), 0, "nothing changed: nothing recomputed");

  // A decision on A's proposal: only A.
  const fid = latestProposal(db, a.id)!.fields[0].id;
  setDecisions(db, pid, [fid], "kept_current", undefined, 2);
  assertEquals(refreshSummaries(db, NAMING), 1);
  assertEquals(row(db, a.id), { state: "none", count: 0, choices: 0 });

  // A lock anywhere: every release (a lock can apply to any of them).
  const lock = addLock(db, { scope: "global_field", target: "", field: "genre" }, 3);
  assertEquals(refreshSummaries(db, NAMING), 2);
  removeLock(db, lock.id);
  assertEquals(refreshSummaries(db, NAMING), 2);

  // The files changed (a rescan's new content hash): only A, now stale.
  setDecisions(db, pid, [fid], "auto", undefined, 4);
  refreshSummaries(db, NAMING);
  db.prepare("UPDATE candidate SET content_hash = 'h2' WHERE id = ?").run(a.id);
  assertEquals(refreshSummaries(db, NAMING), 1);
  assertEquals(row(db, a.id)?.state, "stale");

  // The naming settings (outside the database) bump the generation in code.
  bumpGeneration(db);
  assertEquals(refreshSummaries(db, NAMING), 2);
  db.close();
});

Deno.test("each kind of proposal change reaches the cache through the triggers", async () => {
  const db = await memoryDb();
  const a = release(db, "A");
  const pid = propose(db, a, true);
  refreshSummaries(db, NAMING);
  assertEquals(row(db, a.id), { state: "choices", count: 1, choices: 1 });
  const changes: [string, () => void][] = [
    ["the rename choice", () => setRenameSkip(db, pid, true)],
    ["a destination (any release's)", () => setDestination(db, a.id, "Films")],
    ["the cover decision", () => {
      db.prepare(
        `INSERT INTO cover_proposal (proposal_id, mode, source, skipped, embed_status, folder_status, decision)
         VALUES (?, 'embed_full', NULL, '[]', 'unchanged', 'unchanged', 'auto')`,
      ).run(pid);
      setCoverDecision(db, pid, "kept_current", 5);
    }],
    ["a new file in the library", () => release(db, "C")],
    ["the proposal written", () => setProposalState(db, pid, "written", 6)],
  ];
  for (const [what, change] of changes) {
    change();
    assertEquals(refreshSummaries(db, NAMING) > 0, true, what);
  }
  assertEquals(row(db, a.id), { state: "written", count: 0, choices: 0 });
  // A new proposal (rebuilt, or from another source) replaces the latest: recomputed too.
  propose(db, a);
  assertEquals(refreshSummaries(db, NAMING, [a.id]), 1);
  assertEquals(row(db, a.id)?.state, "ready");
  db.close();
});
