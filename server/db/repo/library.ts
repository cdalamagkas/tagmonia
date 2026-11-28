/** Data access for library_file and candidate (ARCHITECTURE.md §6.1). */
import { INBOX, isInboxPath } from "../../fs/safe_path.ts";
import type { Db } from "../db.ts";
import type {
  FolderNodeDto,
  FolderTreeDto,
  ReleaseChangesDto,
  ReleaseSort,
  ReleaseStatusFilter,
} from "../../../shared/types.ts";
import type { CanonicalTags } from "../../tagio/mod.ts";
import { inUnit } from "../../scanner/group.ts";

export interface FileIndexEntry {
  id: number;
  size: number;
  mtimeMs: number;
  folder: string;
}

export interface PictureMeta {
  type: string;
  mime: string;
  size: number;
}

export interface FileRecord {
  path: string;
  folder: string;
  size: number;
  mtimeMs: number;
  format: string | null;
  durationMs: number | null;
  sampleRate: number | null;
  channels: number | null;
  bitrateKbps: number | null;
  tags: CanonicalTags;
  pictures: PictureMeta[];
  readError: string | null;
  scannedAt: number;
}

export interface StoredFile extends FileRecord {
  id: number;
  candidateId: number | null;
}

interface FileRow {
  id: number;
  path: string;
  folder: string;
  size: number;
  mtime_ms: number;
  format: string | null;
  duration_ms: number | null;
  sample_rate: number | null;
  channels: number | null;
  bitrate_kbps: number | null;
  current_tags: string;
  pictures: string;
  read_error: string | null;
  candidate_id: number | null;
  scanned_at: number;
}

function toFile(r: FileRow): StoredFile {
  return {
    id: r.id,
    path: r.path,
    folder: r.folder,
    size: r.size,
    mtimeMs: r.mtime_ms,
    format: r.format,
    durationMs: r.duration_ms,
    sampleRate: r.sample_rate,
    channels: r.channels,
    bitrateKbps: r.bitrate_kbps,
    tags: JSON.parse(r.current_tags),
    pictures: JSON.parse(r.pictures),
    readError: r.read_error,
    candidateId: r.candidate_id,
    scannedAt: r.scanned_at,
  };
}

export function fileIndex(db: Db): Map<string, FileIndexEntry> {
  const out = new Map<string, FileIndexEntry>();
  const rows = db.prepare("SELECT id, path, size, mtime_ms, folder FROM library_file").all() as unknown as {
    id: number;
    path: string;
    size: number;
    mtime_ms: number;
    folder: string;
  }[];
  for (const r of rows) out.set(r.path, { id: r.id, size: r.size, mtimeMs: r.mtime_ms, folder: r.folder });
  return out;
}

export function upsertFile(db: Db, f: FileRecord): void {
  db.prepare(
    `INSERT INTO library_file (path, folder, size, mtime_ms, format, duration_ms, sample_rate, channels, bitrate_kbps,
                               current_tags, pictures, read_error, scanned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       folder = excluded.folder, size = excluded.size, mtime_ms = excluded.mtime_ms, format = excluded.format,
       duration_ms = excluded.duration_ms, sample_rate = excluded.sample_rate, channels = excluded.channels,
       bitrate_kbps = excluded.bitrate_kbps, current_tags = excluded.current_tags, pictures = excluded.pictures,
       read_error = excluded.read_error, scanned_at = excluded.scanned_at,
       -- Only changed files are upserted: their old fingerprint describes other audio.
       fingerprint = NULL, fingerprint_duration = NULL, acoustid_id = NULL`,
  ).run(
    f.path,
    f.folder,
    f.size,
    f.mtimeMs,
    f.format,
    f.durationMs,
    f.sampleRate,
    f.channels,
    f.bitrateKbps,
    JSON.stringify(f.tags),
    JSON.stringify(f.pictures),
    f.readError,
    f.scannedAt,
  );
}

export function deleteFile(db: Db, path: string): void {
  db.prepare("DELETE FROM library_file WHERE path = ?").run(path);
}

