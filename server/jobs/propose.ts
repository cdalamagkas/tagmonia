/**
 * The `propose` job (§10): builds the proposal for one release from a chosen
 * MusicBrainz release. Enqueued automatically when identification is confident
 * ("matched"), or when the user picks a release or edition. Reads stored tags
 * and calls MusicBrainz; never touches the library, so it runs in read-only mode.
 */
import { z } from "zod";
import type { Db } from "../db/db.ts";
import { getRelease } from "../db/repo/library.ts";
import { type ChosenBy, latestProposal, listLocks, saveProposal, saveProviderMatches } from "../db/repo/proposals.ts";
import { type EnrichmentDeps, findOnProviders, linksOf } from "../providers/enrichment.ts";
import { toReleaseView } from "../identify/release.ts";
import { DEFAULT_SCORING, scoreRelease } from "../identify/score.ts";
import type { Logger } from "../log.ts";
import { buildFieldProposals } from "../proposal/build.ts";
import { mergeProviders } from "../proposal/merge.ts";
import { missingParentWorks, tagsFromMusicBrainz } from "../proposal/musicbrainz_tags.ts";
import type { Cited } from "../providers/musicbrainz/client.ts";
import { mbidSchema, type MbRelease, type MbReleaseExtras, type MbWork } from "../providers/musicbrainz/schema.ts";
import { buildEvidence } from "./identify.ts";
import { type Job, type JobQueue, PermanentJobError } from "./queue.ts";

export const PROPOSE_JOB = "propose";

export interface ProposalSource {
  lookupRelease(mbid: string, signal?: AbortSignal): Promise<Cited<MbRelease> | null>;
  lookupReleaseExtras(mbid: string, signal?: AbortSignal): Promise<Cited<MbReleaseExtras> | null>;
  lookupWork(mbid: string, signal?: AbortSignal): Promise<Cited<MbWork> | null>;
}

export interface ProposalSettings {
  /** D27: MusicBrainz genres by default; "none" leaves genre alone. */
  genres: "musicbrainz" | "none";
  maxGenres: number;
}

export interface ProposeJobDeps {
  db: Db;
  mb: ProposalSource;
  /** Deezer, iTunes and Discogs through Harmony (D47); absent = MusicBrainz only. */
  enrichment?: EnrichmentDeps | null;
  settings: () => ProposalSettings;
  logger: Logger;
  now?: () => number;
}

const payloadSchema = z.object({
  candidateId: z.number().int().positive(),
  releaseMbid: mbidSchema,
  chosenBy: z.enum(["auto", "user"]),
});

export interface ProposeJobResult {
  proposalId: number;
  changed: number;
  added: number;
  unchanged: number;
  unmappedFiles: number;
}

/** Parent works are nested (act → opera); a few rounds reach the top of any real work. */
const MAX_WORK_ROUNDS = 3;

export function registerProposeJob(queue: JobQueue, deps: ProposeJobDeps): void {
  const now = deps.now ?? Date.now;
  queue.register(PROPOSE_JOB, async ({ job, signal }): Promise<ProposeJobResult | null> => {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success) throw new PermanentJobError("invalid propose payload");
    const { candidateId, releaseMbid, chosenBy } = parsed.data;
    const found = getRelease(deps.db, candidateId);
    if (!found) return null;
    const { content_hash: contentHash } = deps.db.prepare("SELECT content_hash FROM candidate WHERE id = ?").get(
      candidateId,
    ) as { content_hash: string };

    const rel = await deps.mb.lookupRelease(releaseMbid, signal);
    if (!rel) throw new PermanentJobError(`MusicBrainz has no release ${releaseMbid}`);
    const snapshotIds = [rel.snapshotId];

    const settings = deps.settings();
    // Genres and links to other providers in one request; links are needed even with genres off.
    const extras = await deps.mb.lookupReleaseExtras(rel.value.id, signal);
    if (extras) snapshotIds.push(extras.snapshotId);
    const genres: MbReleaseExtras | null = settings.genres === "musicbrainz" ? extras?.value ?? null : null;

    const parents = new Map<string, MbWork>();
    for (let round = 0; round < MAX_WORK_ROUNDS; round++) {
      const missing = missingParentWorks(rel.value, parents);
      if (missing.length === 0) break;
      for (const id of missing) {
        const w = await deps.mb.lookupWork(id, signal);
        if (w) {
          parents.set(id, w.value);
          snapshotIds.push(w.snapshotId);
        }
      }
    }

    // Map the files as they are now, not as identification saw them: a rescan may have changed them.
    const files = found.files.filter((f) => !f.readError);
    const { mapping } = scoreRelease(
      buildEvidence(found.release.mbid, files),
      toReleaseView(rel.value),
      DEFAULT_SCORING,
    );
    const proposed = tagsFromMusicBrainz({
      release: rel.value,
      genres,
      parentWorks: parents,
      maxGenres: settings.maxGenres,
    });
    // The same release on other providers (D47), merged into the fields by precedence (D48).
    const matches = deps.enrichment
      ? await findOnProviders(deps.enrichment, rel.value, linksOf(extras?.value ?? null))
      : null;
    const merged = mergeProviders(proposed, rel.value, matches ?? []);
    const build = buildFieldProposals({
      candidateId,
      files: files.map((f) => ({ id: f.id, tags: f.tags })),
      mapping: mapping.pairs,
      proposed: merged,
      snapshotId: rel.snapshotId,
      locks: listLocks(deps.db),
      provenance: merged.provenance,
    });
    const proposalId = saveProposal(deps.db, {
      candidateId,
      releaseMbid: rel.value.id,
      chosenBy,
      basedOnHash: contentHash,
      snapshotIds: [...new Set(snapshotIds)],
      build: {
        ...build,
        unmappedFiles: [...build.unmappedFiles, ...found.files.filter((f) => f.readError).map((f) => f.id)],
      },
    }, now());
    if (matches) saveProviderMatches(deps.db, proposalId, matches, now());
    const count = (s: string) => build.fields.filter((f) => f.status === s).length;
    return {
      proposalId,
      changed: count("changed"),
      added: count("added"),
      unchanged: count("unchanged"),
      unmappedFiles: build.unmappedFiles.length,
    };
  });
}

export function proposeDedupeKey(candidateId: number): string {
  return `${PROPOSE_JOB}:${candidateId}`;
}

export function enqueuePropose(queue: JobQueue, candidateId: number, releaseMbid: string, chosenBy: ChosenBy): Job {
  return queue.enqueue(PROPOSE_JOB, { candidateId, releaseMbid, chosenBy }, {
    dedupeKey: proposeDedupeKey(candidateId),
    maxAttempts: 3,
  });
}

/**
 * After a confident identification. Never replaces an unwritten proposal the
 * user chose: a rescan must not silently undo their pick (D40).
 */
export function autoPropose(db: Db, queue: JobQueue, candidateId: number, releaseMbid: string): Job | null {
  const latest = latestProposal(db, candidateId);
  if (latest && latest.chosenBy === "user" && latest.state !== "written" && latest.state !== "discarded") return null;
  return enqueuePropose(queue, candidateId, releaseMbid, "auto");
}
