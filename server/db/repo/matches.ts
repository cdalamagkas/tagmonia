/** Data access for `match` and candidate identification state (ARCHITECTURE.md §6.1, §8). */
import type { Db } from "../db.ts";
import { transaction } from "../db.ts";
import type { IdentifiedRelease, IdentifyResult } from "../../identify/identify.ts";
import type { MatchMethod, ReleaseSummary, SignalName, TrackMapping } from "../../identify/types.ts";

export interface StoredMatch {
  rank: number;
  releaseMbid: string;
  releaseGroupMbid: string | null;
  score: number;
  method: MatchMethod;
  signals: Record<SignalName, number | null>;
  coverage: number;
  capped: boolean;
  identifierMatch: boolean;
  mapping: TrackMapping;
  summary: ReleaseSummary;
  snapshotId: number | null;
}

interface MatchRow {
  rank: number;
  release_mbid: string;
  release_group_mbid: string | null;
  score: number;
  method: MatchMethod;
  signals: string;
  track_mapping: string;
  summary: string;
  snapshot_id: number | null;
}

/** How many matches to keep per candidate: enough for the review list and the edition picker. */
export const MAX_STORED_MATCHES = 10;

export function markIdentifying(db: Db, candidateId: number): void {
  db.prepare("UPDATE candidate SET status = 'identifying', identify_error = NULL WHERE id = ?").run(candidateId);
}

/** Replaces the candidate's matches. A no-op when the candidate was deleted by a rescan meanwhile. */
export function saveIdentifyResult(
  db: Db,
  candidateId: number,
  contentHash: string,
  result: IdentifyResult,
  now: number,
): void {
  transaction(db, () => {
    const exists = db.prepare("SELECT 1 FROM candidate WHERE id = ?").get(candidateId);
    if (!exists) return;
    db.prepare("DELETE FROM match WHERE candidate_id = ?").run(candidateId);
    const insert = db.prepare(
      `INSERT INTO match (candidate_id, rank, release_mbid, release_group_mbid, score, method, signals, track_mapping,
                          summary, snapshot_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    result.ranked.slice(0, MAX_STORED_MATCHES).forEach((m: IdentifiedRelease, i) => {
      insert.run(
        candidateId,
        i,
        m.releaseId,
        m.releaseGroupId,
        m.score,
        m.method,
        JSON.stringify({ ...m.signals, coverage: m.coverage, capped: m.capped, identifierMatch: m.identifierMatch }),
        JSON.stringify(m.mapping),
        JSON.stringify(m.summary),
        m.snapshotId,
        now,
      );
    });
    db.prepare(
      `UPDATE candidate SET status = ?, identified_at = ?, identified_hash = ?, identify_error = NULL WHERE id = ?`,
    ).run(result.verdict, now, contentHash, candidateId);
  });
}

export function saveIdentifyError(db: Db, candidateId: number, error: string, now: number): void {
  db.prepare("UPDATE candidate SET status = 'error', identify_error = ?, identified_at = ? WHERE id = ?").run(
    error,
    now,
    candidateId,
  );
}

export function matchesFor(db: Db, candidateId: number): StoredMatch[] {
  const rows = db.prepare(
    `SELECT rank, release_mbid, release_group_mbid, score, method, signals, track_mapping, summary, snapshot_id
     FROM match WHERE candidate_id = ? ORDER BY rank`,
  ).all(candidateId) as unknown as MatchRow[];
  return rows.map((r) => {
    const s = JSON.parse(r.signals);
    const { coverage, capped, identifierMatch, ...signals } = s;
    return {
      rank: r.rank,
      releaseMbid: r.release_mbid,
      releaseGroupMbid: r.release_group_mbid,
      score: r.score,
      method: r.method,
      signals,
      coverage,
      capped,
      identifierMatch,
      mapping: JSON.parse(r.track_mapping),
      summary: JSON.parse(r.summary),
      snapshotId: r.snapshot_id,
    };
  });
}