/** Files of the unit rooted at `root`: the folder itself plus its disc subfolders. */
export function filesInUnit(db: Db, root: string): StoredFile[] {
  // Candidates by SQL (the folder and its direct children), then the exact unit rule in JS.
  const rows = (root === "" ? db.prepare("SELECT * FROM library_file WHERE instr(folder, '/') = 0").all() : db.prepare(
    "SELECT * FROM library_file WHERE folder = ? OR (substr(folder, 1, ?) = ? AND instr(substr(folder, ?), '/') = 0)",
  ).all(root, root.length + 1, root + "/", root.length + 2)) as unknown as FileRow[];
  return rows.map(toFile).filter((f) => inUnit(root, f.folder));
}

export interface CandidateRecord {
  key: string;
  folder: string;
  paths: string[];
  hintArtist: string | null;
  hintAlbum: string | null;
  hintMbid: string | null;
  contentHash: string;
}

/**
 * Makes the candidates of one unit match `groups`: existing candidates keep their
 * id (later phases hang proposals off it), changed ones are marked 'changed',
 * vanished ones are deleted. Returns the ids of new or changed candidates.
 */
export function reconcileUnit(db: Db, root: string, groups: CandidateRecord[], now: number): number[] {
  const existing = db.prepare("SELECT id, group_key, content_hash, status FROM candidate WHERE folder = ?").all(
    root,
  ) as unknown as { id: number; group_key: string; content_hash: string; status: string }[];
  const byKey = new Map(existing.map((c) => [c.group_key, c]));
  const keep = new Set<number>();
  const touched: number[] = [];
  const setFile = db.prepare("UPDATE library_file SET candidate_id = ? WHERE path = ?");
  for (const g of groups) {
    const prev = byKey.get(g.key);
    let id: number;
    if (prev) {
      id = prev.id;
      if (prev.content_hash !== g.contentHash) {
        db.prepare(
          `UPDATE candidate SET hint_artist = ?, hint_album = ?, hint_mbid = ?, hint_track_count = ?, file_count = ?,
             content_hash = ?, status = CASE WHEN status = 'new' THEN 'new' ELSE 'changed' END, updated_at = ?
           WHERE id = ?`,
        ).run(g.hintArtist, g.hintAlbum, g.hintMbid, g.paths.length, g.paths.length, g.contentHash, now, id);
        touched.push(id);
      }
    } else {
      const row = db.prepare(
        `INSERT INTO candidate (group_key, folder, hint_artist, hint_album, hint_mbid, hint_track_count, file_count,
                                content_hash, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?) RETURNING id`,
      ).get(
        g.key,
        root,
        g.hintArtist,
        g.hintAlbum,
        g.hintMbid,
        g.paths.length,
        g.paths.length,
        g.contentHash,
        now,
        now,
      ) as {
        id: number;
      };
      id = row.id;
      touched.push(id);
    }
    keep.add(id);
    for (const p of g.paths) setFile.run(id, p);
  }
  for (const c of existing) if (!keep.has(c.id)) db.prepare("DELETE FROM candidate WHERE id = ?").run(c.id);
  return touched;
}

// ---- read side for the library browser

export interface ReleaseListQuery {
  q?: string;
  /** Only the inbox's albums, or only the library's (D57); both when absent. */
  in?: "inbox" | "library";
  /** A folder and everything below it (D75), relative to `in`'s root ("" = all of it). */
  folder?: string;
  status?: ReleaseStatusFilter;
  sort?: ReleaseSort;
  limit: number;
  offset: number;
}

export interface ReleaseRow {
  id: number;
  folder: string;
  inInbox: boolean;
  artist: string | null;
  album: string | null;
  mbid: string | null;
  trackCount: number;
  formats: string[];
  status: string;
  errorCount: number;
  hasCover: boolean;
  updatedAt: number;
  /** A one-file release without an album tag (D62): the track's title, or its file name. */
  single: string | null;
  /** The latest prepared changes, from the summary cache (D75). */
  changes: ReleaseChangesDto | null;
}

