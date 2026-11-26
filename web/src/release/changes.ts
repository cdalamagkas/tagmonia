/**
 * What the Changes tab shows (docs/proposals/release-page-restructure.md, D53, D56): a proposal's rows
 * as table rows, one checkbox each. Pure, so the grouping and the counts are unit-tested.
 *
 * - **Needs your choice:** fields whose sources disagree and that nobody has decided yet (D48).
 * - **Album:** one table, an album-level field once, though it is written to every file.
 * - **Tracks:** one table per track, in the files' order, its fields in reading order.
 *
 * Every row carries `right` (already as proposed): the tables show only the others unless "Show all
 * fields" is on.
 *
 * Counting is the header's (status.ts `changesToWrite`): an album field once, a track field per track.
 */
import type { FieldProposalDto, LockDto, ProposalDto } from "../../../shared/types.ts";
import { RELEASE_FIELDS } from "../format.ts";
import { renames, writes } from "./status.ts";

const RELEASE = new Set<string>(RELEASE_FIELDS);

export type ItemScope = "album" | "track";

export interface ChangeItem {
  key: string;
  field: FieldProposalDto["field"];
  scope: ItemScope;
  /** The track's file, for scope "track". */
  fileId: number | null;
  rows: FieldProposalDto[];
  ids: number[];
  /** Distinct current values across the rows (one when the files agree). */
  current: unknown[];
  /** What would be written: the user's edit, else the proposed value. */
  value: unknown;
  /** Included in the write (the checkbox). */
  included: boolean;
  /** Some rows included, some kept: the checkbox is indeterminate. */
  mixed: boolean;
  locked: boolean;
  edited: boolean;
  /** Sources disagree and no decision was made (it blocks the write). */
  unresolved: boolean;
  /** Whose value is proposed, when it is not the proposal's own source ("filled by …"). */
  filledBy: string | null;
  /** Changes it counts for: 1 for an album field, one per track otherwise. */
  weight: number;
  /** Nothing to change: the files already hold the proposed value. */
  right: boolean;
}

export interface TrackTable {
  fileId: number;
  rows: ChangeItem[];
}

export interface ChangesModel {
  needsChoice: ChangeItem[];
  /** Every album field, in the album field order; open disagreements are in needsChoice instead. */
  album: ChangeItem[];
  /** Every track, in the files' order, with every field in reading order. */
  tracks: TrackTable[];
  /** Changes the write would make now (checked), and all proposed changes. */
  selected: number;
  total: number;
  /** Fields already as proposed, counted the same way. */
  alreadyRight: number;
}

/** A row that proposes something: a change, an addition, the user's own value, or an open disagreement. */
export function proposes(r: FieldProposalDto): boolean {
  return r.status !== "unchanged" || r.decision === "edited" || (r.conflict && r.decision === "auto" && !r.locked);
}

function json(v: unknown): string {
  return JSON.stringify(v ?? null);
}

function item(
  key: string,
  scope: ItemScope,
  rows: FieldProposalDto[],
  primary: string,
  fileId: number | null = null,
): ChangeItem {
  const first = rows[0];
  const included = rows.filter((r) => !r.locked && r.decision !== "kept_current");
  const edited = rows.some((r) => r.decision === "edited");
  const currents = new Map(rows.map((r) => [json(r.current), r.current]));
  return {
    key,
    field: first.field,
    scope,
    fileId,
    rows,
    ids: rows.map((r) => r.id),
    current: [...currents.values()],
    value: edited ? rows.find((r) => r.decision === "edited")!.edited : first.proposed,
    included: included.length === rows.length,
    mixed: included.length > 0 && included.length < rows.length,
    locked: rows.every((r) => r.locked),
    edited,
    unresolved: rows.some((r) => r.conflict && r.decision === "auto" && !r.locked),
    filledBy: first.origin !== primary ? first.origin : null,
    weight: scope === "album" ? 1 : rows.length,
    right: !rows.some(proposes),
  };
}

/** The cover is proposed: a new embedded picture or folder image (whether or not it is kept). */
export function coverProposes(p: ProposalDto): boolean {
  const c = p.cover;
  if (!c || !c.source) return false;
  return (!!c.embed && c.embedStatus !== "unchanged") || (!!c.folder && c.folderStatus !== "unchanged");
}

