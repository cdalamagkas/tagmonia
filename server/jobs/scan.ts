/** The `scan` job: one library scan at a time (dedupe key "scan"). */
import type { Db } from "../db/db.ts";
import type { Logger } from "../log.ts";
import { scanLibrary } from "../scanner/scan.ts";
import type { TagIO } from "../tagio/mod.ts";
import type { JobQueue } from "./queue.ts";

export const SCAN_JOB = "scan";

export interface ScanJobDeps {
  db: Db;
  tagio: TagIO;
  musicDir: string;
  /** The inbox (D57): scanned after the library, its paths under `@inbox/`. */
  inboxDir?: string | null;
  /** Read per run so settings edits apply to the next scan. */
  ignore: () => string[];
  logger: Logger;
  /** Called with new or changed candidates after a scan, to enqueue identification (§7 step 5). */
  onCandidatesTouched?: (ids: number[]) => void;
}

export function registerScanJob(queue: JobQueue, deps: ScanJobDeps): void {
  queue.register(SCAN_JOB, async ({ signal, progress }) => {
    // Resolve per run: the mount may appear after startup (e.g. a NAS share).
    const rootReal = await Deno.realPath(deps.musicDir);
    const common = { db: deps.db, tagio: deps.tagio, ignore: deps.ignore(), logger: deps.logger, signal, progress };
    const result = await scanLibrary({ ...common, rootReal });
    if (deps.inboxDir) {
      const inbox = await scanLibrary({ ...common, rootReal: await Deno.realPath(deps.inboxDir), inbox: true });
      for (
        const k of [
          "seen",
          "added",
          "updated",
          "removed",
          "unchanged",
          "unreadable",
          "skippedSymlinks",
          "ignored",
          "unreadableDirs",
          "unitsRegrouped",
          "durationMs",
        ] as const
      ) {
        result[k] += inbox[k];
      }
      result.candidatesTouched.push(...inbox.candidatesTouched);
    }
    if (result.candidatesTouched.length) deps.onCandidatesTouched?.(result.candidatesTouched);
    return result;
  });
}

export function enqueueScan(queue: JobQueue) {
  return queue.enqueue(SCAN_JOB, {}, { dedupeKey: SCAN_JOB, maxAttempts: 1 });
}