interface ReleaseSqlRow {
  id: number;
  folder: string;
  hint_artist: string | null;
  hint_album: string | null;
  hint_mbid: string | null;
  file_count: number;
  status: string;
  updated_at: number;
  formats: string | null;
  errors: number;
  covers: number;
  single: string | null;
  changes_state: ReleaseChangesDto["state"] | null;
  changes_count: number | null;
  changes_choices: number | null;
}

const RELEASE_SELECT = `
  SELECT c.id, c.folder, c.hint_artist, c.hint_album, c.hint_mbid, c.file_count, c.status, c.updated_at,
         (SELECT group_concat(DISTINCT f.format) FROM library_file f WHERE f.candidate_id = c.id) AS formats,
         (SELECT count(*) FROM library_file f WHERE f.candidate_id = c.id AND f.read_error IS NOT NULL) AS errors,
         (SELECT count(*) FROM library_file f WHERE f.candidate_id = c.id AND f.pictures <> '[]') AS covers,
         CASE WHEN c.hint_album IS NULL AND c.file_count = 1 THEN
           (SELECT coalesce(json_extract(f.current_tags, '$.title'), f.path) FROM library_file f
            WHERE f.candidate_id = c.id LIMIT 1)
         END AS single,
         s.state AS changes_state, s.count AS changes_count, s.choices AS changes_choices
  FROM candidate c LEFT JOIN release_summary s ON s.candidate_id = c.id`;

function toRelease(r: ReleaseSqlRow): ReleaseRow {
  return {
    id: r.id,
    folder: r.folder,
    inInbox: isInboxPath(r.folder),
    artist: r.hint_artist,
    album: r.hint_album,
    mbid: r.hint_mbid,
    trackCount: r.file_count,
    formats: r.formats ? r.formats.split(",").sort() : [],
    status: r.status,
    errorCount: r.errors,
    hasCover: r.covers > 0,
    updatedAt: r.updated_at,
    // A path is shown by its file name.
    single: r.single === null
      ? null
      : r.single.includes("/")
      ? r.single.slice(r.single.lastIndexOf("/") + 1)
      : r.single,
    // From the summary cache (D75): current only after refreshSummaries.
    changes: r.changes_state
      ? { state: r.changes_state, count: r.changes_count ?? 0, choices: r.changes_choices ?? 0 }
      : null,
  };
}

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
}

/** The library list's status filter (D75): prepared changes first, then where identification stands. */
export const STATUS_FILTER: Record<ReleaseStatusFilter, string> = {
  ready: "s.state = 'ready'",
  choices: "s.state = 'choices'",
  stale: "s.state = 'stale'",
  complete: "s.state IN ('none', 'written')",
  unidentified: "s.state IS NULL AND c.status IN ('new', 'changed', 'identifying', 'error')",
  nomatch: "s.state IS NULL AND c.status = 'no_match'",
};

const SORT: Record<ReleaseSort, string> = {
  artist: "c.hint_artist IS NULL, c.hint_artist COLLATE NOCASE, c.hint_album COLLATE NOCASE, c.folder",
  album: "c.hint_album IS NULL, c.hint_album COLLATE NOCASE, c.hint_artist COLLATE NOCASE, c.folder",
  folder: "c.folder COLLATE NOCASE, c.hint_album COLLATE NOCASE",
  added: "c.created_at DESC, c.id DESC",
  changes:
    "coalesce(s.count, 0) DESC, coalesce(s.choices, 0) DESC, c.hint_artist COLLATE NOCASE, c.hint_album COLLATE NOCASE",
};

/** A folder relative to its root, as stored (D58: the inbox's are under "@inbox"); "" is the root itself. */
function storedFolder(root: "library" | "inbox", folder: string): string {
  const f = folder.replace(/^\/+|\/+$/g, "");
  if (root === "inbox") return f ? `${INBOX}/${f}` : INBOX;
  return f;
}