export function buildChanges(p: ProposalDto, fileOrder: number[]): ChangesModel {
  const primary = p.primarySource ?? "musicbrainz";
  const trackFiles = [...new Set(p.fields.filter((r) => !RELEASE.has(r.field)).map((r) => r.fileId))];
  const order = new Map(fileOrder.map((id, i) => [id, i]));
  trackFiles.sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));

  const needsChoice: ChangeItem[] = [];
  const album: ChangeItem[] = [];

  // Album fields: one row each, decided once for every file.
  const albumRows = new Map<string, FieldProposalDto[]>();
  for (const r of p.fields) {
    if (RELEASE.has(r.field)) albumRows.set(r.field, [...(albumRows.get(r.field) ?? []), r]);
  }
  for (const [field, rows] of albumRows) {
    // Only the files that need it changed decide it; the others already have the value.
    const changing = rows.filter(proposes);
    const it = item(`album:${field}`, "album", changing.length ? changing : rows, primary);
    (it.unresolved ? needsChoice : album).push(it);
  }
  album.sort(byRank(RELEASE_FIELDS));

  // Track fields: a table per track.
  const perTrack = new Map<number, ChangeItem[]>(trackFiles.map((id) => [id, []]));
  for (const r of p.fields) {
    if (RELEASE.has(r.field)) continue;
    const it = item(`track:${r.fileId}:${r.field}`, "track", [r], primary, r.fileId);
    if (it.unresolved) needsChoice.push(it);
    else perTrack.get(r.fileId)!.push(it);
  }
  const tracks = trackFiles.map((fileId) => ({ fileId, rows: perTrack.get(fileId)!.sort(byRank(TRACK_ORDER)) }));

  const items = [...needsChoice, ...album, ...tracks.flatMap((t) => t.rows)];
  const total = items.filter((it) => !it.right).reduce((n, it) => n + it.weight, 0) + (coverProposes(p) ? 1 : 0) +
    (p.rename ? 1 : 0);

  // Selected: as the write counts it (status.ts changesToWrite), which is what the header says.
  const writing = p.fields.filter(writes);
  const selected = new Set(writing.filter((r) => RELEASE.has(r.field)).map((r) => r.field)).size +
    writing.filter((r) => !RELEASE.has(r.field)).length + (p.cover?.writes ? 1 : 0) + (renames(p) ? 1 : 0);
  const alreadyRight = items.filter((it) => it.right).length;

  return { needsChoice, album, tracks, selected, total, alreadyRight };
}

/** The locks that make an item "never change" (to show, and to remove from the ⋯ menu). */
export function locksOf(item: ChangeItem, locks: LockDto[], releaseId: number): LockDto[] {
  const files = new Set(item.rows.map((r) => String(r.fileId)));
  return locks.filter((l) =>
    l.field === item.field && (
      l.scope === "global_field" || (l.scope === "release" && l.target === String(releaseId)) ||
      (l.scope === "file" && files.has(l.target))
    )
  );
}

/** Track fields in reading order: what the track is, its numbering, its credits, then identifiers. */
const TRACK_ORDER = [
  "title",
  "artist",
  "artists",
  "artistsort",
  "tracknumber",
  "totaltracks",
  "discnumber",
  "totaldiscs",
  "media",
  "work",
  "movement",
  "movementnumber",
  "movementtotal",
  "showmovement",
  "composer",
  "composersort",
  "lyricist",
  "arranger",
  "conductor",
  "performer",
  "isrc",
];

/** Known fields first in their order; then the rest alphabetically, MusicBrainz identifiers last. */
export function fieldRank(field: string, order: readonly string[]): [number, number, string] {
  const i = order.indexOf(field);
  if (i >= 0) return [0, i, field];
  return [field.startsWith("musicbrainz_") ? 2 : 1, 0, field];
}

function byRank(order: readonly string[]) {
  return (a: { field: string }, b: { field: string }) => {
    const [x, y] = [fieldRank(a.field, order), fieldRank(b.field, order)];
    return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]);
  };
}
