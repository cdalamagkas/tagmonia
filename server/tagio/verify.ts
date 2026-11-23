/**
 * Round-trip verification (§11.3 step 4): after a write, re-read the file and
 * confirm every requested change landed exactly. Pure, so it is unit-testable.
 */
import { MAPPING_BY_FIELD } from "./mapping.ts";
import type { AudioFormat, CanonicalField, CanonicalTags, TagChange } from "./types.ts";

/** Fields the format can store. MP4 has no performer storage (Picard parity, D9). */
export function supportsField(format: AudioFormat, field: CanonicalField): boolean {
  const m = MAPPING_BY_FIELD.get(field);
  if (!m) return false;
  return format === "m4a" ? m.mp4 !== null : true;
}

/** Drops fields the format cannot store, so expectations match what is achievable. */
export function storableTags(format: AudioFormat, tags: Partial<CanonicalTags>): Partial<CanonicalTags> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(tags)) {
    if (supportsField(format, k as CanonicalField)) out[k] = v;
  }
  return out as Partial<CanonicalTags>;
}

function canonicalJson(v: unknown): string {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export interface VerifyMismatch {
  field: CanonicalField;
  expected: unknown;
  actual: unknown;
}

/** Exact comparison (no normalisation): a write must store what was asked, byte for byte. */
export function verifyChange(format: AudioFormat, change: TagChange, after: CanonicalTags): VerifyMismatch[] {
  const out: VerifyMismatch[] = [];
  for (const [field, expected] of Object.entries(change.set) as [CanonicalField, unknown][]) {
    if (!supportsField(format, field)) continue;
    const actual = after[field];
    if (!valuesEqual(expected, actual)) out.push({ field, expected, actual });
  }
  for (const field of change.remove) {
    if (after[field] !== undefined) out.push({ field, expected: undefined, actual: after[field] });
  }
  return out;
}
