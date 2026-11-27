/** Submissions of releases missing from MusicBrainz (§12, D52). */
import type { FollowUpStatus } from "../../submission/follow_ups.ts";
import type { Db } from "../db.ts";
import type { PossibleDuplicate } from "../../submission/duplicates.ts";
import type { ArtistResolution } from "../../submission/artists.ts";

export type SubmissionState =
  | "checking"
  | "ready"
  | "seeded"
  | "verifying"
  | "returned"
  | "failed"
  | "abandoned";

export interface Submission {
  id: number;
  candidateId: number;
  proposalId: number | null;
  userId: number;
  server: string;
  returnBase: string;
  state: SubmissionState;
  duplicates: PossibleDuplicate[];
  seed: Record<string, string> | null;
  /** ISRCs in track order ("" where a track has none), for submitting them after the release exists. */
  isrcs: string[];
  /** The credited artists on the server: found (MBID in the seed) or not (§12.3). */
  artists: ArtistResolution[];
  /** Artist name → MBID the user chose, used when the artist's pages find nothing. */
  artistChoices: Record<string, string>;
  releaseMbid: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  /** Once returned: whether MusicBrainz has the cover art and ISRCs yet (D65); null until first looked up. */
  followUpStatus: FollowUpStatus | null;
}

interface Row {
  id: number;
  candidate_id: number;
  proposal_id: number | null;
  user_id: number;
  server: string;
  return_base: string;
  state: SubmissionState;
  duplicates: string;
  seed: string | null;
  isrcs: string;
  artists: string;
  artist_choices: string;
  release_mbid: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  follow_ups: string | null;
}

function toSubmission(r: Row): Submission {
  return {
    id: r.id,
    candidateId: r.candidate_id,
    proposalId: r.proposal_id,
    userId: r.user_id,
    server: r.server,
    returnBase: r.return_base,
    state: r.state,
    duplicates: JSON.parse(r.duplicates),
    seed: r.seed ? JSON.parse(r.seed) : null,
    isrcs: JSON.parse(r.isrcs),
    artists: JSON.parse(r.artists),
    artistChoices: JSON.parse(r.artist_choices),
    releaseMbid: r.release_mbid,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    followUpStatus: r.follow_ups ? JSON.parse(r.follow_ups) : null,
  };
}

export function createSubmission(
  db: Db,
  s: { candidateId: number; proposalId: number; userId: number; server: string; returnBase: string },
  now: number,
): Submission {
  const row = db.prepare(
    `INSERT INTO submission (candidate_id, proposal_id, user_id, server, return_base, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'checking', ?, ?) RETURNING *`,
  ).get(s.candidateId, s.proposalId, s.userId, s.server, s.returnBase, now, now) as unknown as Row;
  return toSubmission(row);
}

export function getSubmission(db: Db, id: number): Submission | undefined {
  const r = db.prepare("SELECT * FROM submission WHERE id = ?").get(id) as unknown as Row | undefined;
  return r && toSubmission(r);
}

export function latestSubmission(db: Db, candidateId: number): Submission | undefined {
  const r = db.prepare("SELECT * FROM submission WHERE candidate_id = ? ORDER BY id DESC LIMIT 1").get(
    candidateId,
  ) as unknown as Row | undefined;
  return r && toSubmission(r);
}

export function updateSubmission(
  db: Db,
  id: number,
  patch: Partial<
    Pick<
      Submission,
      | "state"
      | "duplicates"
      | "seed"
      | "isrcs"
      | "artists"
      | "artistChoices"
      | "releaseMbid"
      | "error"
      | "followUpStatus"
    >
  >,
  now: number,
): void {
  const cols: string[] = [];
  const vals: (string | number | null)[] = [];
  const set = (col: string, v: string | number | null) => {
    cols.push(`${col} = ?`);
    vals.push(v);
  };
  if (patch.state !== undefined) set("state", patch.state);
  if (patch.duplicates !== undefined) set("duplicates", JSON.stringify(patch.duplicates));
  if (patch.seed !== undefined) set("seed", patch.seed === null ? null : JSON.stringify(patch.seed));
  if (patch.isrcs !== undefined) set("isrcs", JSON.stringify(patch.isrcs));
  if (patch.artists !== undefined) set("artists", JSON.stringify(patch.artists));
  if (patch.artistChoices !== undefined) set("artist_choices", JSON.stringify(patch.artistChoices));
  if (patch.releaseMbid !== undefined) set("release_mbid", patch.releaseMbid);
  if (patch.error !== undefined) set("error", patch.error);
  if (patch.followUpStatus !== undefined) {
    set("follow_ups", patch.followUpStatus === null ? null : JSON.stringify(patch.followUpStatus));
  }
  set("updated_at", now);
  db.prepare(`UPDATE submission SET ${cols.join(", ")} WHERE id = ?`).run(...vals, id);
}