/** The releases of a root, or of a folder and everything below it (D75). Null: no condition (everything). */
export function scopeCondition(
  root: "library" | "inbox" | undefined,
  folder: string | undefined,
): { sql: string; args: string[] } | null {
  const f = (folder ?? "").replace(/^\/+|\/+$/g, "");
  if (!root && !f) return null;
  if ((root ?? "library") === "library" && !f) {
    return { sql: `NOT (c.folder = '${INBOX}' OR c.folder LIKE '${INBOX}/%')`, args: [] };
  }
  const base = storedFolder(root ?? "library", f);
  return { sql: "(c.folder = ? OR c.folder LIKE ? ESCAPE '\\')", args: [base, `${likeEscape(base)}/%`] };
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => "\\" + m);
}

export type StatusCounts = Record<"all" | ReleaseStatusFilter, number>;

/** The search and the folder scope of a list query, as SQL (the status filter is added by the caller). */
function scopeAndSearch(query: Pick<ReleaseListQuery, "q" | "in" | "folder">): { conds: string[]; args: string[] } {
  const q = query.q?.trim();
  const conds: string[] = [];
  const args: string[] = [];
  if (q) {
    // File names too: a single file without tags is known only by its name (D62).
    conds.push(
      `(c.hint_artist LIKE ? ESCAPE '\\' OR c.hint_album LIKE ? ESCAPE '\\' OR c.folder LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM library_file f WHERE f.candidate_id = c.id AND f.path LIKE ? ESCAPE '\\'))`,
    );
    args.push(likePattern(q), likePattern(q), likePattern(q), likePattern(q));
  }
  const scope = scopeCondition(query.in, query.folder);
  if (scope) {
    conds.push(scope.sql);
    args.push(...scope.args);
  }
  return { conds, args };
}

/**
 * Every release a view shows (D75): the same folder, search and status as the list, all of them, in the list's
 * order, up to `limit`. What bulk actions apply to when "everything in this view" is chosen.
 */
export function releaseIds(
  db: Db,
  query: Pick<ReleaseListQuery, "q" | "in" | "folder" | "status" | "sort">,
  limit: number,
): number[] {
  const { conds, args } = scopeAndSearch(query);
  if (query.status) conds.push(STATUS_FILTER[query.status]);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  return (db.prepare(
    `SELECT c.id FROM candidate c LEFT JOIN release_summary s ON s.candidate_id = c.id ${where}
     ORDER BY ${SORT[query.sort ?? "artist"]} LIMIT ?`,
  ).all(...args, limit) as { id: number }[]).map((r) => r.id);
}

