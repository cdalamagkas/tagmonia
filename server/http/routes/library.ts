/** Read-only library browser API (Phase 1) and the scan trigger. */
import { Hono } from "hono";
import { z } from "zod";
import type {
  CoverProposalDto,
  CurrentCoverDto,
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
import { REFRESH_JOB } from "../../jobs/refresh.ts";
import { identificationState, matchesFor, type StoredMatch } from "../../db/repo/matches.ts";
import { enqueueIdentify, identifyDedupeKey } from "../../jobs/identify.ts";
import { releaseMbidFromInput } from "../../identify/manual.ts";
import { isUnresolved, latestProposal, locksFor, providerMatches } from "../../db/repo/proposals.ts";
import { coverWrites, getCover } from "../../db/repo/covers.ts";
import { type CurrentCovers, THUMB_SIZES, type ThumbSize } from "../../covers/current.ts";
import type { CachedImage } from "../../covers/fetch.ts";
import { enqueuePropose, enqueueProviderPropose, proposeDedupeKey } from "../../jobs/propose.ts";
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
const proposeBody = z.union([
  z.object({ releaseMbid: mbidSchema }).strict(),
  z.object({ providerUrl: z.string().max(500) }).strict(),
]);

const SOURCE_NAMES: Record<string, string> = {
  deezer: "Deezer",
  itunes: "iTunes",
  discogs: "Discogs",
  bandcamp: "Bandcamp",
};

/** A provider release link the user gave, checked before any request (§14.5): https, a known host, a release page. */
function checkProviderUrl(sources: LibraryRouteDeps["sources"], raw: string): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: "That is not a link" };
  }
  const provider = url.protocol === "https:" ? sources?.providerFor(url) : undefined;
  if (!provider || !(provider in SOURCE_NAMES)) {
    return { error: "Paste a Deezer, iTunes, Discogs or Bandcamp album link (https://…)" };
  }
  if (!sources!.enabled(provider)) {
    return { error: `${SOURCE_NAMES[provider]} is switched off on the providers page (Settings)` };
  }
  if (!sources!.isReleaseUrl(url)) return { error: `That ${SOURCE_NAMES[provider]} link is not an album page` };
  return { url };
}

