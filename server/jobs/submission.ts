/**
 * Submitting a release missing from MusicBrainz (§12, D52). Two jobs, both only
 * reading from MusicBrainz (1 request per second): the check before seeding
 * (possible duplicates, and the release-editor form), and the verification of
 * the MBID MusicBrainz sends back, after which the release is proposed from
 * MusicBrainz so its identifiers can be written. Tagmonia never submits anything:
 * the user does, in their own browser.
 */
import { z } from "zod";
import type { Db } from "../db/db.ts";
import { getProposal, providerMatches } from "../db/repo/proposals.ts";
import { getSubmission, updateSubmission } from "../db/repo/submissions.ts";
import type { Logger } from "../log.ts";
import type { SourceProvider } from "../providers/enrichment.ts";
import type { MusicBrainzClient } from "../providers/musicbrainz/client.ts";
import { mbidSchema } from "../providers/musicbrainz/schema.ts";
import { creditText } from "../proposal/harmony_tags.ts";
import { findDuplicates } from "../submission/duplicates.ts";
import { mergedFromMatches, seedFor } from "../submission/seed.ts";
import { type Job, type JobQueue, PermanentJobError } from "./queue.ts";

export const SUBMISSION_CHECK_JOB = "submission_check";
export const SUBMISSION_VERIFY_JOB = "submission_verify";

export type SubmissionClient = Pick<MusicBrainzClient, "searchReleases" | "releasesForUrl" | "lookupReleaseFresh">;

export interface SubmissionJobDeps {
  db: Db;
  /** A MusicBrainz client for the submission's server (musicbrainz.org or the test server). */
  client: (server: string) => SubmissionClient;
  /** The provider of a proposal's source link (D51). */
  providerOf: (url: URL) => SourceProvider | undefined;
  /** After a verified return: build the proposal from the new release, on its server. */
  onReturned: (candidateId: number, releaseMbid: string, server: string) => void;
  logger: Logger;
  now?: () => number;
}

export function registerSubmissionJobs(queue: JobQueue, deps: SubmissionJobDeps): void {
  const now = deps.now ?? Date.now;
  const fail = (id: number, message: string) =>
    updateSubmission(deps.db, id, { state: "failed", error: message }, now());

  queue.register(SUBMISSION_CHECK_JOB, async ({ job, signal }) => {
    const p = z.object({ submissionId: z.number().int().positive() }).safeParse(job.payload);
    if (!p.success) throw new PermanentJobError("invalid submission payload");
    const s = getSubmission(deps.db, p.data.submissionId);
    if (!s || s.state !== "checking") return null;
    const proposal = s.proposalId ? getProposal(deps.db, s.proposalId) : undefined;
    if (!proposal || proposal.releaseMbid || !proposal.sourceUrl) {
      fail(s.id, "The proposal changed since; prepare the submission again");
      return null;
    }
    const primary = deps.providerOf(new URL(proposal.sourceUrl));
    if (!primary) {
      fail(s.id, "The proposal's provider is not available");
      return null;
    }
    try {
      const merged = mergedFromMatches(providerMatches(deps.db, proposal.id), primary);
      const { fetched } = deps.db.prepare(
        "SELECT max(fetched_at) AS fetched FROM provider_release WHERE proposal_id = ?",
      ).get(proposal.id) as { fetched: number | null };
      const trackCount = merged.media.reduce((n, m) => n + m.tracklist.length, 0);
      const duplicates = await findDuplicates(deps.client(s.server), {
        title: merged.title,
        artist: creditText(merged.artists),
        barcode: merged.gtin ? String(merged.gtin) : null,
        trackCount,
        urls: merged.info.providers.map((x) => ({ name: x.name, url: x.url })),
      }, signal);
      const seed = seedFor(merged, {
        returnUrl: new URL(`/mb/callback/${s.id}`, s.returnBase),
        fetchedAt: fetched ?? proposal.createdAt,
      });
      const isrcs = merged.media.flatMap((m) => m.tracklist.map((t) => t.isrc ?? ""));
      updateSubmission(deps.db, s.id, { state: "ready", duplicates, seed, isrcs, error: null }, now());
      return { duplicates: duplicates.length };
    } catch (e) {
      if (signal?.aborted) throw e;
      deps.logger.warn("submission check failed", { submission: s.id, error: (e as Error).message });
      fail(s.id, `Could not prepare the submission: ${(e as Error).message}`.slice(0, 300));
      return null;
    }
  });

  queue.register(SUBMISSION_VERIFY_JOB, async ({ job, signal }) => {
    const p = z.object({ submissionId: z.number().int().positive(), releaseMbid: mbidSchema }).safeParse(job.payload);
    if (!p.success) throw new PermanentJobError("invalid submission payload");
    const s = getSubmission(deps.db, p.data.submissionId);
    if (!s || s.state !== "verifying") return null;
    // §12.2: the MBID from the browser is trusted only once MusicBrainz itself has the release.
    let rel;
    try {
      rel = await deps.client(s.server).lookupReleaseFresh(p.data.releaseMbid, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      updateSubmission(deps.db, s.id, {
        state: "seeded",
        error: `Could not reach ${new URL(s.server).host}: ${(e as Error).message}; try again`.slice(0, 300),
      }, now());
      return null;
    }
    if (!rel) {
      updateSubmission(deps.db, s.id, {
        state: "seeded",
        error: `${new URL(s.server).host} has no release ${p.data.releaseMbid}`,
      }, now());
      return null;
    }
    updateSubmission(deps.db, s.id, { state: "returned", releaseMbid: rel.value.id, error: null }, now());
    deps.onReturned(s.candidateId, rel.value.id, s.server);
    return { releaseMbid: rel.value.id };
  });
}

export function enqueueSubmissionCheck(queue: JobQueue, submissionId: number): Job {
  return queue.enqueue(SUBMISSION_CHECK_JOB, { submissionId }, {
    dedupeKey: `${SUBMISSION_CHECK_JOB}:${submissionId}`,
    maxAttempts: 1,
  });
}

export function enqueueSubmissionVerify(queue: JobQueue, submissionId: number, releaseMbid: string): Job {
  return queue.enqueue(SUBMISSION_VERIFY_JOB, { submissionId, releaseMbid }, {
    dedupeKey: `${SUBMISSION_VERIFY_JOB}:${submissionId}`,
    maxAttempts: 3,
  });
}
