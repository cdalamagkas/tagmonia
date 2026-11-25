/**
 * Field-level proposal for one release (§10): every proposed field per mapped
 * file, compared with the file's current value, with its provenance and locks.
 * Pure; the propose job supplies MusicBrainz data and stores the result.
 */
import type { MappedPair } from "../identify/types.ts";
import type { CanonicalField, CanonicalTags } from "../tagio/types.ts";
import { refinesDate, valuesAgree } from "./compare.ts";
import { type FieldProvenance, type SourceId, sourcesAgree } from "./merge.ts";
import type { ProposedTags } from "./musicbrainz_tags.ts";

export type FieldStatus = "unchanged" | "changed" | "added";

export type LockScope = "file" | "release" | "global_field";

/** A standing "never change this" rule (§10.3 rule 1). */
export interface FieldLock {
  scope: LockScope;
  /** File id for "file", candidate id for "release", "" for "global_field". */
  target: string;
  field: CanonicalField;
}

export interface FieldSource {
  provider: string;
  value: unknown;
  snapshotId: number | null;
  agreesWithProposed: boolean;
}

export interface FieldProposalDraft {
  fileId: number;
  field: CanonicalField;
  current: unknown;
  proposed: unknown;
  status: FieldStatus;
  /** A lock keeps the current value whatever the sources say. */
  locked: boolean;
  sources: FieldSource[];
  /** Whose value is proposed; not MusicBrainz = "filled by" another provider (D48). */
  origin: SourceId;
  /** The sources disagree and the user must choose before writing (§10.3 rule 4). */
  conflict: boolean;
}

export interface BuildInput {
  candidateId: number;
  files: { id: number; tags: CanonicalTags }[];
  mapping: Pick<MappedPair, "fileId" | "trackId">[];
  proposed: ProposedTags;
  /** Snapshot the MusicBrainz values came from, for provenance (§9.4). */
  snapshotId: number | null;
  locks: FieldLock[];
  /** From mergeProviders: per release field, or `${trackId}:${field}` (D48). Absent = MusicBrainz alone. */
  provenance?: Map<string, FieldProvenance>;
}

export interface BuildResult {
  fields: FieldProposalDraft[];
  /** Files with no track on the release: left untouched (§8.3). */
  unmappedFiles: number[];
}

export function isLocked(locks: FieldLock[], candidateId: number, fileId: number, field: CanonicalField): boolean {
  return locks.some((l) =>
    l.field === field && (
      (l.scope === "global_field") ||
      (l.scope === "release" && l.target === String(candidateId)) ||
      (l.scope === "file" && l.target === String(fileId))
    )
  );
}

export function buildFieldProposals(input: BuildInput): BuildResult {
  const trackOf = new Map(input.mapping.map((p) => [p.fileId, p.trackId]));
  const fields: FieldProposalDraft[] = [];
  const unmappedFiles: number[] = [];
  for (const file of input.files) {
    const trackId = trackOf.get(file.id);
    const track = trackId ? input.proposed.tracks.get(trackId) : undefined;
    if (!track) {
      unmappedFiles.push(file.id);
      continue;
    }
    // A field MusicBrainz has no value for is not proposed: the file keeps what it has (D40).
    const proposed: CanonicalTags = { ...input.proposed.release, ...track };
    for (const [field, value] of Object.entries(proposed) as [CanonicalField, unknown][]) {
      const current = file.tags[field];
      const agrees = valuesAgree(field, current, value) && !refinesDate(field, current, value);
      const prov = input.provenance?.get(field in track ? `${trackId}:${field}` : field);
      const sources: FieldSource[] = prov
        ? prov.sources.map((s) => ({
          provider: s.provider,
          value: s.value,
          snapshotId: s.provider === "musicbrainz" ? input.snapshotId : null,
          agreesWithProposed: sourcesAgree(field, s.value, value),
        }))
        : [{ provider: "musicbrainz", value, snapshotId: input.snapshotId, agreesWithProposed: true }];
      fields.push({
        fileId: file.id,
        field,
        current: current ?? null,
        proposed: value,
        status: current === undefined ? "added" : agrees ? "unchanged" : "changed",
        locked: isLocked(input.locks, input.candidateId, file.id, field),
        sources,
        origin: prov?.origin ?? "musicbrainz",
        conflict: prov?.conflict ?? false,
      });
    }
  }
  return { fields, unmappedFiles };
}
