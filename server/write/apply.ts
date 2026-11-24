/**
 * The write procedure (ARCHITECTURE.md §11.3) and undo. Per file: re-read and
 * refuse if it changed since review, back up, write atomically through TagIO,
 * read back and verify, restore on mismatch. Never runs in read-only mode.
 */
import { transaction } from "../db/db.ts";
import type { Db } from "../db/db.ts";
import { getProposal, setProposalState } from "../db/repo/proposals.ts";
import { resolveInRoot } from "../fs/safe_path.ts";
import type { Logger } from "../log.ts";
import { candidateContentHash } from "../scanner/scan.ts";
import type { AudioFormat, CanonicalTags, TagChange, TagIO } from "../tagio/mod.ts";
import { verifyChange } from "../tagio/mod.ts";
import { changedSinceWrite, inverseChange, plansFromProposal, staleFields } from "./change.ts";

export interface WriteDeps {
  db: Db;
  tagio: TagIO;
  musicDir: string;
  readOnly: boolean;
  logger: Logger;
  now?: () => number;
}

export class ReadOnlyError extends Error {
  override name = "ReadOnlyError";
  constructor() {
    super("Tagmonia is in read-only mode (TAGMONIA_READ_ONLY): nothing is written");
  }
}

export type BatchStatus = "running" | "done" | "partial" | "failed" | "undone";

export interface BatchResult {
  batchId: number;
  status: BatchStatus;
  written: number;
  skipped: number;
  failed: number;
}

interface FileRow {
  id: number;
  path: string;
  format: string | null;
  candidate_id: number | null;
}

function startBatch(
  db: Db,
  kind: "write" | "undo",
  candidateId: number | null,
  proposalId: number | null,
  undoes: number | null,
  now: number,
): number {
  return (db.prepare(
    `INSERT INTO write_batch (kind, candidate_id, proposal_id, undoes_batch_id, status, started_at)
     VALUES (?, ?, ?, ?, 'running', ?) RETURNING id`,
  ).get(kind, candidateId, proposalId, undoes, now) as { id: number }).id;
}

