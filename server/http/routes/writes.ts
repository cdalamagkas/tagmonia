/** Writing reviewed proposals and undoing writes (§11.3). Both refuse in read-only mode. */
import { Hono } from "hono";
import type { HistoryResponse, WriteBatchDto } from "../../../shared/types.ts";
import type { Db } from "../../db/db.ts";
import { getProposal, isUnresolved, setProposalState } from "../../db/repo/proposals.ts";
import type { JobQueue } from "../../jobs/queue.ts";
import { enqueueUndo, enqueueWrite, writeDedupeKey } from "../../jobs/write.ts";
import type { AuthEnv } from "../auth.ts";
import { toJobDto } from "./library.ts";

export interface WriteRouteDeps {
  db: Db;
  queue: JobQueue;
  readOnly: boolean;
  now?: () => number;
}

const READ_ONLY = { error: "Tagmonia is in read-only mode: nothing is written" };

interface BatchRow {
  id: number;
  kind: "write" | "undo";
  status: WriteBatchDto["status"];
  proposal_id: number | null;
  undoes_batch_id: number | null;
  files_written: number;
  files_skipped: number;
  files_failed: number;
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

export function history(db: Db, candidateId: number, writeLive: boolean): WriteBatchDto[] {
  const rows = db.prepare("SELECT * FROM write_batch WHERE candidate_id = ? ORDER BY id DESC").all(
    candidateId,
  ) as unknown as BatchRow[];
  const files = db.prepare("SELECT path, status, error FROM file_backup WHERE write_batch_id = ? ORDER BY path");
  return rows.map((b) => ({
    id: b.id,
    kind: b.kind,
    status: b.status,
    proposalId: b.proposal_id,
    undoesBatchId: b.undoes_batch_id,
    startedAt: b.started_at,
    finishedAt: b.finished_at,
    counts: { written: b.files_written, skipped: b.files_skipped, failed: b.files_failed },
    error: b.error,
    files: files.all(b.id) as unknown as WriteBatchDto["files"],
    undoable: b.kind === "write" && (b.status === "done" || b.status === "partial") && b.files_written > 0 &&
      !writeLive,
  }));
}

export function writeRoutes(deps: WriteRouteDeps) {
  const { db, queue } = deps;
  const now = deps.now ?? Date.now;
  return new Hono<AuthEnv>()
    .post("/proposals/:id{[0-9]+}/write", (c) => {
      if (deps.readOnly) return c.json(READ_ONLY, 403);
      const p = getProposal(db, Number(c.req.param("id")));
      if (!p) return c.json({ error: "not found" }, 404);
      if (p.state === "written" || p.state === "discarded") {
        return c.json({ error: `This proposal is already ${p.state}` }, 409);
      }
      const cand = db.prepare("SELECT content_hash FROM candidate WHERE id = ?").get(p.candidateId) as
        | { content_hash: string }
        | undefined;
      if (!cand) return c.json({ error: "not found" }, 404);
      // §11.3 step 1 at release level: files changed since the proposal was built.
      if (cand.content_hash !== p.basedOnHash) {
        return c.json({ error: "The files changed since this proposal was built; build it again first" }, 409);
      }
      // §10.3 rule 4: a field whose sources disagree waits for the user's choice (D48).
      const open = p.fields.filter(isUnresolved).length;
      if (open > 0) {
        return c.json({ error: `${open} field${open === 1 ? "" : "s"} with conflicting sources need a decision` }, 409);
      }
      if (queue.live(writeDedupeKey(p.candidateId))) {
        return c.json({ error: "A write or undo is already running for this release" }, 409);
      }
      // Asking to write is the approval (the review UI is where it is decided).
      setProposalState(db, p.id, "approved", now());
      return c.json(toJobDto(enqueueWrite(queue, p.candidateId, p.id)), 202);
    })
    .get("/library/releases/:id{[0-9]+}/history", (c) => {
      const id = Number(c.req.param("id"));
      if (!db.prepare("SELECT 1 FROM candidate WHERE id = ?").get(id)) return c.json({ error: "not found" }, 404);
      const job = queue.live(writeDedupeKey(id));
      const body: HistoryResponse = { batches: history(db, id, !!job), job: job ? toJobDto(job) : null };
      return c.json(body);
    })
    .post("/batches/:id{[0-9]+}/undo", (c) => {
      if (deps.readOnly) return c.json(READ_ONLY, 403);
      const b = db.prepare("SELECT id, kind, status, candidate_id, files_written FROM write_batch WHERE id = ?").get(
        Number(c.req.param("id")),
      ) as { id: number; kind: string; status: string; candidate_id: number | null; files_written: number } | undefined;
      if (!b) return c.json({ error: "not found" }, 404);
      if (b.kind !== "write" || !(b.status === "done" || b.status === "partial") || b.files_written === 0) {
        return c.json({ error: "This batch cannot be undone" }, 409);
      }
      if (b.candidate_id === null) return c.json({ error: "The release no longer exists" }, 409);
      if (queue.live(writeDedupeKey(b.candidate_id))) {
        return c.json({ error: "A write or undo is already running for this release" }, 409);
      }
      return c.json(toJobDto(enqueueUndo(queue, b.candidate_id, b.id)), 202);
    });
}
