/**
 * The `identify` job: one per candidate (dedupe key `identify:<id>`), enqueued
 * by a scan for new or changed candidates (§7 step 5). Identification only
 * reads files' stored tags and calls MusicBrainz; it never touches the library,
 * so it also runs in read-only mode.
 */
import { z } from "zod";
import { mbidSchema } from "../providers/musicbrainz/schema.ts";
import type { Db } from "../db/db.ts";
import { getRelease, type StoredFile } from "../db/repo/library.ts";
import { markIdentifying, saveIdentifyError, saveIdentifyResult } from "../db/repo/matches.ts";
import { identify, type IdentifyConfig, type MbSource } from "../identify/identify.ts";
import type { FingerprintSource } from "../identify/acoustid_source.ts";
import type { CandidateEvidence } from "../identify/types.ts";
import type { SearchTerms } from "../../shared/types.ts";
import { getSearchTerms } from "../db/repo/search_terms.ts";
import type { Logger } from "../log.ts";
import { type Job, type JobQueue, PermanentJobError } from "./queue.ts";
import { autoPropose } from "./propose.ts";

export const IDENTIFY_JOB = "identify";

const payloadSchema = z.object({
  candidateId: z.number().int().positive(),
  /** §8 order 5: a release the user chose. */
  releaseMbid: mbidSchema.optional(),
});

export interface IdentifyJobDeps {
  db: Db;
  mb: MbSource;
  /**
   * Null when no AcoustID key is configured (D37). A function is asked on every
   * run, so a key saved on the providers page applies without a restart (D46).
   */
  fingerprints?: FingerprintSource | null | (() => Promise<FingerprintSource | null>);
  /** Read per run so settings edits apply to the next identification. */
  config: () => IdentifyConfig;
  logger: Logger;
  now?: () => number;
}

export interface IdentifyJobResult {
  candidateId: number;
  verdict: string;
  bestScore: number | null;
  methodsTried: string[];
}

/** The value most files agree on; ties go to the first seen, so the result is stable. */
function mostCommon(values: (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) if (v?.trim()) counts.set(v.trim(), (counts.get(v.trim()) ?? 0) + 1);
  let best: string | undefined, n = 0;
  for (const [v, c] of counts) {
    if (c > n) [best, n] = [v, c];
  }
  return best;
}

export function buildEvidence(hintMbid: string | null, files: StoredFile[]): CandidateEvidence {
  const readable = files.filter((f) => !f.readError);
  const tags = readable.map((f) => f.tags);
  const albumArtist = mostCommon(tags.map((t) => t.albumartist));
  // Without an album artist tag, a track artist shared by every file is the album artist.
  const artists = new Set(tags.map((t) => t.artist?.trim()).filter(Boolean));
  return {
    files: readable.map((f) => ({
      fileId: f.id,
      path: f.path,
      durationMs: f.durationMs,
      title: f.tags.title,
      tracknumber: f.tags.tracknumber,
      discnumber: f.tags.discnumber,
      totaltracks: f.tags.totaltracks,
      totaldiscs: f.tags.totaldiscs,
    })),
    album: mostCommon(tags.map((t) => t.album)),
    albumArtist: albumArtist ?? (artists.size === 1 ? [...artists][0] : undefined),
    barcode: mostCommon(tags.map((t) => t.barcode)),
    catalogNumbers: [...new Set(tags.flatMap((t) => t.catalognumber ?? []))],
    albumMbid: hintMbid ?? mostCommon(tags.map((t) => t.musicbrainz_albumid)),
  };
}

/**
 * The user's search terms in place of what the files say (D63): the album and its artist, and for a one-file
 * release the track's title. Used to search and to score, so a release that fits the terms ranks first.
 */
export function applySearchTerms(ev: CandidateEvidence, terms: SearchTerms | null): CandidateEvidence {
  if (!terms) return ev;
  const single = ev.files.length === 1;
  return {
    ...ev,
    album: terms.album ?? ev.album,
    albumArtist: terms.artist ?? ev.albumArtist,
    files: single && terms.title ? [{ ...ev.files[0], title: terms.title }] : ev.files,
  };
}

export function registerIdentifyJob(queue: JobQueue, deps: IdentifyJobDeps): void {
  const now = deps.now ?? Date.now;
  queue.register(IDENTIFY_JOB, async ({ job, signal }): Promise<IdentifyJobResult | null> => {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success) throw new PermanentJobError("invalid identify payload");
    const { candidateId, releaseMbid } = parsed.data;
    const found = getRelease(deps.db, candidateId);
    // Deleted by a rescan since it was queued: nothing to do.
    if (!found) return null;
    const { content_hash: contentHash } = deps.db.prepare("SELECT content_hash FROM candidate WHERE id = ?").get(
      candidateId,
    ) as { content_hash: string };

    markIdentifying(deps.db, candidateId);
    try {
      const ev = applySearchTerms(buildEvidence(found.release.mbid, found.files), getSearchTerms(deps.db, candidateId));
      const fp = typeof deps.fingerprints === "function" ? await deps.fingerprints() : deps.fingerprints;
      const result = await identify(
        ev,
        deps.mb,
        found.release.folder,
        deps.config(),
        signal,
        fp ?? undefined,
        { manualMbid: releaseMbid },
      );
      if (result.fingerprintError) deps.logger.warn("fingerprinting skipped", { error: result.fingerprintError });
      saveIdentifyResult(deps.db, candidateId, contentHash, result, now());
      // Confident and unambiguous: prepare the proposal so the review is ready (§10).
      if (result.verdict === "matched") autoPropose(deps.db, queue, candidateId, result.ranked[0].releaseId);
      if (result.skipped.length) deps.logger.warn("releases skipped", { candidateId, skipped: result.skipped });
      return {
        candidateId,
        verdict: result.verdict,
        bestScore: result.ranked[0]?.score ?? null,
        methodsTried: result.methodsTried,
      };
    } catch (e) {
      const final = e instanceof PermanentJobError || job.attempts >= job.maxAttempts || signal.aborted;
      if (final) saveIdentifyError(deps.db, candidateId, e instanceof Error ? e.message : String(e), now());
      throw e;
    }
  });
}

export function identifyDedupeKey(candidateId: number): string {
  return `${IDENTIFY_JOB}:${candidateId}`;
}

/** Returns the jobs, which are the already-live ones for candidates that are queued or running. */
export function enqueueIdentify(queue: JobQueue, candidateIds: number[], releaseMbid?: string): Job[] {
  return candidateIds.map((id) =>
    queue.enqueue(IDENTIFY_JOB, { candidateId: id, ...(releaseMbid ? { releaseMbid } : {}) }, {
      dedupeKey: identifyDedupeKey(id),
      maxAttempts: 3,
    })
  );
}