function recordFile(
  db: Db,
  batchId: number,
  file: { id: number | null; path: string },
  data: { before?: CanonicalTags; change?: TagChange; after?: CanonicalTags; status: string; error?: string },
): number {
  return (db.prepare(
    `INSERT INTO file_backup (write_batch_id, file_id, path, tags_before, change, tags_after, status, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).get(
    batchId,
    file.id,
    file.path,
    data.before ? JSON.stringify(data.before) : null,
    data.change ? JSON.stringify(data.change) : null,
    data.after ? JSON.stringify(data.after) : null,
    data.status,
    data.error ?? null,
  ) as { id: number }).id;
}

function finishBatch(db: Db, batchId: number, r: Omit<BatchResult, "batchId">, error: string | null, now: number) {
  db.prepare(
    `UPDATE write_batch SET status = ?, files_written = ?, files_skipped = ?, files_failed = ?, error = ?, finished_at = ?
     WHERE id = ?`,
  ).run(r.status, r.written, r.skipped, r.failed, error, now, batchId);
}

function statusOf(written: number, skipped: number, failed: number): BatchStatus {
  if (written === 0) return failed > 0 || skipped > 0 ? "failed" : "done";
  return skipped || failed ? "partial" : "done";
}

/**
 * Keeps the database in step with the file: its new size, mtime and tags, and
 * the release's content hash as the scanner computes it, so the next scan does
 * not see a written release as changed and re-identify it (§11.3 step 5).
 */
async function refreshAfterWrite(db: Db, abs: string, fileId: number, tags: CanonicalTags, now: number) {
  const st = await Deno.stat(abs);
  db.prepare("UPDATE library_file SET size = ?, mtime_ms = ?, current_tags = ?, scanned_at = ? WHERE id = ?").run(
    st.size,
    Math.round(st.mtime?.getTime() ?? 0),
    JSON.stringify(tags),
    now,
    fileId,
  );
}

async function refreshCandidateHash(db: Db, candidateId: number) {
  const files = db.prepare("SELECT path, size, mtime_ms FROM library_file WHERE candidate_id = ?").all(candidateId) as {
    path: string;
    size: number;
    mtime_ms: number;
  }[];
  const hash = await candidateContentHash(files.map((f) => ({ path: f.path, size: f.size, mtimeMs: f.mtime_ms })));
  const row = db.prepare("SELECT content_hash FROM candidate WHERE id = ?").get(candidateId) as
    | { content_hash: string }
    | undefined;
  if (!row) return;
  // Identification still describes these files (only tags changed), so it stays current too.
  db.prepare(
    `UPDATE candidate SET content_hash = ?,
       identified_hash = CASE WHEN identified_hash = ? THEN ? ELSE identified_hash END WHERE id = ?`,
  ).run(hash, row.content_hash, hash, candidateId);
}

export async function writeProposal(deps: WriteDeps, proposalId: number, signal?: AbortSignal): Promise<BatchResult> {
  if (deps.readOnly) throw new ReadOnlyError();
  const now = deps.now ?? Date.now;
  const { db, tagio } = deps;
  const proposal = getProposal(db, proposalId);
  if (!proposal) throw new Error(`proposal ${proposalId} not found`);
  if (proposal.state !== "approved") throw new Error(`proposal ${proposalId} is ${proposal.state}, not approved`);

  const plans = plansFromProposal(proposal.fields.map((f) => ({
    fileId: f.fileId,
    field: f.field,
    current: f.current,
    proposed: f.proposed,
    edited: f.edited,
    status: f.status,
    decision: f.decision,
    locked: f.locked,
  })));
  const rootReal = await Deno.realPath(deps.musicDir);
  const batchId = startBatch(db, "write", proposal.candidateId, proposal.id, null, now());
  let written = 0, skipped = 0, failed = 0;

  for (const [fileId, plan] of plans) {
    if (signal?.aborted) break;
    const file = db.prepare("SELECT id, path, format, candidate_id FROM library_file WHERE id = ?").get(fileId) as
      | FileRow
      | undefined;
    if (!file) {
      skipped++;
      continue;
    }
    let abs: string;
    try {
      abs = await resolveInRoot(rootReal, file.path);
    } catch (e) {
      failed++;
      recordFile(db, batchId, file, { status: "failed", error: (e as Error).message });
      continue;
    }
    // 1. Changed on disk since the review (another tagger, a manual edit): do not overwrite it.
    const before = (await tagio.read(abs, { pictureData: false })).tags;
    const stale = staleFields(before, plan.expected);
    if (stale.length) {
      skipped++;
      recordFile(db, batchId, file, {
        before,
        change: plan.change,
        status: "skipped_stale",
        error: `changed since review: ${stale.join(", ")}`,
      });
      continue;
    }
    // 2. Backup before touching the file, so a crash mid-write still leaves a record to undo from.
    const backupId = recordFile(db, batchId, file, {
      before,
      change: plan.change,
      status: "failed",
      error: "interrupted",
    });
    try {
      // 3. Atomic write (temp copy, fsync, rename) inside TagIO.
      await tagio.write(abs, plan.change);
      // 4. Read back; exact comparison, no normalisation.
      const after = (await tagio.read(abs, { pictureData: false })).tags;
      const mismatches = verifyChange((file.format ?? "flac") as AudioFormat, plan.change, after);
      if (mismatches.length) {
        const fields = mismatches.map((m) => m.field).join(", ");
        const inverse = inverseChange(before, plan.change);
        await tagio.write(abs, inverse);
        const restored = (await tagio.read(abs, { pictureData: false })).tags;
        await refreshAfterWrite(db, abs, file.id, restored, now());
        failed++;
        // The restore is verified like any write: never report a file as restored when it is not.
        const restoreOk = verifyChange((file.format ?? "flac") as AudioFormat, inverse, restored).length === 0;
        db.prepare("UPDATE file_backup SET status = ?, tags_after = ?, error = ? WHERE id = ?").run(
          restoreOk ? "restored" : "failed",
          JSON.stringify(restored),
          restoreOk
            ? `did not read back as written: ${fields}; restored`
            : `did not read back as written (${fields}) and the restore did not either; the original tags are in this backup`,
          backupId,
        );
        if (!restoreOk) deps.logger.error("restore after a failed verify did not read back", { path: file.path });
        continue;
      }
      await refreshAfterWrite(db, abs, file.id, after, now());
      db.prepare("UPDATE file_backup SET status = 'written', tags_after = ?, error = NULL WHERE id = ?").run(
        JSON.stringify(after),
        backupId,
      );
      written++;
    } catch (e) {
      failed++;
      deps.logger.error("tag write failed", { path: file.path, error: (e as Error).message });
      db.prepare("UPDATE file_backup SET status = 'failed', error = ? WHERE id = ?").run(
        (e as Error).message,
        backupId,
      );
    }
  }

  await refreshCandidateHash(db, proposal.candidateId);
  const status = statusOf(written, skipped, failed);
  transaction(db, () => {
    finishBatch(db, batchId, { status, written, skipped, failed }, null, now());
    // Fully written: done. Anything skipped or failed: back to review, so it can be rebuilt and retried.
    setProposalState(db, proposal.id, status === "done" ? "written" : "needs_review", now());
    if (status === "done" && written > 0) {
      const rel = (k: string) => proposal.fields.find((f) => f.field === k)?.proposed;
      db.prepare(
        "UPDATE candidate SET hint_album = coalesce(?, hint_album), hint_artist = coalesce(?, hint_artist), hint_mbid = coalesce(?, hint_mbid) WHERE id = ?",
      )
        .run(
          (rel("album") as string) ?? null,
          (rel("albumartist") as string) ?? null,
          (rel("musicbrainz_albumid") as string) ?? null,
          proposal.candidateId,
        );
    }
  });
  return { batchId, status, written, skipped, failed };
}

interface BackupRow {
  id: number;
  file_id: number | null;
  path: string;
  tags_before: string;
  change: string;
  tags_after: string;
}

/** Re-applies the tags each file had before the batch, through the same atomic, verified path (§11.3). */
export async function undoBatch(deps: WriteDeps, batchId: number, signal?: AbortSignal): Promise<BatchResult> {
  if (deps.readOnly) throw new ReadOnlyError();
  const now = deps.now ?? Date.now;
  const { db, tagio } = deps;
  const batch = db.prepare("SELECT id, kind, status, candidate_id, proposal_id FROM write_batch WHERE id = ?").get(
    batchId,
  ) as
    | { id: number; kind: string; status: BatchStatus; candidate_id: number | null; proposal_id: number | null }
    | undefined;
  if (!batch) throw new Error(`write batch ${batchId} not found`);
  if (batch.kind !== "write" || (batch.status !== "done" && batch.status !== "partial")) {
    throw new Error(`write batch ${batchId} cannot be undone (${batch.kind}, ${batch.status})`);
  }
  const backups = db.prepare(
    `SELECT id, file_id, path, tags_before, change, tags_after FROM file_backup
     WHERE write_batch_id = ? AND status = 'written'`,
  ).all(batchId) as unknown as BackupRow[];
  const rootReal = await Deno.realPath(deps.musicDir);
  const undoId = startBatch(db, "undo", batch.candidate_id, batch.proposal_id, batchId, now());
  let written = 0, skipped = 0, failed = 0;

  for (const b of backups) {
    if (signal?.aborted) break;
    const file = { id: b.file_id, path: b.path };
    try {
      const abs = await resolveInRoot(rootReal, b.path);
      const before: CanonicalTags = JSON.parse(b.tags_before);
      const change: TagChange = JSON.parse(b.change);
      const after: CanonicalTags = JSON.parse(b.tags_after);
      const onDisk = (await tagio.read(abs, { pictureData: false })).tags;
      // Someone changed these fields since Tagmonia wrote them: their edit wins over our undo.
      const changed = changedSinceWrite(onDisk, after, change);
      if (changed.length) {
        skipped++;
        recordFile(db, undoId, file, {
          before: onDisk,
          status: "skipped_changed",
          error: `changed since the write: ${changed.join(", ")}`,
        });
        continue;
      }
      const inverse = inverseChange(before, change);
      const rowId = recordFile(db, undoId, file, {
        before: onDisk,
        change: inverse,
        status: "failed",
        error: "interrupted",
      });
      await tagio.write(abs, inverse);
      const restored = (await tagio.read(abs, { pictureData: false })).tags;
      const format = (db.prepare("SELECT format FROM library_file WHERE path = ?").get(b.path) as
        | { format: string | null }
        | undefined)?.format ?? "flac";
      const mismatches = verifyChange(format as AudioFormat, inverse, restored);
      if (b.file_id !== null) await refreshAfterWrite(db, abs, b.file_id, restored, now());
      if (mismatches.length) {
        failed++;
        db.prepare("UPDATE file_backup SET status = 'failed', tags_after = ?, error = ? WHERE id = ?").run(
          JSON.stringify(restored),
          `did not read back as before: ${mismatches.map((m) => m.field).join(", ")}`,
          rowId,
        );
        continue;
      }
      db.prepare("UPDATE file_backup SET status = 'written', tags_after = ?, error = NULL WHERE id = ?").run(
        JSON.stringify(restored),
        rowId,
      );
      written++;
    } catch (e) {
      failed++;
      recordFile(db, undoId, file, { status: "failed", error: (e as Error).message });
    }
  }

  if (batch.candidate_id !== null) await refreshCandidateHash(db, batch.candidate_id);
  const status = statusOf(written, skipped, failed);
  transaction(db, () => {
    finishBatch(db, undoId, { status, written, skipped, failed }, null, now());
    if (status === "done") {
      db.prepare("UPDATE write_batch SET status = 'undone' WHERE id = ?").run(batchId);
      // The proposal can be reviewed and written again.
      if (batch.proposal_id !== null) setProposalState(db, batch.proposal_id, "needs_review", now());
    }
  });
  return { batchId: undoId, status, written, skipped, failed };
}
