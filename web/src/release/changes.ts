/**
 * What the Changes tab shows (docs/proposals/release-page-restructure.md, PR 2): a proposal's rows
 * grouped into items, one checkbox each. Pure, so the grouping and the counts are unit-tested.
 *
 * - **Needs your choice:** fields whose sources disagree and that nobody has decided yet (D48).
 * - **Album:** an album-level field once, though it is written to every file.
 * - **On all tracks:** a track-level change that is the same on every track ("total tracks 5").
 * - **Track grid:** the other track-level changes, a row per track and a column per field.
 *
 * Counting is the header's (status.ts `changesToWrite`): an album field once, a track field per track.
 */
import type { FieldProposalDto, LockDto, ProposalDto } from "../../../shared/types.ts";
import { RELEASE_FIELDS } from "../format.ts";
import { writes } from "./status.ts";

const RELEASE = new Set<string>(RELEASE_FIELDS);

export type ItemScope = "album" | "all-tracks" | "track";

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
}

export interface TrackRow {
  fileId: number;
  cells: Partial<Record<FieldProposalDto["field"], ChangeItem>>;
}

export interface ChangesModel {
  needsChoice: ChangeItem[];
  album: ChangeItem[];
  allTracks: ChangeItem[];
  /** Fields with a column in the track grid, in the order they first appear. */
  gridFields: FieldProposalDto["field"][];
  grid: TrackRow[];
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
  };
}

/** The cover is proposed: a new embedded picture or folder image (whether or not it is kept). */
export function coverProposes(p: ProposalDto): boolean {
  const c = p.cover;
  if (!c || !c.source) return false;
  return (!!c.embed && c.embedStatus !== "unchanged") || (!!c.folder && c.folderStatus !== "unchanged");
}

/** The same change on every track: same proposed value, same current value, same decision. */
function sameOnEveryTrack(rows: FieldProposalDto[], trackCount: number): boolean {
  if (rows.length !== trackCount || trackCount < 2) return false;
  const one = (f: (r: FieldProposalDto) => unknown) => new Set(rows.map((r) => json(f(r)))).size === 1;
  return one((r) => r.proposed) && one((r) => r.current) && one((r) => r.decision) && one((r) => r.edited) &&
    one((r) => r.locked);
}

export function buildChanges(p: ProposalDto, fileOrder: number[]): ChangesModel {
  const primary = p.primarySource ?? "musicbrainz";
  const trackFiles = [...new Set(p.fields.filter((r) => !RELEASE.has(r.field)).map((r) => r.fileId))];
  const order = new Map(fileOrder.map((id, i) => [id, i]));
  trackFiles.sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));

  const needsChoice: ChangeItem[] = [];
  const album: ChangeItem[] = [];
  const allTracks: ChangeItem[] = [];
  const gridFields: FieldProposalDto["field"][] = [];
  const cells = new Map<number, TrackRow["cells"]>(trackFiles.map((id) => [id, {}]));

  // Album fields: one item each.
  const albumRows = new Map<string, FieldProposalDto[]>();
  for (const r of p.fields) {
    if (RELEASE.has(r.field) && proposes(r)) albumRows.set(r.field, [...(albumRows.get(r.field) ?? []), r]);
  }
  for (const [field, rows] of albumRows) {
    const it = item(`album:${field}`, "album", rows, primary);
    (it.unresolved ? needsChoice : album).push(it);
  }

  // Track fields: the same change everywhere collapses; the rest goes to the grid, by track.
  const trackRows = new Map<string, FieldProposalDto[]>();
  for (const r of p.fields) {
    if (!RELEASE.has(r.field) && proposes(r)) trackRows.set(r.field, [...(trackRows.get(r.field) ?? []), r]);
  }
  for (const [field, rows] of trackRows) {
    if (sameOnEveryTrack(rows, trackFiles.length) && !rows.some((r) => r.conflict && r.decision === "auto")) {
      allTracks.push(item(`all:${field}`, "all-tracks", rows, primary));
      continue;
    }
    for (const r of rows) {
      const it = item(`track:${r.fileId}:${field}`, "track", [r], primary, r.fileId);
      if (it.unresolved) needsChoice.push(it);
      else {
        if (!gridFields.includes(r.field)) gridFields.push(r.field);
        cells.get(r.fileId)![r.field] = it;
      }
    }
  }

  const grid = trackFiles.map((fileId) => ({ fileId, cells: cells.get(fileId)! }))
    .filter((row) => Object.keys(row.cells).length > 0);
  const items = [...needsChoice, ...album, ...allTracks, ...grid.flatMap((r) => Object.values(r.cells))];
  const total = items.reduce((n, it) => n + it.weight, 0) + (coverProposes(p) ? 1 : 0);

  // Selected: as the write counts it (status.ts changesToWrite), which is what the header says.
  const writing = p.fields.filter(writes);
  const selected = new Set(writing.filter((r) => RELEASE.has(r.field)).map((r) => r.field)).size +
    writing.filter((r) => !RELEASE.has(r.field)).length + (p.cover?.writes ? 1 : 0);

  // An album field is already right only when no file needs it changed.
  const albumRight = new Set<string>(p.fields.filter((r) => RELEASE.has(r.field)).map((r) => r.field));
  for (const field of albumRows.keys()) albumRight.delete(field);
  const alreadyRight = albumRight.size + p.fields.filter((r) => !RELEASE.has(r.field) && !proposes(r)).length;

  return { needsChoice, album, allTracks, gridFields, grid, selected, total, alreadyRight };
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
