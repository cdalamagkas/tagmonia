/**
 * The `write` and `undo` jobs (§11.3). One write operation per release at a
 * time (shared dedupe key), and never retried: a retry would find its own
 * changes on disk and report every file as changed since review.
 */
import { z } from "zod";
import type { Logger } from "../log.ts";
import { ReadOnlyError, undoBatch, type WriteDeps, writeProposal } from "../write/apply.ts";
import type { BatchResult } from "../write/apply.ts";
import { type Job, type JobQueue, PermanentJobError } from "./queue.ts";

export const WRITE_JOB = "write";
export const UNDO_JOB = "undo";

export interface WriteJobDeps extends WriteDeps {
  logger: Logger;
  /** After a batch wrote anything: music-server rescans hook in here (§13). */
  afterBatch?: (r: BatchResult) => void;
}

/** Write and undo share it: never two write operations on one release at once. */
export function writeDedupeKey(candidateId: number): string {
  return `write:${candidateId}`;
}

function permanent(e: unknown): never {
  if (e instanceof PermanentJobError) throw e;
  throw new PermanentJobError(e instanceof ReadOnlyError ? e.message : (e as Error).message ?? String(e));
}

export function registerWriteJobs(queue: JobQueue, deps: WriteJobDeps): void {
  queue.register(WRITE_JOB, async ({ job, signal }) => {
    const p = z.object({ proposalId: z.number().int().positive() }).safeParse(job.payload);
    if (!p.success) throw new PermanentJobError("invalid write payload");
    try {
      const r = await writeProposal(deps, p.data.proposalId, signal);
      if (r.written > 0) deps.afterBatch?.(r);
      return r;
    } catch (e) {
      permanent(e);
    }
  });
  queue.register(UNDO_JOB, async ({ job, signal }) => {
    const p = z.object({ batchId: z.number().int().positive() }).safeParse(job.payload);
    if (!p.success) throw new PermanentJobError("invalid undo payload");
    try {
      const r = await undoBatch(deps, p.data.batchId, signal);
      if (r.written > 0) deps.afterBatch?.(r);
      return r;
    } catch (e) {
      permanent(e);
    }
  });
}

export function enqueueWrite(queue: JobQueue, candidateId: number, proposalId: number): Job {
  return queue.enqueue(WRITE_JOB, { proposalId }, { dedupeKey: writeDedupeKey(candidateId), maxAttempts: 1 });
}

export function enqueueUndo(queue: JobQueue, candidateId: number, batchId: number): Job {
  return queue.enqueue(UNDO_JOB, { batchId }, { dedupeKey: writeDedupeKey(candidateId), maxAttempts: 1 });
}
