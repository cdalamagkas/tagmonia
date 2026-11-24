/**
 * The `identify` job: one per candidate (dedupe key `identify:<id>`), enqueued
 * by a scan for new or changed candidates (§7 step 5). Identification only
 * reads files' stored tags and calls MusicBrainz; it never touches the library,
 * so it also runs in read-only mode.
 */
import { z } from "zod";
import type { Db } from "../db/db.ts";
import { getRelease, type StoredFile } from "../db/repo/library.ts";
import { markIdentifying, saveIdentifyError, saveIdentifyResult } from "../db/repo/matches.ts";
import { identify, type IdentifyConfig, type MbSource } from "../identify/identify.ts";
import type { FingerprintSource } from "../identify/acoustid_source.ts";
import type { CandidateEvidence } from "../identify/types.ts";
import type { Logger } from "../log.ts";
import { type JobQueue, PermanentJobError } from "./queue.ts";

export const IDENTIFY_JOB = "identify";

const payloadSchema = z.object({ candidateId: z.number().int().positive() });

export interface IdentifyJobDeps {
  db: Db;
  mb: MbSource;
  /** Null when no AcoustID key is configured (D37). */
  fingerprints?: FingerprintSource | null;
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
    })),
    album: mostCommon(tags.map((t) => t.album)),
    albumArtist: albumArtist ?? (artists.size === 1 ? [...artists][0] : undefined),
    barcode: mostCommon(tags.map((t) => t.barcode)),
    catalogNumbers: [...new Set(tags.flatMap((t) => t.catalognumber ?? []))],
    albumMbid: hintMbid ?? mostCommon(tags.map((t) => t.musicbrainz_albumid)),
  };
}

export function registerIdentifyJob(queue: JobQueue, deps: IdentifyJobDeps): void {
  const now = deps.now ?? Date.now;
  queue.register(IDENTIFY_JOB, async ({ job, signal }): Promise<IdentifyJobResult | null> => {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success) throw new PermanentJobError("invalid identify payload");
    const { candidateId } = parsed.data;
    const found = getRelease(deps.db, candidateId);
    // Deleted by a rescan since it was queued: nothing to do.
    if (!found) return null;
    const { content_hash: contentHash } = deps.db.prepare("SELECT content_hash FROM candidate WHERE id = ?").get(
      candidateId,
    ) as { content_hash: string };

    markIdentifying(deps.db, candidateId);
    try {
      const ev = buildEvidence(found.release.mbid, found.files);
      const result = await identify(
        ev,
        deps.mb,
        found.release.folder,
        deps.config(),
        signal,
        deps.fingerprints ?? undefined,
      );
      if (result.fingerprintError) deps.logger.warn("fingerprinting skipped", { error: result.fingerprintError });
      saveIdentifyResult(deps.db, candidateId, contentHash, result, now());
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

export function enqueueIdentify(queue: JobQueue, candidateIds: number[]): void {
  for (const id of candidateIds) {
    queue.enqueue(IDENTIFY_JOB, { candidateId: id }, { dedupeKey: `${IDENTIFY_JOB}:${id}`, maxAttempts: 3 });
  }
}
