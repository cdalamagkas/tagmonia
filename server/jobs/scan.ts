/** The `scan` job: one library scan at a time (dedupe key "scan"); `scan_inbox` scans only the inbox. */
import type { Db } from "../db/db.ts";
import type { Logger } from "../log.ts";
import { scanLibrary } from "../scanner/scan.ts";
import type { TagIO } from "../tagio/mod.ts";
import type { JobContext, JobQueue } from "./queue.ts";

export const SCAN_JOB = "scan";
/** The inbox alone, when the watcher saw new files settle (D60); its own kind, so the library's last scan stays shown. */
export const INBOX_SCAN_JOB = "scan_inbox";

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
  /** Called when a scan finished: brings the library list's cache up to date here, not in a page load (D75). */
  afterScan?: () => void;
}

const COUNTS = [
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
] as const;

export function registerScanJob(queue: JobQueue, deps: ScanJobDeps): void {
  const run = async (ctx: JobContext, library: boolean) => {
    // Resolve per run: the mount may appear after startup (e.g. a NAS share).
    const common = {
      db: deps.db,
      tagio: deps.tagio,
      ignore: deps.ignore(),
      logger: deps.logger,
      signal: ctx.signal,
      progress: ctx.progress,
    };
    const inbox = deps.inboxDir
      ? async () => scanLibrary({ ...common, rootReal: await Deno.realPath(deps.inboxDir!), inbox: true })
      : null;
    let result;
    if (library) {
      result = await scanLibrary({ ...common, rootReal: await Deno.realPath(deps.musicDir) });
      if (inbox) {
        const r = await inbox();
        for (const k of COUNTS) result[k] += r[k];
        result.candidatesTouched.push(...r.candidatesTouched);
      }
    } else {
      if (!inbox) return null;
      result = await inbox();
    }
    if (result.candidatesTouched.length) deps.onCandidatesTouched?.(result.candidatesTouched);
    deps.afterScan?.();
    return result;
  };
  queue.register(SCAN_JOB, (ctx) => run(ctx, true));
  queue.register(INBOX_SCAN_JOB, (ctx) => run(ctx, false));
}

export function enqueueScan(queue: JobQueue) {
  return queue.enqueue(SCAN_JOB, {}, { dedupeKey: SCAN_JOB, maxAttempts: 1 });
}

export function enqueueInboxScan(queue: JobQueue) {
  return queue.enqueue(INBOX_SCAN_JOB, {}, { dedupeKey: INBOX_SCAN_JOB, maxAttempts: 1 });
}