export function listReleases(
  db: Db,
  query: ReleaseListQuery,
): { total: number; items: ReleaseRow[]; counts: StatusCounts } {
  const { conds, args } = scopeAndSearch(query);
  const from = "FROM candidate c LEFT JOIN release_summary s ON s.candidate_id = c.id";
  // Counts per status for the folder and search, before the status filter: they label the filter's options.
  const buckets = Object.entries(STATUS_FILTER).map(([k, sql]) => `sum(CASE WHEN ${sql} THEN 1 ELSE 0 END) AS ${k}`);
  const counted = db.prepare(
    `SELECT count(*) AS everything, ${buckets.join(", ")} ${from} ${
      conds.length ? `WHERE ${conds.join(" AND ")}` : ""
    }`,
  ).get(...args) as Record<string, number | null>;
  const counts = { all: counted.everything ?? 0 } as StatusCounts;
  for (const k of Object.keys(STATUS_FILTER) as ReleaseStatusFilter[]) counts[k] = counted[k] ?? 0;
  if (query.status) conds.push(STATUS_FILTER[query.status]);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT count(*) n ${from} ${where}`).get(...args) as { n: number }).n;
  const rows = db.prepare(
    `${RELEASE_SELECT} ${where} ORDER BY ${SORT[query.sort ?? "artist"]} LIMIT ? OFFSET ?`,
  ).all(...args, query.limit, query.offset) as unknown as ReleaseSqlRow[];
  return { total, items: rows.map(toRelease), counts };
}

/**
 * One level of the folder tree (D75), from the releases the scan found, not the disk: the subfolders of `path`
 * that hold releases, each with its counts, and the releases directly in `path`.
 */
export function folderTree(db: Db, root: "library" | "inbox", path: string): FolderTreeDto {
  const base = path.replace(/^\/+|\/+$/g, "");
  const scope = scopeCondition(root, base)!;
  const rows = db.prepare(
    `SELECT c.folder, s.state FROM candidate c LEFT JOIN release_summary s ON s.candidate_id = c.id WHERE ${scope.sql}`,
  ).all(...scope.args) as { folder: string; state: string | null }[];
  const prefix = storedFolder(root, base);
  const children = new Map<string, FolderNodeDto>();
  let here = 0, withChanges = 0;
  for (const r of rows) {
    const changes = r.state === "ready" || r.state === "choices" ? 1 : 0;
    withChanges += changes;
    const rest = r.folder === prefix ? "" : prefix ? r.folder.slice(prefix.length + 1) : r.folder;
    if (!rest) {
      here++;
      continue;
    }
    const [name, ...deeper] = rest.split("/");
    const node = children.get(name) ??
      { name, path: base ? `${base}/${name}` : name, releases: 0, withChanges: 0, hasChildren: false };
    node.releases++;
    node.withChanges += changes;
    if (deeper.length) node.hasChildren = true;
    children.set(name, node);
  }
  return {
    root,
    path: base,
    releases: rows.length,
    withChanges,
    here,
    children: [...children.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })
    ),
  };
}

export function getRelease(db: Db, id: number): { release: ReleaseRow; files: StoredFile[] } | undefined {
  const r = db.prepare(`${RELEASE_SELECT} WHERE c.id = ?`).get(id) as ReleaseSqlRow | undefined;
  if (!r) return undefined;
  const files = (db.prepare(
    `SELECT * FROM library_file WHERE candidate_id = ?
     ORDER BY coalesce(json_extract(current_tags, '$.discnumber'), 1), json_extract(current_tags, '$.tracknumber'), path`,
  ).all(id) as unknown as FileRow[]).map(toFile);
  return { release: toRelease(r), files };
}

export function librarySummary(
  db: Db,
): { files: number; releases: number; unreadable: number; inboxReleases: number } {
  const row = db.prepare(
    `SELECT (SELECT count(*) FROM library_file) files, (SELECT count(*) FROM candidate) releases,
            (SELECT count(*) FROM library_file WHERE read_error IS NOT NULL) unreadable,
            (SELECT count(*) FROM candidate WHERE folder = '${INBOX}' OR folder LIKE '${INBOX}/%') inboxReleases`,
  ).get() as { files: number; releases: number; unreadable: number; inboxReleases: number };
  return { ...row };
}

// ---- fingerprints (§8 order 4)

export interface StoredFingerprint {
  fingerprint: string;
  durationSec: number;
}

export function getFingerprint(db: Db, fileId: number): StoredFingerprint | null {
  const r = db.prepare("SELECT fingerprint, fingerprint_duration FROM library_file WHERE id = ?").get(fileId) as
    | { fingerprint: string | null; fingerprint_duration: number | null }
    | undefined;
  return r?.fingerprint && r.fingerprint_duration !== null
    ? { fingerprint: r.fingerprint, durationSec: r.fingerprint_duration }
    : null;
}

export function setFingerprint(db: Db, fileId: number, fp: StoredFingerprint): void {
  db.prepare("UPDATE library_file SET fingerprint = ?, fingerprint_duration = ? WHERE id = ?").run(
    fp.fingerprint,
    fp.durationSec,
    fileId,
  );
}

export function setAcoustidId(db: Db, fileId: number, acoustidId: string | null): void {
  db.prepare("UPDATE library_file SET acoustid_id = ? WHERE id = ?").run(acoustidId, fileId);
}
