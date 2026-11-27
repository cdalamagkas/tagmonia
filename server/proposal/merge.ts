/**
 * Merging the other providers into MusicBrainz's proposed tags (§10.1-10.3,
 * D48). Pure. Only providers whose release matched ("found", the same track
 * count) contribute; another edition never does. Identity fields stay
 * MusicBrainz's alone.
 *
 * - date: MusicBrainz → Deezer → iTunes → Discogs. A year-only date is refined
 *   by a later provider's full date for that year ("filled by"); another year
 *   is a conflict only from Discogs (stores show a reissue's original date).
 * - label, catalognumber, barcode: MusicBrainz → Discogs. Filled when
 *   MusicBrainz has none; a different value is a conflict.
 * - isrc, per track: MusicBrainz → Deezer → iTunes, filled only (a recording
 *   legitimately has several ISRCs).
 * - discogs_release_id, deezer_album_id: each provider's own ID.
 */
import { normalizeCatno } from "../identify/release.ts";
import type { HarmonizedRelease } from "../providers/harmony_adapter.ts";
import type { EnrichmentProvider, ProviderMatch, SourceProvider } from "../providers/enrichment.ts";
import type { MbRelease } from "../providers/musicbrainz/schema.ts";
import type { CanonicalField, CanonicalTags } from "../tagio/types.ts";
import { valuesAgree } from "./compare.ts";
import type { ProposedTags } from "./musicbrainz_tags.ts";

/** "user": typed by the user as search terms (D63). */
export type SourceId = "musicbrainz" | SourceProvider | "youtube" | "user";

export interface FieldProvenance {
  /** Whose value is proposed. */
  origin: SourceId;
  /** Every source that has a value for the field. */
  sources: { provider: SourceId; value: unknown }[];
  /** Sources the field's precedence lists disagree, and none is authoritative (§10.3 rule 4). */
  conflict: boolean;
}

export interface MergedTags extends ProposedTags {
  /** Keyed by field for release-level fields, `${trackId}:${field}` for track-level ones. */
  provenance: Map<string, FieldProvenance>;
}

interface ProviderValues {
  date?: string;
  label?: string[];
  catalognumber?: string[];
  barcode?: string;
  id?: string;
  isrc: (string | undefined)[];
}

/** The release date as "YYYY", "YYYY-MM" or "YYYY-MM-DD"; undefined when absent or flagged invalid. */
export function harmonyDate(r: HarmonizedRelease): string | undefined {
  // Harmony flags dates it believes wrong (e.g. a store's placeholder); those never fill a field.
  const d = r.releaseDate?.quality === "assumed-invalid" ? undefined : r.releaseDate?.date;
  const pad = (n: number) => String(n).padStart(2, "0");
  return d?.year
    ? [String(d.year), d.month ? pad(d.month) : null, d.month && d.day ? pad(d.day) : null].filter(Boolean).join("-")
    : undefined;
}

/** Label names and catalog numbers, deduplicated; "none" placeholders dropped. */
export function harmonyLabels(r: HarmonizedRelease): { label?: string[]; catalognumber?: string[] } {
  const labels = (r.labels ?? []).map((l) => l.name?.trim()).filter((x): x is string => !!x);
  const catnos = (r.labels ?? []).map((l) => l.catalogNumber?.trim())
    .filter((x): x is string => !!x && x.toLowerCase() !== "none" && x.toLowerCase() !== "[none]");
  return {
    label: labels.length ? [...new Set(labels)] : undefined,
    catalognumber: catnos.length ? [...new Set(catnos)] : undefined,
  };
}

function harmonyValues(r: HarmonizedRelease): ProviderValues {
  return {
    date: harmonyDate(r),
    ...harmonyLabels(r),
    barcode: r.gtin ? String(r.gtin) : undefined,
    id: r.info?.providers?.[0]?.id,
    isrc: r.media.flatMap((m) => m.tracklist.map((t) => t.isrc || undefined)),
  };
}

/** Catalog numbers compare like identifiers ("CAT-001" = "cat 001"), as sets. */
function catnosAgree(a: string[], b: string[]): boolean {
  const n = (xs: string[]) => [...new Set(xs.map(normalizeCatno).filter(Boolean))].sort().join("|");
  return n(a) === n(b);
}

/** Whether two providers' values for a field say the same thing (loosely: case and punctuation aside). */
export function sourcesAgree(field: CanonicalField, a: unknown, b: unknown): boolean {
  if (field === "catalognumber") return catnosAgree(a as string[], b as string[]);
  return valuesAgree(field, a, b, "loose");
}

