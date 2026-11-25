/**
 * Submitting a release missing from MusicBrainz (§12, D52): prepare (a job checks
 * for duplicates and builds the release-editor form), open the editor in the user's
 * browser, and the callback MusicBrainz redirects to. Nothing here writes files or
 * submits anything to MusicBrainz; read-only mode allows all of it.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { SubmissionDto } from "../../../shared/types.ts";
import type { Db } from "../../db/db.ts";
import { getProposal } from "../../db/repo/proposals.ts";
import {
  createSubmission,
  getSubmission,
  latestSubmission,
  type Submission,
  updateSubmission,
} from "../../db/repo/submissions.ts";
import { enqueueSubmissionCheck, enqueueSubmissionVerify } from "../../jobs/submission.ts";
import type { JobQueue } from "../../jobs/queue.ts";
import type { AuthEnv } from "../auth.ts";

export interface SubmissionRouteDeps {
  db: Db;
  queue: JobQueue;
  /** settings.submission.server, read per request so a change applies at once. */
  server: () => string;
  /** TAGMONIA_PUBLIC_URL, if set; else the browser's own origin. */
  publicUrl?: string;
  now?: () => number;
}

const MBID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const callbackBody = z.object({ release: z.string().max(300) }).strict();

/** An artist the user matched by hand: an MBID or a MusicBrainz artist link; null forgets the choice. */
const artistBody = z.object({ name: z.string().min(1).max(500), artist: z.string().max(300).nullable() }).strict();

/** Where to add cover art and ISRCs once the release exists (§12.2: follow-ups, never automated). */
function followUps(s: Submission): SubmissionDto["followUps"] {
  if (!s.releaseMbid) return null;
  const release = `${s.server}/release/${s.releaseMbid}`;
  let isrcs: string | null = null;
  // MagicISRC submits to musicbrainz.org only.
  if (s.server === "https://musicbrainz.org" && s.isrcs.some(Boolean)) {
    const q = new URLSearchParams(s.isrcs.map((isrc, i) => [`isrc${i + 1}`, isrc]));
    q.set("musicbrainzid", s.releaseMbid);
    q.set("edit-note", `ISRCs from the providers Tagmonia used for ${release}`);
    isrcs = `https://magicisrc.kepstin.ca/?${q}`;
  }
  return { release, addCoverArt: `${release}/add-cover-art`, isrcs };
}

export function toSubmissionDto(s: Submission): SubmissionDto {
  return {
    id: s.id,
    candidateId: s.candidateId,
    proposalId: s.proposalId,
    server: s.server,
    state: s.state,
    duplicates: s.duplicates,
    artists: s.artists,
    releaseMbid: s.releaseMbid,
    error: s.error,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    followUps: followUps(s),
  };
}

const OPEN = new Set(["checking", "ready", "seeded", "verifying"]);

