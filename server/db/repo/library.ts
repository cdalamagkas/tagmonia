/** Data access for library_file and candidate (ARCHITECTURE.md §6.1). */
import type { Db } from "../db.ts";
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
       read_error = excluded.read_error, scanned_at = excluded.scanned_at`,
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
  limit: number;
  offset: number;
}

export interface ReleaseRow {
  id: number;
  folder: string;
  artist: string | null;
  album: string | null;
  mbid: string | null;
  trackCount: number;
  formats: string[];
  status: string;
  errorCount: number;
  hasCover: boolean;
  updatedAt: number;
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
}

const RELEASE_SELECT = `
  SELECT c.id, c.folder, c.hint_artist, c.hint_album, c.hint_mbid, c.file_count, c.status, c.updated_at,
         (SELECT group_concat(DISTINCT f.format) FROM library_file f WHERE f.candidate_id = c.id) AS formats,
         (SELECT count(*) FROM library_file f WHERE f.candidate_id = c.id AND f.read_error IS NOT NULL) AS errors,
         (SELECT count(*) FROM library_file f WHERE f.candidate_id = c.id AND f.pictures <> '[]') AS covers
  FROM candidate c`;

function toRelease(r: ReleaseSqlRow): ReleaseRow {
  return {
    id: r.id,
    folder: r.folder,
    artist: r.hint_artist,
    album: r.hint_album,
    mbid: r.hint_mbid,
    trackCount: r.file_count,
    formats: r.formats ? r.formats.split(",").sort() : [],
    status: r.status,
    errorCount: r.errors,
    hasCover: r.covers > 0,
    updatedAt: r.updated_at,
  };
}

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
}

export function listReleases(db: Db, query: ReleaseListQuery): { total: number; items: ReleaseRow[] } {
  const q = query.q?.trim();
  const where = q
    ? "WHERE c.hint_artist LIKE ? ESCAPE '\\' OR c.hint_album LIKE ? ESCAPE '\\' OR c.folder LIKE ? ESCAPE '\\'"
    : "";
  const args = q ? [likePattern(q), likePattern(q), likePattern(q)] : [];
  const total = (db.prepare(`SELECT count(*) n FROM candidate c ${where}`).get(...args) as { n: number }).n;
  const rows = db.prepare(
    `${RELEASE_SELECT} ${where}
     ORDER BY c.hint_artist IS NULL, c.hint_artist COLLATE NOCASE, c.hint_album COLLATE NOCASE, c.folder LIMIT ? OFFSET ?`,
  ).all(...args, query.limit, query.offset) as unknown as ReleaseSqlRow[];
  return { total, items: rows.map(toRelease) };
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

export function librarySummary(db: Db): { files: number; releases: number; unreadable: number } {
  const row = db.prepare(
    `SELECT (SELECT count(*) FROM library_file) files, (SELECT count(*) FROM candidate) releases,
            (SELECT count(*) FROM library_file WHERE read_error IS NOT NULL) unreadable`,
  ).get() as { files: number; releases: number; unreadable: number };
  return { ...row };
}
