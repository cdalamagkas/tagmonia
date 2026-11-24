/**
 * From a reviewed proposal to per-file tag changes, and back (§11.3). Pure, so
 * the rules for what gets written and how undo restores it are unit-testable.
 */
import { valuesEqual } from "../tagio/verify.ts";
import type { CanonicalField, CanonicalTags, TagChange } from "../tagio/types.ts";

export interface ReviewedField {
  fileId: number;
  field: CanonicalField;
  /** What the file held when the proposal was built; null = absent. */
  current: unknown;
  proposed: unknown;
  /** The user's own value ("edit" decision), written instead of the proposed one. */
  edited: unknown;
  status: "unchanged" | "changed" | "added";
  decision: "auto" | "accepted" | "edited" | "kept_current";
  locked: boolean;
}

export interface FilePlan {
  change: TagChange;
  /** Values the file must still hold for the fields being changed; otherwise it changed since review. */
  expected: Partial<Record<CanonicalField, unknown>>;
}

/** What gets written: not locked, not kept, and actually different (or edited by the user). */
export function plansFromProposal(fields: ReviewedField[]): Map<number, FilePlan> {
  const plans = new Map<number, FilePlan>();
  for (const f of fields) {
    if (f.locked || f.decision === "kept_current") continue;
    const edited = f.decision === "edited" && f.edited !== null && f.edited !== undefined;
    if (f.status === "unchanged" && !edited) continue;
    const value = edited ? f.edited : f.proposed;
    if (valuesEqual(value, f.current)) continue;
    const plan = plans.get(f.fileId) ?? { change: { set: {}, remove: [] }, expected: {} };
    (plan.change.set as Record<string, unknown>)[f.field] = value;
    plan.expected[f.field] = f.current;
    plans.set(f.fileId, plan);
  }
  return plans;
}

/** Fields whose value on disk is no longer what the review saw (§11.3 step 1). */
export function staleFields(onDisk: CanonicalTags, expected: FilePlan["expected"]): CanonicalField[] {
  return (Object.entries(expected) as [CanonicalField, unknown][])
    .filter(([field, value]) => !valuesEqual(onDisk[field] ?? null, value ?? null))
    .map(([field]) => field);
}

/**
 * The change that restores `before` for every field `change` touched: values
 * are put back, fields that did not exist before are removed (undo, §11.3).
 */
export function inverseChange(before: CanonicalTags, change: TagChange): TagChange {
  const set: Record<string, unknown> = {};
  const remove: CanonicalField[] = [];
  const touched = [...Object.keys(change.set), ...change.remove] as CanonicalField[];
  for (const field of new Set(touched)) {
    if (before[field] === undefined) remove.push(field);
    else set[field] = before[field];
  }
  return { set: set as Partial<CanonicalTags>, remove };
}

/** Fields an undo would overwrite whose value is no longer what Tagmonia wrote: something else changed them. */
export function changedSinceWrite(onDisk: CanonicalTags, after: CanonicalTags, change: TagChange): CanonicalField[] {
  const touched = [...Object.keys(change.set), ...change.remove] as CanonicalField[];
  return [...new Set(touched)].filter((f) => !valuesEqual(onDisk[f] ?? null, after[f] ?? null));
}
