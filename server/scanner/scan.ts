/**
 * Incremental library scan (ARCHITECTURE.md §7). Unchanged files (same size and
 * mtime) are skipped; only units whose files changed are regrouped.
 *
 * Read-only towards the library: this module never writes to the music root.
 */
import type { ScanProgressDto, ScanResultDto } from "../../shared/types.ts";
import { transaction } from "../db/db.ts";
import type { Db } from "../db/db.ts";
import {
  type CandidateRecord,
  deleteFile,
  fileIndex,
  type FileRecord,
  filesInUnit,
  reconcileUnit,
  upsertFile,
} from "../db/repo/library.ts";
import type { Logger } from "../log.ts";
import { type AudioFormat, sniffFormat, type TagIO } from "../tagio/mod.ts";
import { groupUnit, parentFolder, unitRoot } from "./group.ts";
import { compileIgnore, walkLibrary, type WalkStats } from "./walk.ts";

export type ScanProgress = ScanProgressDto;
export type ScanResult = ScanResultDto;

export interface ScanDeps {
  db: Db;
  tagio: TagIO;
  /** realpath of the music root. */
  rootReal: string;
  ignore: string[];
  logger: Logger;
  signal?: AbortSignal;
  progress?: (p: ScanProgress) => void;
  now?: () => number;
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A candidate's content hash: changes whenever a member file is added, removed
 * or modified. Shared with the write job, which must leave a hash the next scan
 * agrees with, or every written release would look "changed" (§11.3).
 */
export async function candidateContentHash(files: { path: string; size: number; mtimeMs: number }[]): Promise<string> {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return await sha256Hex(JSON.stringify(sorted.map((f) => [f.path, f.size, f.mtimeMs])));
}

async function readFile(
  deps: ScanDeps,
  abs: string,
  rel: string,
  size: number,
  mtimeMs: number,
  format: AudioFormat,
): Promise<FileRecord> {
  const base: FileRecord = {
    path: rel,
    folder: parentFolder(rel),
    size,
    mtimeMs,
    format: null,
    durationMs: null,
    sampleRate: null,
    channels: null,
    bitrateKbps: null,
    tags: {},
    pictures: [],
    readError: null,
    scannedAt: (deps.now ?? Date.now)(),
  };
  try {
    if (!(await sniffFormat(abs, format))) {
      return { ...base, readError: `not a valid ${format} file` };
    }
    const r = await deps.tagio.read(abs, { pictureData: false });
    return {
      ...base,
      format: r.audio.format,
      durationMs: r.audio.durationMs,
      sampleRate: r.audio.sampleRate ?? null,
      channels: r.audio.channels ?? null,
      bitrateKbps: r.audio.bitrateKbps ?? null,
      tags: r.tags,
      pictures: r.pictures.map((p) => ({ type: p.type, mime: p.mime, size: p.size ?? p.data.length })),
    };
  } catch (e) {
    // Paths are relative in messages: the error is shown in the UI.
    const msg = e instanceof Error ? e.message : String(e);
    return { ...base, readError: msg.replaceAll(abs, rel) };
  }
}

export async function scanLibrary(deps: ScanDeps): Promise<ScanResult> {
  const started = performance.now();
  const now = deps.now ?? Date.now;
  const { db, logger } = deps;
  const stats: WalkStats = { files: 0, skippedSymlinks: 0, ignored: 0, unreadableDirs: 0 };
  const known = fileIndex(db);
  const seen = new Set<string>();
  const affectedUnits = new Set<string>();
  const result = { added: 0, updated: 0, removed: 0, unchanged: 0, unreadable: 0 };
  let read = 0;
  const report = (phase: ScanProgress["phase"]) => deps.progress?.({ phase, seen: seen.size, read });

  for await (
    const e of walkLibrary(deps.rootReal, { ignore: compileIgnore(deps.ignore), signal: deps.signal, stats })
  ) {
    seen.add(e.rel);
    const prev = known.get(e.rel);
    if (prev && prev.size === e.size && prev.mtimeMs === e.mtimeMs) {
      result.unchanged++;
      if (seen.size % 200 === 0) report("walking");
      continue;
    }
    const rec = await readFile(deps, e.abs, e.rel, e.size, e.mtimeMs, e.format);
    read++;
    if (rec.readError) {
      result.unreadable++;
      logger.warn("cannot read file", { path: e.rel, error: rec.readError });
    }
    upsertFile(db, rec);
    if (prev) result.updated++;
    else result.added++;
    affectedUnits.add(unitRoot(rec.folder));
    report("walking");
  }

  // Files gone from disk. An abort above skips this, so a cancelled scan never deletes rows it did not visit.
  for (const [path, entry] of known) {
    if (seen.has(path)) continue;
    deleteFile(db, path);
    result.removed++;
    affectedUnits.add(unitRoot(entry.folder));
  }

  report("grouping");
  const touched: number[] = [];
  for (const root of [...affectedUnits].sort()) {
    deps.signal?.throwIfAborted();
    const files = filesInUnit(db, root);
    const groups = groupUnit(root, files);
    const byPath = new Map(files.map((f) => [f.path, f]));
    const records: CandidateRecord[] = [];
    for (const g of groups) {
      const contentHash = await candidateContentHash(
        g.paths.map((p) => ({ path: p, size: byPath.get(p)!.size, mtimeMs: byPath.get(p)!.mtimeMs })),
      );
      records.push({
        key: g.key,
        folder: g.folder,
        paths: g.paths,
        hintArtist: g.hintArtist,
        hintAlbum: g.hintAlbum,
        hintMbid: g.hintMbid,
        contentHash,
      });
    }
    touched.push(...transaction(db, () => reconcileUnit(db, root, records, now())));
  }
  report("done");

  return {
    seen: seen.size,
    ...result,
    skippedSymlinks: stats.skippedSymlinks,
    ignored: stats.ignored,
    unreadableDirs: stats.unreadableDirs,
    unitsRegrouped: affectedUnits.size,
    candidatesTouched: touched,
    durationMs: Math.round(performance.now() - started),
  };
}
