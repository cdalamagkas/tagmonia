/** Data access for proposals, field proposals, sources and locks (ARCHITECTURE.md §6.1, §10). */
import type { Db } from "../db.ts";
import { transaction } from "../db.ts";
import type { BuildResult, FieldLock, FieldStatus, LockScope } from "../../proposal/build.ts";
import type { CanonicalField } from "../../tagio/types.ts";

export type ProposalState = "draft" | "needs_review" | "approved" | "written" | "discarded";
export type ChosenBy = "auto" | "user";
export type Decision = "auto" | "accepted" | "edited" | "kept_current";

export interface StoredFieldProposal {
  id: number;
  fileId: number;
  field: CanonicalField;
  current: unknown;
  proposed: unknown;
  /** The user's own value when decision is "edited". */
  edited: unknown;
  status: FieldStatus;
  decision: Decision;
  locked: boolean;
  sources: { provider: string; value: unknown; snapshotId: number | null; agreesWithProposed: boolean }[];
}

export interface StoredProposal {
  id: number;
  candidateId: number;
  releaseMbid: string | null;
  state: ProposalState;
  chosenBy: ChosenBy;
  basedOnHash: string;
  snapshotIds: number[];
  unmappedFiles: number[];
  createdAt: number;
  updatedAt: number;
  fields: StoredFieldProposal[];
}

export interface NewProposal {
  candidateId: number;
  releaseMbid: string;
  chosenBy: ChosenBy;
  basedOnHash: string;
  snapshotIds: number[];
  build: BuildResult;
}

/** Replaces the candidate's unwritten proposals; written ones stay for undo and history. Returns the new id. */
export function saveProposal(db: Db, p: NewProposal, now: number): number {
  return transaction(db, () => {
    db.prepare("DELETE FROM proposal WHERE candidate_id = ? AND state IN ('draft', 'needs_review', 'approved')").run(
      p.candidateId,
    );
    const { id } = db.prepare(
      `INSERT INTO proposal (candidate_id, release_mbid, state, chosen_by, based_on_hash, snapshot_ids, unmapped_files,
                             created_at, updated_at)
       VALUES (?, ?, 'needs_review', ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).get(
      p.candidateId,
      p.releaseMbid,
      p.chosenBy,
      p.basedOnHash,
      JSON.stringify(p.snapshotIds),
      JSON.stringify(p.build.unmappedFiles),
      now,
      now,
    ) as { id: number };
    const field = db.prepare(
      `INSERT INTO field_proposal (proposal_id, file_id, field, current_value, proposed_value, status, decision, locked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    );
    const source = db.prepare(
      `INSERT INTO field_source (field_proposal_id, provider, value, snapshot_id, agrees_with_proposed)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const f of p.build.fields) {
      const row = field.get(
        id,
        f.fileId,
        f.field,
        f.current === null || f.current === undefined ? null : JSON.stringify(f.current),
        JSON.stringify(f.proposed),
        f.status,
        // A locked field keeps the file's value (§10.3 rule 1).
        f.locked ? "kept_current" : "auto",
        f.locked ? 1 : 0,
      ) as { id: number };
      for (const s of f.sources) {
        source.run(row.id, s.provider, JSON.stringify(s.value), s.snapshotId, s.agreesWithProposed ? 1 : 0);
      }
    }
    return id;
  });
}

interface ProposalRow {
  id: number;
  candidate_id: number;
  release_mbid: string | null;
  state: ProposalState;
  chosen_by: ChosenBy;
  based_on_hash: string;
  snapshot_ids: string;
  unmapped_files: string;
  created_at: number;
  updated_at: number;
}

/** The candidate's newest proposal with its fields, or undefined. */
export function latestProposal(db: Db, candidateId: number): StoredProposal | undefined {
  const p = db.prepare("SELECT * FROM proposal WHERE candidate_id = ? ORDER BY id DESC LIMIT 1").get(candidateId) as
    | ProposalRow
    | undefined;
  return p && loadProposal(db, p);
}

export function getProposal(db: Db, id: number): StoredProposal | undefined {
  const p = db.prepare("SELECT * FROM proposal WHERE id = ?").get(id) as ProposalRow | undefined;
  return p && loadProposal(db, p);
}

export function setProposalState(db: Db, id: number, state: ProposalState, now: number): void {
  db.prepare("UPDATE proposal SET state = ?, updated_at = ? WHERE id = ?").run(state, now, id);
}

function loadProposal(db: Db, p: ProposalRow): StoredProposal {
  const fields = db.prepare(
    `SELECT id, file_id, field, current_value, proposed_value, edited_value, status, decision, locked
     FROM field_proposal WHERE proposal_id = ? ORDER BY file_id, id`,
  ).all(p.id) as unknown as {
    id: number;
    file_id: number;
    field: CanonicalField;
    current_value: string | null;
    proposed_value: string;
    edited_value: string | null;
    status: FieldStatus;
    decision: Decision;
    locked: number;
  }[];
  const sources = db.prepare(
    `SELECT s.field_proposal_id, s.provider, s.value, s.snapshot_id, s.agrees_with_proposed
     FROM field_source s JOIN field_proposal f ON f.id = s.field_proposal_id WHERE f.proposal_id = ?`,
  ).all(p.id) as unknown as {
    field_proposal_id: number;
    provider: string;
    value: string;
    snapshot_id: number | null;
    agrees_with_proposed: number;
  }[];
  const byField = new Map<number, StoredFieldProposal["sources"]>();
  for (const s of sources) {
    const list = byField.get(s.field_proposal_id) ?? [];
    list.push({
      provider: s.provider,
      value: JSON.parse(s.value),
      snapshotId: s.snapshot_id,
      agreesWithProposed: s.agrees_with_proposed === 1,
    });
    byField.set(s.field_proposal_id, list);
  }
  return {
    id: p.id,
    candidateId: p.candidate_id,
    releaseMbid: p.release_mbid,
    state: p.state,
    chosenBy: p.chosen_by,
    basedOnHash: p.based_on_hash,
    snapshotIds: JSON.parse(p.snapshot_ids),
    unmappedFiles: JSON.parse(p.unmapped_files),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    fields: fields.map((f) => ({
      id: f.id,
      fileId: f.file_id,
      field: f.field,
      current: f.current_value === null ? null : JSON.parse(f.current_value),
      proposed: JSON.parse(f.proposed_value),
      edited: f.edited_value === null ? null : JSON.parse(f.edited_value),
      status: f.status,
      decision: f.decision,
      locked: f.locked === 1,
      sources: byField.get(f.id) ?? [],
    })),
  };
}

export function listLocks(db: Db): FieldLock[] {
  return (db.prepare("SELECT scope, target, field FROM field_lock").all() as unknown as {
    scope: LockScope;
    target: string;
    field: CanonicalField;
  }[]).map((r) => ({ scope: r.scope, target: r.target, field: r.field }));
}
