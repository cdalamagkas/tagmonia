/** Data access for proposals, field proposals, sources and locks (ARCHITECTURE.md §6.1, §10). */
import type { Db } from "../db.ts";
import { transaction } from "../db.ts";
import type { BuildResult, FieldLock, FieldStatus, LockScope } from "../../proposal/build.ts";
import type { CanonicalField } from "../../tagio/types.ts";
import type { ProviderMatch } from "../../providers/enrichment.ts";

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
  /** Whose value is proposed (D48). */
  origin: string;
  /** Sources disagree; unresolved while the decision is still "auto" and the row is unlocked. */
  conflict: boolean;
  /** The source the user picked, if they settled it that way. */
  resolvedFrom: string | null;
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
      `INSERT INTO field_proposal (proposal_id, file_id, field, current_value, proposed_value, status, decision, locked,
                                   origin, conflict)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
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
        f.origin,
        f.conflict ? 1 : 0,
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
    `SELECT id, file_id, field, current_value, proposed_value, edited_value, status, decision, locked, origin,
            conflict, resolved_from
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
    origin: string;
    conflict: number;
    resolved_from: string | null;
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
      origin: f.origin,
      conflict: f.conflict === 1,
      resolvedFrom: f.resolved_from,
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

// ---- review: decisions and locks (§10.3)

/** Proposals the review can still change. */
const OPEN = "('draft', 'needs_review', 'approved')";

export class ReviewError extends Error {
  override name = "ReviewError";
}

/** A conflict nobody has decided yet: writing waits for it (§10.3 rule 4, D48). */
export function isUnresolved(f: Pick<StoredFieldProposal, "conflict" | "decision" | "locked">): boolean {
  return f.conflict && f.decision === "auto" && !f.locked;
}

/**
 * Applies one decision to field rows of one open proposal. Locked rows refuse: unlock first.
 * With `source`, each row takes that source's value: "accepted" when it is the proposed value's
 * origin, "edited" with the source's value otherwise.
 */
export function setDecisions(
  db: Db,
  proposalId: number,
  fieldIds: number[],
  decision: Decision,
  edited: unknown,
  now: number,
  source?: string,
): void {
  transaction(db, () => {
    const p = db.prepare(`SELECT state FROM proposal WHERE id = ?`).get(proposalId) as { state: string } | undefined;
    if (!p) throw new ReviewError("proposal not found");
    if (!["draft", "needs_review", "approved"].includes(p.state)) throw new ReviewError(`proposal is ${p.state}`);
    const rows = db.prepare(
      `SELECT id, locked, origin FROM field_proposal WHERE proposal_id = ? AND id IN (${
        fieldIds.map(() => "?").join(",")
      })`,
    ).all(proposalId, ...fieldIds) as { id: number; locked: number; origin: string }[];
    if (rows.length !== new Set(fieldIds).size) throw new ReviewError("unknown field for this proposal");
    if (rows.some((r) => r.locked)) throw new ReviewError("a locked field keeps its value; unlock it first");
    const update = db.prepare(
      "UPDATE field_proposal SET decision = ?, edited_value = ?, resolved_from = ? WHERE id = ?",
    );
    const sourceValue = db.prepare("SELECT value FROM field_source WHERE field_proposal_id = ? AND provider = ?");
    for (const r of rows) {
      if (source === undefined) {
        update.run(decision, decision === "edited" ? JSON.stringify(edited) : null, null, r.id);
        continue;
      }
      const s = sourceValue.get(r.id, source) as { value: string } | undefined;
      if (!s) throw new ReviewError(`no ${source} value for this field`);
      if (r.origin === source) update.run("accepted", null, source, r.id);
      else update.run("edited", s.value, source, r.id);
    }
    // Any change after approval needs a fresh look before writing.
    db.prepare("UPDATE proposal SET state = 'needs_review', updated_at = ? WHERE id = ? AND state = 'approved'").run(
      now,
      proposalId,
    );
  });
}

export interface StoredLock extends FieldLock {
  id: number;
}

