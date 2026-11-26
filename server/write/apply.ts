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
import type { AudioFormat, CanonicalField, CanonicalTags, TagChange, TagIO } from "../tagio/mod.ts";
import { verifyChange } from "../tagio/mod.ts";
import { changedSinceWrite, inverseChange, plansFromProposal, staleFields } from "./change.ts";
import { tagsAfter } from "../files/rename.ts";
import { basename, dirname } from "node:path";
import { sha256Hex } from "../covers/fetch.ts";
import { folderCoverPath, readFolderCover, removeFolderCover, writeFolderCover } from "../covers/folder.ts";
import { coverWrites, getCover } from "../db/repo/covers.ts";
import type { Picture } from "../tagio/mod.ts";
import { backupPictures, type PictureRef, pictureShas, readBlob, restorePictures, storeBlob } from "./blobs.ts";
import { applyRenames, planRenames, type RenamePlan, undoRenames } from "../files/rename.ts";

export interface WriteDeps {
  db: Db;
  tagio: TagIO;
  musicDir: string;
  readOnly: boolean;
  logger: Logger;
  now?: () => number;
  /** Cover art (D49): the downloaded images, and where pictures are backed up before a write. */
  covers?: { read(sha256: string, mime: string): Promise<Uint8Array>; backupDir: string } | null;
  /** Renaming on write (D57): the template in use, and whether library albums are renamed; read per write. */
  naming?: () => { template: string; renameLibrary: boolean };
}

/**
 * The renaming a write of this proposal makes (D57), from the files' tags after the write: the tags it
 * writes applied to what each file has. Only the proposal's own files move; every other path in the
 * library is a name they cannot take. Null when renaming is off.
 */
export function renamePlanFor(
  db: Db,
  naming: { template: string; renameLibrary: boolean } | undefined,
  proposal: { candidateId: number; fields: ReviewedRow[] },
  written = false,
): RenamePlan | null {
  if (!naming?.renameLibrary) return null;
  const plans = plansFromProposal(proposal.fields.map(reviewed));
  const ids = [...new Set(proposal.fields.map((f) => f.fileId))];
  const rows = ids.map((id) =>
    db.prepare("SELECT id, path, current_tags FROM library_file WHERE id = ? AND read_error IS NULL").get(id) as
      | { id: number; path: string; current_tags: string }
      | undefined
  ).filter((r) => !!r);
  const files = rows.map((r) => ({
    id: r.id,
    path: r.path,
    // After the write the files already hold the written tags.
    tags: written ? JSON.parse(r.current_tags) : tagsAfter(JSON.parse(r.current_tags), plans.get(r.id)?.change),
  }));
  const taken = (db.prepare("SELECT path FROM library_file").all() as { path: string }[]).map((r) => r.path);
  return planRenames(naming.template, files, taken);
}

type ReviewedRow = {
  fileId: number;
  field: CanonicalField;
  current: unknown;
  proposed: unknown;
  edited: unknown;
  status: "changed" | "added" | "unchanged";
  decision: "auto" | "accepted" | "kept_current" | "edited";
  locked: boolean;
};

