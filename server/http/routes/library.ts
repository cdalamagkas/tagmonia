/** Read-only library browser API (Phase 1) and the scan trigger. */
import { Hono } from "hono";
import { z } from "zod";
import type {
  JobDto,
  LibraryFileDto,
  LibrarySummary,
  ReleaseDetail,
  ReleaseList,
  ScanJobDto,
} from "../../../shared/types.ts";
import type { Db } from "../../db/db.ts";
import { getRelease, librarySummary, listReleases, type StoredFile } from "../../db/repo/library.ts";
import { enqueueScan, SCAN_JOB } from "../../jobs/scan.ts";
import type { Job, JobQueue } from "../../jobs/queue.ts";
import type { AuthEnv } from "../auth.ts";

export function toJobDto<P, R>(j: Job): JobDto<P, R> {
  return {
    id: j.id,
    kind: j.kind,
    state: j.state,
    progress: j.progress as P | null,
    result: j.result as R | null,
    error: j.error,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
  };
}

function toFileDto(f: StoredFile): LibraryFileDto {
  return {
    id: f.id,
    path: f.path,
    format: f.format,
    sizeBytes: f.size,
    durationMs: f.durationMs,
    sampleRate: f.sampleRate,
    channels: f.channels,
    bitrateKbps: f.bitrateKbps,
    tags: f.tags,
    pictures: f.pictures,
    readError: f.readError,
    scannedAt: f.scannedAt,
  };
}

const listQuery = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export interface LibraryRouteDeps {
  db: Db;
  queue: JobQueue;
  readOnly: boolean;
}

export function libraryRoutes(deps: LibraryRouteDeps) {
  const { db, queue } = deps;
  return new Hono<AuthEnv>()
    .get("/summary", (c) => {
      const scan = queue.latest(SCAN_JOB);
      const body: LibrarySummary = {
        ...librarySummary(db),
        readOnly: deps.readOnly,
        scan: scan ? (toJobDto(scan) as ScanJobDto) : null,
      };
      return c.json(body);
    })
    .get("/releases", (c) => {
      const q = listQuery.safeParse(c.req.query());
      if (!q.success) return c.json({ error: "invalid query" }, 400);
      const body: ReleaseList = listReleases(db, q.data);
      return c.json(body);
    })
    .get("/releases/:id{[0-9]+}", (c) => {
      const r = getRelease(db, Number(c.req.param("id")));
      if (!r) return c.json({ error: "not found" }, 404);
      const body: ReleaseDetail = { release: r.release, files: r.files.map(toFileDto) };
      return c.json(body);
    })
    // Scanning only reads the library, so it is allowed in read-only mode.
    .post("/scan", (c) => c.json(toJobDto(enqueueScan(queue)) as ScanJobDto, 202));
}

export function jobRoutes(queue: JobQueue) {
  return new Hono<AuthEnv>()
    .get("/:id{[0-9]+}", (c) => {
      const j = queue.get(Number(c.req.param("id")));
      return j ? c.json(toJobDto(j)) : c.json({ error: "not found" }, 404);
    })
    .post("/:id{[0-9]+}/cancel", (c) => {
      const j = queue.cancel(Number(c.req.param("id")));
      return j ? c.json(toJobDto(j)) : c.json({ error: "not found" }, 404);
    });
}