export function submissionRoutes(deps: SubmissionRouteDeps) {
  const { db, queue } = deps;
  const now = deps.now ?? Date.now;
  const mine = (id: number, userId: number) => {
    const s = getSubmission(db, id);
    return s && s.userId === userId ? s : undefined;
  };
  return new Hono<AuthEnv>()
    .get("/library/releases/:id{[0-9]+}/submission", (c) => {
      const s = latestSubmission(db, Number(c.req.param("id")));
      return c.json({ submission: s && s.userId === c.get("session").userId ? toSubmissionDto(s) : null });
    })
    // Prepare: check MusicBrainz for the release and build the editor form, in a job.
    .post("/proposals/:id{[0-9]+}/submission", (c) => {
      const p = getProposal(db, Number(c.req.param("id")));
      if (!p) return c.json({ error: "not found" }, 404);
      if (p.releaseMbid || !p.sourceUrl) {
        return c.json({ error: "Only a release that is not on MusicBrainz can be added to it" }, 409);
      }
      if (p.state === "discarded") return c.json({ error: "This proposal was discarded" }, 409);
      const previous = latestSubmission(db, p.candidateId);
      if (previous && OPEN.has(previous.state)) updateSubmission(db, previous.id, { state: "abandoned" }, now());
      const returnBase = deps.publicUrl ?? c.req.header("Origin") ?? new URL(c.req.url).origin;
      const s = createSubmission(db, {
        candidateId: p.candidateId,
        proposalId: p.id,
        userId: c.get("session").userId,
        server: deps.server(),
        returnBase,
      }, now());
      enqueueSubmissionCheck(queue, s.id);
      return c.json(toSubmissionDto(s), 202);
    })
    // Open: the form the browser posts to the release editor; from now on the callback is expected.
    .post("/submissions/:id{[0-9]+}/open", (c) => {
      const s = mine(Number(c.req.param("id")), c.get("session").userId);
      if (!s) return c.json({ error: "not found" }, 404);
      if ((s.state !== "ready" && s.state !== "seeded") || !s.seed) {
        return c.json({ error: `This submission is ${s.state}` }, 409);
      }
      updateSubmission(db, s.id, { state: "seeded", error: null }, now());
      return c.json({ action: `${s.server}/release/add`, fields: s.seed });
    })
    // MusicBrainz sends the browser back with the new release's MBID (§12.2); verified by a job before use.
    .post("/submissions/:id{[0-9]+}/callback", async (c) => {
      const s = mine(Number(c.req.param("id")), c.get("session").userId);
      if (!s) return c.json({ error: "not found" }, 404);
      const body = callbackBody.safeParse(await c.req.json().catch(() => null));
      const mbid = body.success ? MBID.exec(body.data.release)?.[0]?.toLowerCase() : undefined;
      if (!mbid) return c.json({ error: "No MusicBrainz release id in that" }, 400);
      if (s.state === "returned" && s.releaseMbid === mbid) return c.json(toSubmissionDto(s));
      if (s.state !== "seeded") return c.json({ error: `This submission is ${s.state}` }, 409);
      updateSubmission(db, s.id, { state: "verifying", error: null }, now());
      enqueueSubmissionVerify(queue, s.id, mbid);
      return c.json(toSubmissionDto(getSubmission(db, s.id)!), 202);
    })
    // Check again: after adding a missing artist on MusicBrainz, or when the server's data changed.
    .post("/submissions/:id{[0-9]+}/recheck", (c) => {
      const s = mine(Number(c.req.param("id")), c.get("session").userId);
      if (!s) return c.json({ error: "not found" }, 404);
      if (!["ready", "seeded", "failed"].includes(s.state)) {
        return c.json({ error: `This submission is ${s.state}` }, 409);
      }
      updateSubmission(db, s.id, { state: "checking", error: null }, now());
      enqueueSubmissionCheck(queue, s.id);
      return c.json(toSubmissionDto(getSubmission(db, s.id)!), 202);
    })
    // §12.3: an artist not found by its provider pages, matched to a MusicBrainz artist by the user.
    .post("/submissions/:id{[0-9]+}/artists", async (c) => {
      const s = mine(Number(c.req.param("id")), c.get("session").userId);
      if (!s) return c.json({ error: "not found" }, 404);
      if (!["ready", "seeded", "failed"].includes(s.state)) {
        return c.json({ error: `This submission is ${s.state}` }, 409);
      }
      const body = artistBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success || !s.artists.some((a) => a.name === body.data.name)) {
        return c.json({ error: "Not an artist of this release" }, 400);
      }
      const choices = { ...s.artistChoices };
      if (body.data.artist === null) delete choices[body.data.name];
      else {
        const mbid = MBID.exec(body.data.artist)?.[0]?.toLowerCase();
        if (!mbid) return c.json({ error: "No MusicBrainz artist id in that" }, 400);
        choices[body.data.name] = mbid;
      }
      updateSubmission(db, s.id, { artistChoices: choices, state: "checking", error: null }, now());
      enqueueSubmissionCheck(queue, s.id);
      return c.json(toSubmissionDto(getSubmission(db, s.id)!), 202);
    })
    .post("/submissions/:id{[0-9]+}/abandon", (c) => {
      const s = mine(Number(c.req.param("id")), c.get("session").userId);
      if (!s) return c.json({ error: "not found" }, 404);
      if (!OPEN.has(s.state) && s.state !== "failed") return c.json({ error: `This submission is ${s.state}` }, 409);
      updateSubmission(db, s.id, { state: "abandoned" }, now());
      return c.body(null, 204);
    });
}