const reviewed = (f: ReviewedRow) => ({
  fileId: f.fileId,
  field: f.field,
  current: f.current,
  proposed: f.proposed,
  edited: f.edited,
  status: f.status,
  decision: f.decision,
  locked: f.locked,
});

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
  data: {
    kind?: "tags" | "folder_image";
    before?: CanonicalTags;
    change?: TagChange;
    after?: CanonicalTags;
    picturesBefore?: PictureRef[] | null;
    status: string;
    error?: string;
  },
): number {
  return (db.prepare(
    `INSERT INTO file_backup (write_batch_id, file_id, path, tags_before, change, tags_after, status, error, kind,
                              pictures_before)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).get(
    batchId,
    file.id,
    file.path,
    data.before ? JSON.stringify(data.before) : null,
    data.change ? JSON.stringify(withoutPictures(data.change)) : null,
    data.after ? JSON.stringify(data.after) : null,
    data.status,
    data.error ?? null,
    data.kind ?? "tags",
    data.picturesBefore ? JSON.stringify(data.picturesBefore) : null,
  ) as { id: number }).id;
}

/** The stored change keeps tags only: picture bytes live in the blob store, referenced by pictures_before/after. */
function withoutPictures(change: TagChange): TagChange {
  const { pictures: _p, ...rest } = change;
  return rest;
}

/** Puts the new front cover first and keeps every other picture (back, booklet…). */
function withFront(pictures: Picture[], front: Picture): Picture[] {
  return [front, ...pictures.filter((p) => p.type !== "front")];
}

async function sameShas(a: Picture[], expected: string[]): Promise<boolean> {
  const got = await pictureShas(a);
  const want = [...expected].sort();
  return got.length === want.length && got.every((s, i) => s === want[i]);
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
async function refreshAfterWrite(
  db: Db,
  abs: string,
  fileId: number,
  tags: CanonicalTags,
  now: number,
  pictures?: Picture[],
) {
  const st = await Deno.stat(abs);
  db.prepare("UPDATE library_file SET size = ?, mtime_ms = ?, current_tags = ?, scanned_at = ? WHERE id = ?").run(
    st.size,
    Math.round(st.mtime?.getTime() ?? 0),
    JSON.stringify(tags),
    now,
    fileId,
  );
  // The scanner's picture metadata, so the next proposal compares covers against what is now in the file.
  if (pictures) {
    db.prepare("UPDATE library_file SET pictures = ? WHERE id = ?").run(
      JSON.stringify(pictures.map((p) => ({ type: p.type, mime: p.mime, size: p.size ?? p.data.length }))),
      fileId,
    );
  }
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
  const cover = getCover(db, proposal.id);
  const coverPlan = coverWrites(cover);
  if ((coverPlan.embed || coverPlan.folder) && !deps.covers) throw new Error("cover art is not configured");
  let front: Picture | null = null;
  if (coverPlan.embed && cover?.embed) {
    front = {
      type: "front",
      mime: cover.embed.mime,
      data: await deps.covers!.read(cover.embed.sha256, cover.embed.mime),
    };
    // Every mapped file gets the cover, including files whose tags need no change.
    for (const fileId of new Set(proposal.fields.map((f) => f.fileId))) {
      if (!plans.has(fileId)) plans.set(fileId, { change: { set: {}, remove: [] }, expected: {} });
    }
  }
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
    // Picture bytes are read only when the cover changes: they are what the backup must keep.
    const read = await tagio.read(abs, { pictureData: !!front });
    const before = read.tags;
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
    const change: TagChange = front ? { ...plan.change, pictures: withFront(read.pictures, front) } : plan.change;
    // 2. Backup before touching the file, so a crash mid-write still leaves a record to undo from.
    let picturesBefore: PictureRef[] | null = null;
    try {
      if (front) picturesBefore = await backupPictures(deps.covers!.backupDir, read.pictures);
    } catch (e) {
      failed++;
      recordFile(db, batchId, file, { before, status: "failed", error: `picture backup: ${(e as Error).message}` });
      continue;
    }
    const backupId = recordFile(db, batchId, file, {
      before,
      change,
      picturesBefore,
      status: "failed",
      error: "interrupted",
    });
    try {
      // 3. Atomic write (temp copy, fsync, rename) inside TagIO.
      await tagio.write(abs, change);
      // 4. Read back; exact comparison, no normalisation; pictures by content hash.
      const back = await tagio.read(abs, { pictureData: !!front });
      const after = back.tags;
      const mismatches: string[] = verifyChange((file.format ?? "flac") as AudioFormat, change, after)
        .map((m) => m.field);
      if (change.pictures && !(await sameShas(back.pictures, await pictureShas(change.pictures)))) {
        mismatches.push("pictures");
      }
      if (mismatches.length) {
        const fields = mismatches.join(", ");
        const inverse: TagChange = {
          ...inverseChange(before, plan.change),
          ...(front ? { pictures: read.pictures } : {}),
        };
        await tagio.write(abs, inverse);
        const reread = await tagio.read(abs, { pictureData: !!front });
        const restored = reread.tags;
        await refreshAfterWrite(db, abs, file.id, restored, now(), front ? reread.pictures : undefined);
        failed++;
        // The restore is verified like any write: never report a file as restored when it is not.
        const restoreOk = verifyChange((file.format ?? "flac") as AudioFormat, inverse, restored).length === 0 &&
          (!front || await sameShas(reread.pictures, await pictureShas(read.pictures)));
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
      await refreshAfterWrite(db, abs, file.id, after, now(), front ? back.pictures : undefined);
      db.prepare(
        "UPDATE file_backup SET status = 'written', tags_after = ?, pictures_after = ?, error = NULL WHERE id = ?",
      ).run(
        JSON.stringify(after),
        front ? JSON.stringify(await backupRefs(back.pictures)) : null,
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

  if (coverPlan.folder && cover?.folder && cover.folderPath && !signal?.aborted) {
    const r = await writeFolderImage(deps, rootReal, batchId, cover.folderPath, cover.folder, cover.folderCurrent);
    if (r === "written") written++;
    else if (r === "skipped") skipped++;
    else failed++;
  }

  // Renaming (D57): only once every file's tags are written and verified, all or nothing for the album.
  let renameError: string | null = null;
  const naming = deps.naming?.();
  if (naming?.renameLibrary && !proposal.renameSkip && !signal?.aborted) {
    if (failed > 0 || skipped > 0) {
      renameError = "not renamed: some files were not written";
    } else {
      try {
        const plan = renamePlanFor(db, naming, proposal, true)!;
        const moved = await applyRenames(db, rootReal, batchId, plan, proposal.candidateId);
        // A rename-only write: the moved files are what it wrote.
        if (written === 0) written = moved;
      } catch (e) {
        renameError = (e as Error).message;
        deps.logger.warn("renaming failed; the tags are written", { error: renameError });
      }
    }
  }

  await refreshCandidateHash(db, proposal.candidateId);
  let status = statusOf(written, skipped, failed);
  if (renameError && status === "done") status = "partial";
  transaction(db, () => {
    finishBatch(db, batchId, { status, written, skipped, failed }, renameError, now());
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

/** References for the pictures now in a file (their bytes are the written cover and kept pictures, D49). */
async function backupRefs(pictures: Picture[]): Promise<PictureRef[]> {
  return await Promise.all(pictures.map(async (p) => ({
    type: p.type,
    mime: p.mime,
    ...(p.description ? { description: p.description } : {}),
    sha256: await sha256Hex(p.data),
  })));
}

/**
 * cover.jpg in the album folder: refused when it changed since the review saw it,
 * backed up (if there was one), written atomically, and read back.
 */
async function writeFolderImage(
  deps: WriteDeps,
  rootReal: string,
  batchId: number,
  rel: string,
  image: { sha256: string; mime: string },
  expectedSha: string | null,
): Promise<"written" | "skipped" | "failed"> {
  const { db } = deps;
  const file = { id: null, path: rel };
  try {
    const abs = await folderCoverPath(rootReal, dirname(rel) === "." ? "" : dirname(rel), basename(rel));
    const current = await readFolderCover(abs);
    if ((current?.sha256 ?? null) !== expectedSha) {
      recordFile(db, batchId, file, {
        kind: "folder_image",
        status: "skipped_stale",
        error: "the folder image changed since review",
      });
      return "skipped";
    }
    const before: PictureRef[] = current
      ? [{ type: "front", mime: image.mime, sha256: await storeBlob(deps.covers!.backupDir, current.bytes) }]
      : [];
    const id = recordFile(db, batchId, file, {
      kind: "folder_image",
      picturesBefore: before,
      status: "failed",
      error: "interrupted",
    });
    const bytes = await deps.covers!.read(image.sha256, image.mime);
    await writeFolderCover(abs, bytes);
    const back = await readFolderCover(abs);
    if (back?.sha256 !== image.sha256) {
      db.prepare("UPDATE file_backup SET error = ? WHERE id = ?").run("did not read back as written", id);
      return "failed";
    }
    db.prepare("UPDATE file_backup SET status = 'written', pictures_after = ?, error = NULL WHERE id = ?").run(
      JSON.stringify([{ type: "front", mime: image.mime, sha256: image.sha256 }]),
      id,
    );
    return "written";
  } catch (e) {
    deps.logger.error("folder image write failed", { path: rel, error: (e as Error).message });
    recordFile(db, batchId, file, { kind: "folder_image", status: "failed", error: (e as Error).message });
    return "failed";
  }
}

interface BackupRow {
  id: number;
  file_id: number | null;
  path: string;
  kind: "tags" | "folder_image";
  tags_before: string | null;
  change: string | null;
  tags_after: string | null;
  pictures_before: string | null;
  pictures_after: string | null;
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
    `SELECT id, file_id, path, kind, tags_before, change, tags_after, pictures_before, pictures_after FROM file_backup
     WHERE write_batch_id = ? AND status = 'written'`,
  ).all(batchId) as unknown as BackupRow[];
  const rootReal = await Deno.realPath(deps.musicDir);
  const undoId = startBatch(db, "undo", batch.candidate_id, batch.proposal_id, batchId, now());
  let written = 0, skipped = 0, failed = 0;
  // Names first (D57): the backups know each file by the path it had when it was written.
  const { moved, blocked } = await undoRenames(db, rootReal, batchId, undoId, batch.candidate_id);

  for (const b of backups) {
    if (signal?.aborted) break;
    const file = { id: b.file_id, path: b.path };
    const stuck = blocked.get(b.path);
    if (stuck) {
      skipped++;
      recordFile(db, undoId, file, { status: "skipped_changed", error: stuck });
      continue;
    }
    if (b.kind === "folder_image") {
      const r = await undoFolderImage(deps, rootReal, undoId, b);
      if (r === "written") written++;
      else if (r === "skipped") skipped++;
      else failed++;
      continue;
    }
    try {
      const abs = await resolveInRoot(rootReal, b.path);
      const before: CanonicalTags = JSON.parse(b.tags_before!);
      const change: TagChange = JSON.parse(b.change!);
      const after: CanonicalTags = JSON.parse(b.tags_after!);
      const picsBefore: PictureRef[] | null = b.pictures_before ? JSON.parse(b.pictures_before) : null;
      const picsAfter: PictureRef[] | null = b.pictures_after ? JSON.parse(b.pictures_after) : null;
      const withPictures = picsBefore !== null && picsAfter !== null;
      const current = await tagio.read(abs, { pictureData: withPictures });
      const onDisk = current.tags;
      // Someone changed these fields since Tagmonia wrote them: their edit wins over our undo.
      const changed: string[] = changedSinceWrite(onDisk, after, change);
      if (withPictures && !(await sameShas(current.pictures, picsAfter.map((p) => p.sha256)))) changed.push("pictures");
      if (changed.length) {
        skipped++;
        recordFile(db, undoId, file, {
          before: onDisk,
          status: "skipped_changed",
          error: `changed since the write: ${changed.join(", ")}`,
        });
        continue;
      }
      const inverse: TagChange = {
        ...inverseChange(before, change),
        ...(withPictures ? { pictures: await restorePictures(deps.covers!.backupDir, picsBefore) } : {}),
      };
      const rowId = recordFile(db, undoId, file, {
        before: onDisk,
        change: inverse,
        picturesBefore: withPictures ? picsAfter : null,
        status: "failed",
        error: "interrupted",
      });
      await tagio.write(abs, inverse);
      const reread = await tagio.read(abs, { pictureData: withPictures });
      const restored = reread.tags;
      const format = (db.prepare("SELECT format FROM library_file WHERE path = ?").get(b.path) as
        | { format: string | null }
        | undefined)?.format ?? "flac";
      const mismatches: string[] = verifyChange(format as AudioFormat, inverse, restored).map((m) => m.field);
      if (withPictures && !(await sameShas(reread.pictures, picsBefore.map((p) => p.sha256)))) {
        mismatches.push("pictures");
      }
      if (b.file_id !== null) {
        await refreshAfterWrite(db, abs, b.file_id, restored, now(), withPictures ? reread.pictures : undefined);
      }
      if (mismatches.length) {
        failed++;
        db.prepare("UPDATE file_backup SET status = 'failed', tags_after = ?, error = ? WHERE id = ?").run(
          JSON.stringify(restored),
          `did not read back as before: ${mismatches.join(", ")}`,
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
  // A rename-only write has no tag backups: moving the files back is the whole undo.
  if (backups.length === 0) written += moved;
  const status = statusOf(written, skipped + (backups.length === 0 ? blocked.size : 0), failed);
  transaction(db, () => {
    finishBatch(db, undoId, { status, written, skipped, failed }, null, now());
    if (status === "done") {
      db.prepare("UPDATE write_batch SET status = 'undone' WHERE id = ?").run(batchId);
      // The proposal can be reviewed and written again. Every file has exactly the tags the proposal
      // was built from again, so it is current for the files as they are now (their mtimes changed).
      if (batch.proposal_id !== null) {
        setProposalState(db, batch.proposal_id, "needs_review", now());
        if (batch.candidate_id !== null) {
          db.prepare(
            "UPDATE proposal SET based_on_hash = (SELECT content_hash FROM candidate WHERE id = ?) WHERE id = ?",
          ).run(batch.candidate_id, batch.proposal_id);
        }
      }
    }
  });
  return { batchId: undoId, status, written, skipped, failed };
}

/** Puts the folder image back as it was, or removes it if the write created it; never over someone else's change. */
async function undoFolderImage(
  deps: WriteDeps,
  rootReal: string,
  undoId: number,
  b: BackupRow,
): Promise<"written" | "skipped" | "failed"> {
  const file = { id: null, path: b.path };
  try {
    const before: PictureRef[] = JSON.parse(b.pictures_before ?? "[]");
    const after: PictureRef[] = JSON.parse(b.pictures_after ?? "[]");
    const abs = await folderCoverPath(rootReal, dirname(b.path) === "." ? "" : dirname(b.path), basename(b.path));
    const current = await readFolderCover(abs);
    if (current?.sha256 !== after[0]?.sha256) {
      recordFile(deps.db, undoId, file, {
        kind: "folder_image",
        status: "skipped_changed",
        error: "the folder image changed since the write",
      });
      return "skipped";
    }
    const id = recordFile(deps.db, undoId, file, {
      kind: "folder_image",
      picturesBefore: after,
      status: "failed",
      error: "interrupted",
    });
    if (before.length === 0) {
      await removeFolderCover(abs);
      if (await readFolderCover(abs)) return "failed";
    } else {
      await writeFolderCover(abs, await readBlob(deps.covers!.backupDir, before[0].sha256));
      if ((await readFolderCover(abs))?.sha256 !== before[0].sha256) return "failed";
    }
    deps.db.prepare("UPDATE file_backup SET status = 'written', pictures_after = ?, error = NULL WHERE id = ?").run(
      JSON.stringify(before),
      id,
    );
    return "written";
  } catch (e) {
    recordFile(deps.db, undoId, file, { kind: "folder_image", status: "failed", error: (e as Error).message });
    return "failed";
  }
}
