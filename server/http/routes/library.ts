/** Read-only library browser API (Phase 1) and the scan trigger. */
import { Hono } from "hono";
import { z } from "zod";
import type {
  EditionDto,
  IdentificationDto,
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
import { identificationState, matchesFor, type StoredMatch } from "../../db/repo/matches.ts";
import { enqueueIdentify, identifyDedupeKey } from "../../jobs/identify.ts";
import { releaseMbidFromInput } from "../../identify/manual.ts";
import { latestProposal } from "../../db/repo/proposals.ts";
import { enqueuePropose, proposeDedupeKey } from "../../jobs/propose.ts";
import { mbidSchema } from "../../providers/musicbrainz/schema.ts";
import type { ProposalDto, ProposalResponse } from "../../../shared/types.ts";
import type { CandidateStatus } from "../../../shared/types.ts";
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

const identifyBody = z.object({ releaseUrl: z.string().max(500).optional() }).strict();
const proposeBody = z.object({ releaseMbid: mbidSchema }).strict();

const listQuery = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export interface LibraryRouteDeps {
  db: Db;
  queue: JobQueue;
  readOnly: boolean;
  /** Read per request, so the UI shows the thresholds the scores were judged by. */
  thresholds: () => { auto: number; review: number };
}

/**
 * The edition picker (§8.2): every examined release of the best match's release
 * group by score, then the editions the release-group browse found (D38).
 */
export function editionRows(
  matches: StoredMatch[],
  unexamined: { releaseId: string; summary: EditionDto["summary"] }[],
) {
  const best = matches[0];
  if (!best?.releaseGroupMbid) return [];
  const rows: EditionDto[] = matches
    .filter((m) => m.releaseGroupMbid === best.releaseGroupMbid)
    .map((m) => ({ releaseMbid: m.releaseMbid, summary: m.summary, examined: true, score: m.score }));
  const seen = new Set(rows.map((r) => r.releaseMbid));
  const rest = unexamined
    .filter((e) => !seen.has(e.releaseId))
    .sort((a, b) => (a.summary.date ?? "9999").localeCompare(b.summary.date ?? "9999"))
    .map((e) => ({ releaseMbid: e.releaseId, summary: e.summary, examined: false, score: null }));
  return [...rows, ...rest];
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
    .get("/releases/:id{[0-9]+}/identification", (c) => {
      const id = Number(c.req.param("id"));
      const state = identificationState(db, id);
      if (!state) return c.json({ error: "not found" }, 404);
      const matches = matchesFor(db, id);
      const job = queue.live(identifyDedupeKey(id));
      const body: IdentificationDto = {
        status: state.status as CandidateStatus,
        identifiedAt: state.identifiedAt,
        error: state.error,
        stale: state.stale,
        // Snapshot ids are internal provenance, not part of the API.
        matches: matches.map(({ snapshotId: _snapshot, ...m }) => m),
        editions: editionRows(matches, state.unexaminedEditions),
        thresholds: deps.thresholds(),
        job: job ? toJobDto(job) : null,
      };
      return c.json(body);
    })
    // Identification only reads stored tags and calls MusicBrainz, so read-only mode allows it.
    .post("/releases/:id{[0-9]+}/identify", async (c) => {
      const id = Number(c.req.param("id"));
      if (!identificationState(db, id)) return c.json({ error: "not found" }, 404);
      const body = identifyBody.safeParse(await c.req.json().catch(() => ({})));
      if (!body.success) return c.json({ error: "invalid request" }, 400);
      let releaseMbid: string | undefined;
      if (body.data.releaseUrl) {
        releaseMbid = releaseMbidFromInput(body.data.releaseUrl) ?? undefined;
        if (!releaseMbid) return c.json({ error: "Paste a MusicBrainz release link (musicbrainz.org/release/…)" }, 400);
        // Joining a queued automatic run would silently drop the user's choice.
        if (queue.live(identifyDedupeKey(id))) {
          return c.json(
            { error: "Identification is already running for this release; try again when it finishes" },
            409,
          );
        }
      }
      const [job] = enqueueIdentify(queue, [id], releaseMbid);
      return c.json(toJobDto(job), 202);
    })
    .get("/releases/:id{[0-9]+}/proposal", (c) => {
      const id = Number(c.req.param("id"));
      const state = identificationState(db, id);
      if (!state) return c.json({ error: "not found" }, 404);
      const p = latestProposal(db, id);
      const { content_hash: hash } = db.prepare("SELECT content_hash FROM candidate WHERE id = ?").get(id) as {
        content_hash: string;
      };
      const job = queue.live(proposeDedupeKey(id));
      let proposal: ProposalDto | null = null;
      if (p) {
        const count = (s: string) => p.fields.filter((f) => f.status === s).length;
        proposal = {
          id: p.id,
          releaseMbid: p.releaseMbid,
          state: p.state,
          chosenBy: p.chosenBy,
          createdAt: p.createdAt,
          stale: p.basedOnHash !== hash,
          counts: {
            changed: count("changed"),
            added: count("added"),
            unchanged: count("unchanged"),
            locked: p.fields.filter((f) => f.locked).length,
          },
          unmappedFiles: p.unmappedFiles,
          // Snapshot ids are internal provenance, not part of the API.
          fields: p.fields.map((f) => ({
            ...f,
            sources: f.sources.map(({ snapshotId: _s, ...s }) => s),
          })),
        };
      }
      const body: ProposalResponse = { proposal, job: job ? toJobDto(job) : null };
      return c.json(body);
    })
    // Building a proposal only reads stored tags and MusicBrainz; read-only mode allows it.
    .post("/releases/:id{[0-9]+}/proposal", async (c) => {
      const id = Number(c.req.param("id"));
      if (!identificationState(db, id)) return c.json({ error: "not found" }, 404);
      const body = proposeBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "releaseMbid must be a MusicBrainz release id" }, 400);
      // Joining a queued automatic proposal would silently drop the user's choice.
      if (queue.live(proposeDedupeKey(id))) {
        return c.json({ error: "A proposal is already being built for this release; try again when it finishes" }, 409);
      }
      return c.json(toJobDto(enqueuePropose(queue, id, body.data.releaseMbid, "user")), 202);
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
