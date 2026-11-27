/**
 * Counting a proposal's changes (D53, D61), shared so the library list (server) and the Changes tab (web) say the
 * same number: an album-level field once, a track-level field per track, the cover as one, the move as one.
 */
import type { CanonicalTags, FieldDecision, FieldStatus } from "./types.ts";

/** Release-level canonical fields (ARCHITECTURE.md §6.2): written to every track, so they should agree. */
export const RELEASE_FIELDS: (keyof CanonicalTags)[] = [
  "album",
  "albumartist",
  "albumartists",
  "albumartistsort",
  "date",
  "originaldate",
  "label",
  "catalognumber",
  "barcode",
  "media",
  "releasecountry",
  "releasestatus",
  "releasetype",
  "script",
  "language",
  "genre",
  "musicbrainz_albumid",
  "musicbrainz_releasegroupid",
  "musicbrainz_albumartistid",
  "discogs_release_id",
  "deezer_album_id",
];

const RELEASE = new Set<string>(RELEASE_FIELDS);

/** What counting needs of a field proposal (the DTO, or the stored row). */
export interface CountedField {
  field: string;
  status: FieldStatus;
  decision: FieldDecision;
  locked: boolean;
  conflict: boolean;
}

/** What counting needs of a proposal. */
export interface CountedProposal {
  fields: CountedField[];
  cover: { writes: boolean } | null;
  rename: { include: boolean; conflicts: string[] } | null;
}

/** A row that the write will change. */
export function writes(r: CountedField): boolean {
  if (r.locked || r.decision === "kept_current") return false;
  return r.status !== "unchanged" || r.decision === "edited";
}

/**
 * Changes a write would make, counted as the Changes tab shows them: an album-level field once (it is
 * written to every file, but decided once), a track-level field per track, and the cover as one
 * (problem 4 of the proposal).
 */
export function changesToWrite(p: CountedProposal): number {
  const rows = p.fields.filter(writes);
  const albumFields = new Set(rows.filter((r) => RELEASE.has(r.field)).map((r) => r.field));
  return albumFields.size + rows.filter((r) => !RELEASE.has(r.field)).length + (p.cover?.writes ? 1 : 0) +
    (renames(p) ? 1 : 0);
}

/**
 * Disagreements still waiting for a choice, counted as the Changes tab lists them: an album field once
 * (it is decided once for every file), a track field per track.
 */
export function openChoices(p: CountedProposal): number {
  const open = p.fields.filter((r) => r.conflict && r.decision === "auto" && !r.locked);
  return new Set(open.filter((r) => RELEASE.has(r.field)).map((r) => r.field)).size +
    open.filter((r) => !RELEASE.has(r.field)).length;
}

/** The write renames the files (D57): renaming is on, included, and no new name is taken. The move counts as one change. */
export function renames(p: CountedProposal): boolean {
  return !!p.rename && p.rename.include && p.rename.conflicts.length === 0;
}
