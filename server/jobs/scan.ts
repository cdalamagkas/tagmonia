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
  /** Read per run so settings edits apply to the next scan. */
  ignore: () => string[];
  logger: Logger;
}

export function registerScanJob(queue: JobQueue, deps: ScanJobDeps): void {
  queue.register(SCAN_JOB, async ({ signal, progress }) => {
    // Resolve per run: the mount may appear after startup (e.g. a NAS share).
    const rootReal = await Deno.realPath(deps.musicDir);
    return await scanLibrary({
      db: deps.db,
      tagio: deps.tagio,
      rootReal,
      ignore: deps.ignore(),
      logger: deps.logger,
      signal,
      progress,
    });
  });
}

export function enqueueScan(queue: JobQueue) {
  return queue.enqueue(SCAN_JOB, {}, { dedupeKey: SCAN_JOB, maxAttempts: 1 });
}
