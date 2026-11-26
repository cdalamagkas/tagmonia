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

/**
 * The inbox (D57, D58): its files are stored under this top folder, so one path column serves both roots
 * and stays unique. A real folder of that name in the library is never scanned.
 */
export const INBOX = "@inbox";

export function isInboxPath(rel: string): boolean {
  return rel === INBOX || rel.startsWith(`${INBOX}/`);
}

/** The library root and the optional inbox root, both real paths; a stored path says which it is in. */
export class Roots {
  constructor(readonly library: string, readonly inbox: string | null = null) {}

  /** Resolves the roots' real paths now: a mount may appear after startup (e.g. a NAS share). */
  static async open(musicDir: string, inboxDir?: string | null): Promise<Roots> {
    return new Roots(await Deno.realPath(musicDir), inboxDir ? await Deno.realPath(inboxDir) : null);
  }

  /** The root a stored path is in, and the path relative to it ("" for the root itself). */
  locate(rel: string): { root: string; rel: string } {
    if (!isInboxPath(rel)) return { root: this.library, rel };
    if (!this.inbox) throw new PathEscapeError("the inbox is not configured (TAGMONIA_INBOX_DIR)");
    return { root: this.inbox, rel: rel.slice(INBOX.length + 1) };
  }

  /** An existing file or folder: resolved and checked to stay inside its root (§14.4). */
  async resolve(rel: string): Promise<string> {
    const at = this.locate(rel);
    return at.rel === "" ? at.root : await resolveInRoot(at.root, at.rel);
  }

  /** Where a new file goes (it need not exist yet): checked lexically to stay inside its root. */
  target(rel: string): string {
    const at = this.locate(rel);
    assertSafeRelative(at.rel);
    const abs = normalize(join(at.root, at.rel));
    if (!isInside(at.root, abs)) throw new PathEscapeError();
    return abs;
  }
}
