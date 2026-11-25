/** Evidence links per release (§9.5, D55): one YouTube video or playlist. */
import type { Db } from "../db.ts";

export interface EvidenceLink {
  provider: "youtube";
  url: string;
  addedAt: number;
}

export function getEvidenceLink(db: Db, candidateId: number): EvidenceLink | null {
  const r = db.prepare("SELECT provider, url, added_at FROM evidence_link WHERE candidate_id = ?").get(candidateId) as
    | { provider: "youtube"; url: string; added_at: number }
    | undefined;
  return r ? { provider: r.provider, url: r.url, addedAt: r.added_at } : null;
}

export function setEvidenceLink(db: Db, candidateId: number, link: { provider: "youtube"; url: string }, now: number) {
  db.prepare(
    `INSERT INTO evidence_link (candidate_id, provider, url, added_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (candidate_id) DO UPDATE SET provider = excluded.provider, url = excluded.url, added_at = excluded.added_at`,
  ).run(candidateId, link.provider, link.url, now);
}

export function removeEvidenceLink(db: Db, candidateId: number): boolean {
  return Number(db.prepare("DELETE FROM evidence_link WHERE candidate_id = ?").run(candidateId).changes) > 0;
}