/**
 * One field by precedence: the first source with a value is proposed; any later
 * source in the list that disagrees is a conflict, unless `conflicts` is off.
 */
function byPrecedence(
  field: CanonicalField,
  order: { provider: SourceId; value: unknown }[],
  conflicts: boolean,
): { value: unknown; provenance: FieldProvenance } | null {
  const present = order.filter((s) => s.value !== undefined && s.value !== null);
  if (present.length === 0) return null;
  const [first, ...rest] = present;
  return {
    value: first.value,
    provenance: {
      origin: first.provider,
      sources: present,
      conflict: conflicts && rest.some((s) => !sourcesAgree(field, s.value, first.value)),
    },
  };
}

/** Only these disagreeing on a date is a conflict (D48). */
const DATE_CONFLICTS = new Set<SourceId>(["musicbrainz", "discogs"]);

/** Dates: a later provider's full date refines a year-only one when they agree on what both have. */
function mergeDate(order: { provider: SourceId; value: string | undefined }[]) {
  const present = order.filter((s): s is { provider: SourceId; value: string } => !!s.value);
  if (present.length === 0) return null;
  let best = present[0];
  for (const s of present.slice(1)) {
    if (s.value.length > best.value.length && valuesAgree("date", s.value, best.value)) best = s;
  }
  return {
    value: best.value,
    provenance: {
      origin: best.provider,
      sources: present,
      // Streaming stores often carry the original release's date on a reissue: they refine, never conflict.
      conflict: present.some((s) => DATE_CONFLICTS.has(s.provider) && !valuesAgree("date", s.value, best.value)),
    } satisfies FieldProvenance,
  };
}

export function mergeProviders(mb: ProposedTags, mbRelease: MbRelease, matches: ProviderMatch[]): MergedTags {
  const release: CanonicalTags = { ...mb.release };
  const tracks = new Map([...mb.tracks].map(([id, t]) => [id, { ...t }]));
  const provenance = new Map<string, FieldProvenance>();
  const found = new Map<EnrichmentProvider, ProviderValues>();
  for (const m of matches) {
    if (m.status !== "found" || !m.release || m.provider === "bandcamp" || m.provider === "youtube") continue;
    found.set(m.provider, harmonyValues(m.release));
  }
  const v = (p: EnrichmentProvider) => found.get(p);

  const set = (key: string, target: CanonicalTags, field: CanonicalField, r: ReturnType<typeof byPrecedence>) => {
    if (!r) return;
    (target as Record<string, unknown>)[field] = r.value;
    provenance.set(key, r.provenance);
  };

  // Release date.
  set(
    "date",
    release,
    "date",
    mergeDate([
      { provider: "musicbrainz", value: mb.release.date },
      { provider: "deezer", value: v("deezer")?.date },
      { provider: "itunes", value: v("itunes")?.date },
      { provider: "discogs", value: v("discogs")?.date },
    ]),
  );
  // Label, catalog number, barcode: MusicBrainz, then Discogs (§10.3).
  for (const field of ["label", "catalognumber", "barcode"] as const) {
    set(
      field,
      release,
      field,
      byPrecedence(field, [
        { provider: "musicbrainz", value: mb.release[field] },
        { provider: "discogs", value: v("discogs")?.[field] },
      ], true),
    );
  }
  // Each provider's own ID.
  for (const [field, provider] of [["discogs_release_id", "discogs"], ["deezer_album_id", "deezer"]] as const) {
    const id = v(provider)?.id;
    if (id) set(field, release, field, byPrecedence(field, [{ provider, value: id }], false));
  }

  // ISRCs per track: providers' tracklists align with MusicBrainz's when the track counts match ("found").
  const order = mbRelease.media
    .slice()
    .sort((a, b) => a.position - b.position)
    .flatMap((m) => (m.tracks ?? []).slice().sort((a, b) => a.position - b.position).map((t) => t.id));
  order.forEach((trackId, i) => {
    const t = tracks.get(trackId);
    if (!t) return;
    set(
      `${trackId}:isrc`,
      t,
      "isrc",
      byPrecedence("isrc", [
        { provider: "musicbrainz", value: t.isrc },
        { provider: "deezer", value: v("deezer")?.isrc[i] ? [v("deezer")!.isrc[i]] : undefined },
        { provider: "itunes", value: v("itunes")?.isrc[i] ? [v("itunes")!.isrc[i]] : undefined },
      ], false),
    );
  });

  return { release, tracks, provenance };
}