const listQuery = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** The proposal's cover for the review, with what the release's files carry now (D49). */
function coverDto(db: Db, proposalId: number, fileIds: number[]): CoverProposalDto | null {
  const c = getCover(db, proposalId);
  if (!c) return null;
  const ids = [...new Set(fileIds)];
  const rows = ids.length
    ? db.prepare(`SELECT pictures FROM library_file WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as {
      pictures: string;
    }[]
    : [];
  const fronts = rows
    .map((r) => (JSON.parse(r.pictures) as { type: string; size: number }[]).find((p) => p.type === "front"))
    .filter((p) => !!p);
  const image = (i: CachedImage | null, which: string) =>
    i && {
      mime: i.mime,
      width: i.width,
      height: i.height,
      size: i.size,
      url: i.url,
      preview: `/api/proposals/${proposalId}/cover/${which}`,
    };
  const w = coverWrites(c);
  return {
    mode: c.mode,
    source: c.source,
    skipped: c.skipped,
    embed: image(c.embed, "embed"),
    folder: image(c.folder, "folder"),
    embedStatus: c.embedStatus,
    folderStatus: c.folderStatus,
    folderPath: c.folderPath,
    decision: c.decision,
    current: { files: rows.length, withFront: fronts.length, sizes: [...new Set(fronts.map((p) => p.size))] },
    writes: w.embed || w.folder,
  };
}

export interface LibraryRouteDeps {
  db: Db;
  queue: JobQueue;
  readOnly: boolean;
  /** Jellyfin, when configured now (§13); credentials can change at runtime (D46). */
  musicServer?: () => Promise<{ name: "jellyfin"; library: string | null } | null>;
  /** Read per request, so the UI shows the thresholds the scores were judged by. */
  thresholds: () => { auto: number; review: number };
  /** The releases' current covers (D50); null = none served. */
  covers?: CurrentCovers | null;
  /** Provider links a proposal can start from (§10.4, D51); null = MusicBrainz releases only. */
  sources?: {
    providerFor(url: URL): string | undefined;
    isReleaseUrl(url: URL): boolean;
    enabled(id: string): boolean;
  } | null;
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
    .get("/summary", async (c) => {
      const scan = queue.latest(SCAN_JOB);
      const refresh = queue.latest(REFRESH_JOB);
      const server = deps.musicServer ? await deps.musicServer() : null;
      const body: LibrarySummary = {
        ...librarySummary(db),
        readOnly: deps.readOnly,
        scan: scan ? (toJobDto(scan) as ScanJobDto) : null,
        musicServer: server ? { ...server, lastRefresh: refresh ? toJobDto(refresh) : null } : null,
      };
      return c.json(body);
    })
    .get("/releases", (c) => {
      const q = listQuery.safeParse(c.req.query());
      if (!q.success) return c.json({ error: "invalid query" }, 400);
      const body: ReleaseList = listReleases(db, q.data);
      return c.json(body);
    })
    // The cover a release has now, as a small JPEG; the ETag changes when the source file does (D50).
    .get("/releases/:id{[0-9]+}/cover", async (c) => {
      const size = c.req.query("size") ?? "thumb";
      if (!(size in THUMB_SIZES)) return c.json({ error: "size must be thumb or large" }, 400);
      const t = deps.covers ? await deps.covers.thumbnail(Number(c.req.param("id")), size as ThumbSize) : null;
      if (!t) return c.json({ error: "no cover" }, 404);
      const headers = {
        "Content-Type": t.mime,
        ETag: t.etag,
        // Revalidated every time: cheap (a 304), and a written cover shows at once.
        "Cache-Control": "private, no-cache",
        "X-Content-Type-Options": "nosniff",
      };
      if (c.req.header("If-None-Match") === t.etag) return c.body(null, 304, headers);
      return c.body(t.bytes as Uint8Array<ArrayBuffer>, 200, headers);
    })
    .get("/releases/:id{[0-9]+}/cover/info", async (c) => {
      const info = deps.covers ? await deps.covers.info(Number(c.req.param("id"))) : null;
      const body: CurrentCoverDto | null = info;
      return c.json({ cover: body });
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
        // Whose values the proposal is built on; only values from another source are "filled by" (D48, D51).
        const primarySource = p.releaseMbid
          ? "musicbrainz"
          : (p.sourceUrl && deps.sources?.providerFor(new URL(p.sourceUrl))) || null;
        proposal = {
          id: p.id,
          releaseMbid: p.releaseMbid,
          sourceUrl: p.sourceUrl,
          primarySource,
          state: p.state,
          chosenBy: p.chosenBy,
          createdAt: p.createdAt,
          stale: p.basedOnHash !== hash,
          counts: {
            changed: count("changed"),
            added: count("added"),
            unchanged: count("unchanged"),
            locked: p.fields.filter((f) => f.locked).length,
            filled: p.fields.filter((f) => f.origin !== primarySource).length,
            conflicts: p.fields.filter(isUnresolved).length,
          },
          unmappedFiles: p.unmappedFiles,
          // The provider's own data stays server-side; the UI needs only the outcome.
          providers: providerMatches(db, p.id).map(({ release: _data, ...m }) => m),
          cover: coverDto(db, p.id, p.fields.map((f) => f.fileId)),
          // Snapshot ids are internal provenance, not part of the API.
          fields: p.fields.map((f) => ({
            ...f,
            sources: f.sources.map(({ snapshotId: _s, ...s }) => s),
          })),
        };
      }
      const body: ProposalResponse = {
        proposal,
        job: job ? toJobDto(job) : null,
        readOnly: deps.readOnly,
        locks: locksFor(db, id),
      };
      return c.json(body);
    })
    // Building a proposal only reads stored tags and MusicBrainz; read-only mode allows it.
    .post("/releases/:id{[0-9]+}/proposal", async (c) => {
      const id = Number(c.req.param("id"));
      if (!identificationState(db, id)) return c.json({ error: "not found" }, 404);
      const body = proposeBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) {
        return c.json({ error: "Give releaseMbid (a MusicBrainz release id) or providerUrl (an album link)" }, 400);
      }
      let providerUrl: URL | null = null;
      if ("providerUrl" in body.data) {
        const checked = checkProviderUrl(deps.sources, body.data.providerUrl);
        if ("error" in checked) return c.json({ error: checked.error }, 400);
        providerUrl = checked.url;
      }
      // Joining a queued automatic proposal would silently drop the user's choice.
      if (queue.live(proposeDedupeKey(id))) {
        return c.json({ error: "A proposal is already being built for this release; try again when it finishes" }, 409);
      }
      const job = providerUrl
        ? enqueueProviderPropose(queue, id, providerUrl.href)
        : enqueuePropose(queue, id, (body.data as { releaseMbid: string }).releaseMbid, "user");
      return c.json(toJobDto(job), 202);
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
