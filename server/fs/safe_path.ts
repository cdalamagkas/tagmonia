/**
 * Music-root confinement (ARCHITECTURE.md §14.4, CLAUDE.md safety rule 3).
 * Every path from the database or the API goes through here before any
 * filesystem access. Stored paths are relative, with '/' separators.
 */
import { isAbsolute, join, normalize, relative, sep } from "node:path";

export class PathEscapeError extends Error {
  override name = "PathEscapeError";
  constructor(message = "path is outside the music root") {
    super(message);
  }
}

/** True when `abs` is `root` or inside it. Both must be absolute and normalised. */
export function isInside(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Converts an absolute path inside `root` to the stored relative form. */
export function toRelative(root: string, abs: string): string {
  if (!isInside(root, abs)) throw new PathEscapeError();
  return relative(root, abs).split(sep).join("/");
}

/** Lexical check of a stored relative path: no absolute paths, no `..`, no NUL. */
export function assertSafeRelative(rel: string): void {
  if (rel.includes("\0") || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new PathEscapeError();
  const parts = rel.split(/[\\/]/);
  if (parts.includes("..")) throw new PathEscapeError();
}

/**
 * Resolves a stored relative path to a real absolute path and checks it is
 * still inside the (real) music root after following symlinks.
 */
export async function resolveInRoot(rootReal: string, rel: string): Promise<string> {
  assertSafeRelative(rel);
  const joined = normalize(join(rootReal, rel));
  if (!isInside(rootReal, joined)) throw new PathEscapeError();
  const real = await Deno.realPath(joined);
  if (!isInside(rootReal, real)) throw new PathEscapeError("path resolves outside the music root via a symlink");
  return real;
}
