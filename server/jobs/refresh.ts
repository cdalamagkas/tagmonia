/**
 * Music-server rescan after a write batch (§13, D44). Debounced: one queued
 * refresh takes every album folder written since the last one, and it never
 * starts sooner than a minute after the previous one finished.
 */
import type { Db } from "../db/db.ts";
import { type JellyfinClient, JellyfinConfigError } from "../integrations/jellyfin.ts";
import type { Logger } from "../log.ts";
import { type Job, type JobQueue, PermanentJobError } from "./queue.ts";

export const REFRESH_JOB = "music_server_refresh";
export const REFRESH_INTERVAL_MS = 60_000;
export const REFRESH_DEDUPE = "refresh:jellyfin";

export function registerRefreshJob(
  queue: JobQueue,
  deps: { db: Db; jellyfin: JellyfinClient; logger: Logger; now?: () => number },
): void {
  const now = deps.now ?? Date.now;
  queue.register(REFRESH_JOB, async ({ signal }) => {
    const pending = () =>
      (deps.db.prepare("SELECT folder FROM refresh_pending ORDER BY folder").all() as { folder: string }[]).map((r) =>
        r.folder
      );
    const albums = new Set<string>();
    let library: string | null = null;
    let folders = pending();
    // A write during this run cannot start its own job (the dedupe key is held), so its folder
    // is picked up here; a few rounds at most, then the debounce applies again.
    for (let round = 0; round < 5; round++) {
      let r;
      try {
        r = await deps.jellyfin.refreshFolders(folders, signal);
      } catch (e) {
        if (e instanceof JellyfinConfigError) throw new PermanentJobError(e.message);
        throw e;
      }
      library = r.library;
      r.albums.forEach((a) => albums.add(a));
      if (r.unknown.length) {
        deps.logger.info("Jellyfin has no album yet for some folders; scanning the library", { folders: r.unknown });
      }
      const del = deps.db.prepare("DELETE FROM refresh_pending WHERE folder = ? AND queued_at <= ?");
      const ranAt = now();
      for (const f of folders) del.run(f, ranAt);
      folders = pending();
      if (folders.length === 0) break;
    }
    deps.logger.info("Jellyfin refreshed", { albums: albums.size, library: library ?? "(all libraries)" });
    return { server: "jellyfin", library, albums: [...albums] };
  });
}

/** Records the written album folders and makes sure a refresh is queued. */
export function enqueueRefresh(queue: JobQueue, db: Db, folders: string[], now: number = Date.now()): Job {
  const add = db.prepare("INSERT OR IGNORE INTO refresh_pending (folder, queued_at) VALUES (?, ?)");
  for (const f of folders) add.run(f, now);
  const last = queue.latest(REFRESH_JOB, ["done"]);
  const earliest = last?.finishedAt ? last.finishedAt + REFRESH_INTERVAL_MS : now;
  return queue.enqueue(REFRESH_JOB, {}, {
    dedupeKey: REFRESH_DEDUPE,
    runAfter: Math.max(now, earliest),
    maxAttempts: 3,
  });
}

/** The album folder a write or undo batch touched. */
export function folderOfBatch(db: Db, batchId: number): string | null {
  const r = db.prepare(
    "SELECT c.folder FROM write_batch b JOIN candidate c ON c.id = b.candidate_id WHERE b.id = ?",
  ).get(batchId) as { folder: string } | undefined;
  return r?.folder ?? null;
}
