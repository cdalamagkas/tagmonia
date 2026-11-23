/**
 * Grouping files into release candidates (ARCHITECTURE.md §7 step 4). Pure
 * functions; the scanner feeds them the files of one *unit*: a folder plus its
 * disc subfolders (CD1, Disc 2, ...).
 */
import type { CanonicalTags } from "../tagio/types.ts";

/** "CD1", "CD 2", "Disc 02", "disk3 - Bonus", "Disco 1". */
export const DISC_FOLDER = /^(?:cd|dis[ck]|disco|disque)[\s._-]*\d{1,3}(?:\D|$)/i;

export function basename(folder: string): string {
  return folder.slice(folder.lastIndexOf("/") + 1);
}

export function parentFolder(folder: string): string {
  const i = folder.lastIndexOf("/");
  return i < 0 ? "" : folder.slice(0, i);
}

export function isDiscFolder(folder: string): boolean {
  return folder !== "" && DISC_FOLDER.test(basename(folder));
}

/** The unit a folder belongs to: its parent when it is a disc folder, otherwise itself. */
export function unitRoot(folder: string): string {
  return isDiscFolder(folder) ? parentFolder(folder) : folder;
}

/** True when `folder` is part of the unit rooted at `root`. */
export function inUnit(root: string, folder: string): boolean {
  return folder === root || (isDiscFolder(folder) && parentFolder(folder) === root);
}

function norm(s: string | undefined): string {
  return (s ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Album identity of a file, or undefined for a "loose" file with no album tag.
 * Uses the album artist, not the track artist, so a compilation stays one group.
 */
export function albumKey(tags: CanonicalTags): string | undefined {
  if (tags.musicbrainz_albumid) return `mbid:${norm(tags.musicbrainz_albumid)}`;
  if (tags.album && norm(tags.album)) return `tag:${JSON.stringify([norm(tags.albumartist), norm(tags.album)])}`;
  return undefined;
}

export interface GroupFile {
  path: string;
  folder: string;
  tags: CanonicalTags;
}

export interface Group {
  /** Stable across rescans while the unit and album identity stay the same. */
  key: string;
  folder: string;
  paths: string[];
  hintArtist: string | null;
  hintAlbum: string | null;
  hintMbid: string | null;
  loose: boolean;
}

function mode(values: (string | undefined)[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [v, c] of counts) {
    if (c > n) [best, n] = [v, c];
  }
  return best;
}

/**
 * Groups one unit's files. Files that share an album identity form one group
 * across the unit folder and its disc folders; files without an album tag form
 * one "loose" group per folder, left for fingerprinting.
 */
export function groupUnit(root: string, files: GroupFile[]): Group[] {
  const buckets = new Map<string, GroupFile[]>();
  for (const f of files) {
    if (!inUnit(root, f.folder)) throw new Error(`${f.path} is not in unit "${root}"`);
    const k = albumKey(f.tags) ?? `loose:${f.folder}`;
    const b = buckets.get(k);
    if (b) b.push(f);
    else buckets.set(k, [f]);
  }
  const groups: Group[] = [];
  for (const [k, members] of buckets) {
    members.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    groups.push({
      // JSON, not a NUL separator: SQLite text bindings stop at NUL.
      key: JSON.stringify([root, k]),
      folder: root,
      paths: members.map((m) => m.path),
      hintArtist: mode(members.map((m) => m.tags.albumartist ?? m.tags.artist)),
      hintAlbum: mode(members.map((m) => m.tags.album)),
      hintMbid: mode(members.map((m) => m.tags.musicbrainz_albumid)),
      loose: k.startsWith("loose:"),
    });
  }
  return groups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