export function locksFor(db: Db, candidateId: number): StoredLock[] {
  const fileIds = (db.prepare("SELECT id FROM library_file WHERE candidate_id = ?").all(candidateId) as {
    id: number;
  }[]).map((r) => String(r.id));
  return (db.prepare("SELECT id, scope, target, field FROM field_lock ORDER BY id").all() as unknown as StoredLock[])
    .filter((l) =>
      l.scope === "global_field" || (l.scope === "release" && l.target === String(candidateId)) ||
      (l.scope === "file" && fileIds.includes(l.target))
    );
}

/** Re-derives `locked` for open proposals' rows of one field from the locks that exist now. */
function reapplyLocks(db: Db, field: CanonicalField): void {
  const locks = listLocks(db);
  const rows = db.prepare(
    `SELECT f.id, f.file_id, f.locked, p.candidate_id FROM field_proposal f JOIN proposal p ON p.id = f.proposal_id
     WHERE f.field = ? AND p.state IN ${OPEN}`,
  ).all(field) as { id: number; file_id: number; locked: number; candidate_id: number }[];
  const lock = db.prepare(
    "UPDATE field_proposal SET locked = 1, decision = 'kept_current', edited_value = NULL, resolved_from = NULL WHERE id = ?",
  );
  const unlock = db.prepare("UPDATE field_proposal SET locked = 0, decision = 'auto' WHERE id = ?");
  for (const r of rows) {
    const now = locks.some((l) =>
      l.field === field && (l.scope === "global_field" ||
        (l.scope === "release" && l.target === String(r.candidate_id)) ||
        (l.scope === "file" && l.target === String(r.file_id)))
    );
    if (now && !r.locked) lock.run(r.id);
    if (!now && r.locked) unlock.run(r.id);
  }
}

export function addLock(db: Db, l: FieldLock, now: number): StoredLock {
  return transaction(db, () => {
    db.prepare("INSERT OR IGNORE INTO field_lock (scope, target, field, created_at) VALUES (?, ?, ?, ?)").run(
      l.scope,
      l.target,
      l.field,
      now,
    );
    reapplyLocks(db, l.field);
    return db.prepare("SELECT id, scope, target, field FROM field_lock WHERE scope = ? AND target = ? AND field = ?")
      .get(l.scope, l.target, l.field) as unknown as StoredLock;
  });
}

export function removeLock(db: Db, id: number): boolean {
  return transaction(db, () => {
    const l = db.prepare("SELECT field FROM field_lock WHERE id = ?").get(id) as { field: CanonicalField } | undefined;
    if (!l) return false;
    db.prepare("DELETE FROM field_lock WHERE id = ?").run(id);
    reapplyLocks(db, l.field);
    return true;
  });
}

export function discardProposal(db: Db, id: number, now: number): void {
  const p = db.prepare("SELECT state FROM proposal WHERE id = ?").get(id) as { state: string } | undefined;
  if (!p) throw new ReviewError("proposal not found");
  if (p.state === "written") throw new ReviewError("a written proposal is undone, not discarded");
  setProposalState(db, id, "discarded", now);
}

// ---- the release on other providers (D47)

export function saveProviderMatches(db: Db, proposalId: number, matches: ProviderMatch[], now: number): void {
  transaction(db, () => {
    db.prepare("DELETE FROM provider_release WHERE proposal_id = ?").run(proposalId);
    const ins = db.prepare(
      `INSERT INTO provider_release (proposal_id, provider, status, via, url, reason, data, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const m of matches) {
      ins.run(
        proposalId,
        m.provider,
        m.status,
        m.via,
        m.url,
        m.reason,
        m.release ? JSON.stringify(m.release) : null,
        now,
      );
    }
  });
}

export function providerMatches(db: Db, proposalId: number): ProviderMatch[] {
  const rows = db.prepare(
    "SELECT provider, status, via, url, reason, data FROM provider_release WHERE proposal_id = ? ORDER BY rowid",
  ).all(proposalId) as unknown as {
    provider: ProviderMatch["provider"];
    status: ProviderMatch["status"];
    via: ProviderMatch["via"];
    url: string | null;
    reason: string | null;
    data: string | null;
  }[];
  return rows.map((r) => ({ ...r, release: r.data ? JSON.parse(r.data) : null }));
}
