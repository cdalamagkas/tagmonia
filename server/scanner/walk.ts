/**
 * Library walk (ARCHITECTURE.md §7 step 1-2). Yields audio files by extension;
 * the scanner confirms the format with TagIO's `sniffFormat` only for new or changed files.
 *
 * Symlinks are never followed (D21): one inside the root points at files the
 * walk reaches anyway, and one leading outside is rejected by §14.4.
 */
import { globToRegExp } from "@std/path/glob-to-regexp";
import { join } from "node:path";
import { type AudioFormat, isTagmonyTempFile } from "../tagio/mod.ts";

export const AUDIO_EXTENSIONS: Readonly<Record<string, AudioFormat>> = {
  flac: "flac",
  ogg: "ogg",
  oga: "ogg",
  opus: "opus",
  mp3: "mp3",
  m4a: "m4a",
};

/** NAS and OS bookkeeping folders that never hold the user's music. */
const SKIP_DIRS = new Set(["@eaDir", "#recycle", "#snapshot", "@Recycle", "lost+found", "$RECYCLE.BIN"]);

export interface WalkEntry {
  /** Relative to the music root, '/' separators. */
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
  /** From the extension; confirm with `sniff` before trusting it. */
  format: AudioFormat;
}

export interface WalkStats {
  files: number;
  skippedSymlinks: number;
  ignored: number;
  unreadableDirs: number;
}

export function compileIgnore(globs: string[]): RegExp[] {
  return globs.map((g) => globToRegExp(g, { globstar: true, extended: true, caseInsensitive: false }));
}

export function extensionFormat(name: string): AudioFormat | undefined {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? AUDIO_EXTENSIONS[name.slice(dot + 1).toLowerCase()] : undefined;
}

export async function* walkLibrary(
  rootReal: string,
  opts: { ignore?: RegExp[]; signal?: AbortSignal; stats?: WalkStats } = {},
): AsyncGenerator<WalkEntry> {
  const ignore = opts.ignore ?? [];
  const stats = opts.stats ?? { files: 0, skippedSymlinks: 0, ignored: 0, unreadableDirs: 0 };
  const ignored = (rel: string) => ignore.some((re) => re.test(rel));
  const stack: string[] = [""];
  while (stack.length) {
    opts.signal?.throwIfAborted();
    const relDir = stack.pop()!;
    const absDir = relDir ? join(rootReal, relDir) : rootReal;
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(absDir));
    } catch {
      stats.unreadableDirs++;
      continue;
    }
    // Deterministic order makes scans and tests reproducible.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isSymlink) {
        stats.skippedSymlinks++;
        continue;
      }
      if (e.isDirectory) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (ignored(rel) || ignored(`${rel}/`)) {
          stats.ignored++;
          continue;
        }
        subdirs.push(rel);
        continue;
      }
      if (!e.isFile || isTagmonyTempFile(e.name)) continue;
      const format = extensionFormat(e.name);
      if (!format) continue;
      if (ignored(rel)) {
        stats.ignored++;
        continue;
      }
      const abs = join(rootReal, rel);
      let st: Deno.FileInfo;
      try {
        st = await Deno.lstat(abs);
      } catch {
        continue; // vanished mid-walk
      }
      stats.files++;
      yield { rel, abs, size: st.size, mtimeMs: Math.trunc(st.mtime?.getTime() ?? 0), format };
    }
    // Reverse so the stack pops directories in name order.
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
  }
}
