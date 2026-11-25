/** The proposed cover of a proposal (D49). */
import type { Db } from "../db.ts";
import { transaction } from "../db.ts";
import type { CachedImage } from "../../covers/fetch.ts";
import type { CoverMode, CoverSource } from "../../covers/sources.ts";
import type { CoverStatus } from "../../covers/status.ts";
import { ReviewError } from "./proposals.ts";

export type CoverDecision = "auto" | "accepted" | "kept_current";

export interface CoverProposal {
  mode: CoverMode;
  source: CoverSource | null;
  skipped: { source: CoverSource; reason: string }[];
  embed: CachedImage | null;
  folder: CachedImage | null;
  embedStatus: CoverStatus | null;
  folderStatus: CoverStatus | null;
  folderPath: string | null;
  /** SHA-256 of the folder file when the proposal was built; null = there was none. */
  folderCurrent: string | null;
  decision: CoverDecision;
}

export function saveCover(db: Db, proposalId: number, c: Omit<CoverProposal, "decision">): void {
  db.prepare(
    `INSERT OR REPLACE INTO cover_proposal (proposal_id, mode, source, skipped, embed, folder, embed_status,
       folder_status, folder_path, folder_current, decision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto')`,
  ).run(
    proposalId,
    c.mode,
    c.source,
    JSON.stringify(c.skipped),
    c.embed ? JSON.stringify(c.embed) : null,
    c.folder ? JSON.stringify(c.folder) : null,
    c.embedStatus,
    c.folderStatus,
    c.folderPath,
    c.folderCurrent,
  );
}

export function getCover(db: Db, proposalId: number): CoverProposal | null {
  const r = db.prepare("SELECT * FROM cover_proposal WHERE proposal_id = ?").get(proposalId) as
    | Record<string, string | null>
    | undefined;
  if (!r) return null;
  const json = <T>(v: string | null): T | null => (v === null ? null : JSON.parse(v));
  return {
    mode: r.mode as CoverMode,
    source: r.source as CoverSource | null,
    skipped: json(r.skipped) ?? [],
    embed: json(r.embed),
    folder: json(r.folder),
    embedStatus: r.embed_status as CoverStatus | null,
    folderStatus: r.folder_status as CoverStatus | null,
    folderPath: r.folder_path,
    folderCurrent: r.folder_current,
    decision: r.decision as CoverDecision,
  };
}

/** What a write of this cover would do: embed it, save the folder file, both, or nothing. */
export function coverWrites(c: CoverProposal | null): { embed: boolean; folder: boolean } {
  if (!c || c.decision === "kept_current") return { embed: false, folder: false };
  return {
    embed: !!c.embed && c.embedStatus !== "unchanged",
    folder: !!c.folder && !!c.folderPath && c.folderStatus !== "unchanged",
  };
}

export function setCoverDecision(db: Db, proposalId: number, decision: CoverDecision, now: number): void {
  transaction(db, () => {
    const p = db.prepare("SELECT state FROM proposal WHERE id = ?").get(proposalId) as { state: string } | undefined;
    if (!p) throw new ReviewError("proposal not found");
    if (!["draft", "needs_review", "approved"].includes(p.state)) throw new ReviewError(`proposal is ${p.state}`);
    const res = db.prepare("UPDATE cover_proposal SET decision = ? WHERE proposal_id = ?").run(decision, proposalId);
    if (res.changes === 0) throw new ReviewError("this proposal has no cover");
    db.prepare("UPDATE proposal SET state = 'needs_review', updated_at = ? WHERE id = ? AND state = 'approved'").run(
      now,
      proposalId,
    );
  });
}
