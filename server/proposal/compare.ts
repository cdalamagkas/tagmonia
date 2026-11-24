/**
 * Normalisation for comparing values (§10.2). Comparison only: a proposed value
 * keeps its original form. A field whose current value agrees is "unchanged"
 * and is not rewritten (§10.3 rule 2).
 *
 * Two strengths (D43): "exact" decides whether a field changes, so MusicBrainz's
 * case and punctuation are proposed as Picard writes them; only invisible
 * differences (Unicode form, spacing) agree. "loose" also ignores case, quotes
 * and dashes: for telling whether two providers agree with each other.
 */
import type { CanonicalField } from "../tagio/types.ts";

const DATE_FIELDS = new Set<CanonicalField>(["date", "originaldate"]);
/** Lists whose order carries meaning (names pair with IDs by position). */
const ORDERED = new Set<CanonicalField>([
  "artists",
  "albumartists",
  "musicbrainz_artistid",
  "musicbrainz_albumartistid",
  "composer",
  "composersort",
]);

export type Strength = "exact" | "loose";

/** Unicode form and spacing only: differences a reader cannot see. */
export function normalizeExact(s: string): string {
  return s.normalize("NFC").trim().replace(/\s+/g, " ");
}

/** Also case, typographic quotes and dashes. */
export function normalizeText(s: string): string {
  return normalizeExact(s)
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―]/g, "-")
    .toLowerCase();
}

const TEXT: Record<Strength, (s: string) => string> = { exact: normalizeExact, loose: normalizeText };

function normalizeBarcode(s: string): string {
  return s.replace(/\D/g, "").replace(/^0+/, "");
}

/** "2019" agrees with "2019-05-03": compare at the precision both sides have. */
function datesAgree(a: string, b: string): boolean {
  const x = a.trim(), y = b.trim();
  const n = Math.min(x.length, y.length);
  return n >= 4 && x.slice(0, n) === y.slice(0, n);
}

function scalar(field: CanonicalField, v: unknown, strength: Strength): string {
  if (field === "barcode") return normalizeBarcode(String(v));
  return typeof v === "string" ? TEXT[strength](v) : String(v);
}

function lists(field: CanonicalField, a: unknown[], b: unknown[], strength: Strength): boolean {
  if (a.length !== b.length) return false;
  const x = a.map((v) => scalar(field, v, strength));
  const y = b.map((v) => scalar(field, v, strength));
  if (!ORDERED.has(field)) {
    x.sort();
    y.sort();
  }
  return x.every((v, i) => v === y[i]);
}

export function valuesAgree(
  field: CanonicalField,
  current: unknown,
  proposed: unknown,
  strength: Strength = "exact",
): boolean {
  const text = TEXT[strength];
  if (current === undefined || current === null) return proposed === undefined || proposed === null;
  if (proposed === undefined || proposed === null) return false;
  if (DATE_FIELDS.has(field) && typeof current === "string" && typeof proposed === "string") {
    return datesAgree(current, proposed);
  }
  if (Array.isArray(current) && Array.isArray(proposed)) return lists(field, current, proposed, strength);
  if (Array.isArray(current) || Array.isArray(proposed)) {
    // One value stored where a list is expected (or the reverse) agrees when the content does.
    const a = Array.isArray(current) ? current : [current];
    const b = Array.isArray(proposed) ? proposed : [proposed];
    return lists(field, a, b, strength);
  }
  if (typeof current === "object" && typeof proposed === "object") {
    // performer: role → names
    const a = current as Record<string, string[]>, b = proposed as Record<string, string[]>;
    const ka = Object.keys(a).map(text).sort(), kb = Object.keys(b).map(text).sort();
    if (ka.join("\n") !== kb.join("\n")) return false;
    const byRole = (o: Record<string, string[]>) =>
      new Map(Object.entries(o).map(([k, v]) => [text(k), v.map(text).sort().join("\n")]));
    const ma = byRole(a), mb = byRole(b);
    return [...ma].every(([k, v]) => mb.get(k) === v);
  }
  return scalar(field, current, strength) === scalar(field, proposed, strength);
}
