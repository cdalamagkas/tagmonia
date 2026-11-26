/**
 * Renaming on write (docs/proposals/inbox-and-renaming.md, D57). The plan is pure: each file's tags as they
 * will be after the write, through the naming template, give its new path. The moves run after every tag
 * write verified, all or nothing per album; they are journaled in `file_move`, and undo moves files back
 * before it restores their tags (§11.3).
 */
import { basename, dirname, extname, join } from "node:path";
import { renderPath } from "../../shared/naming.ts";
import type { Db } from "../db/db.ts";
import { isInboxPath, Roots } from "../fs/safe_path.ts";
import { AUDIO_EXTENSIONS } from "../scanner/walk.ts";
import type { CanonicalTags, TagChange } from "../tagio/mod.ts";

export interface RenameFile {
  id: number;
  /** Relative to the music root. */
  path: string;
  /** Its tags as they will be after the write. */
  tags: CanonicalTags;
}

export interface PlannedMove {
  fileId: number;
  from: string;
  to: string;
}

export interface RenamePlan {
  moves: PlannedMove[];
  /** Source folder → target folder, where every audio file of the folder goes to one place. */
  folders: { from: string; to: string }[];
  /** Why the album cannot be renamed as planned (a name taken by another file), or empty. */
  conflicts: string[];
}

/** A file's tags after the write: what it has, with the plan's change applied. */
export function tagsAfter(current: CanonicalTags, change: TagChange | undefined): CanonicalTags {
  if (!change) return current;
  const out: Record<string, unknown> = { ...current, ...change.set };
  for (const f of change.remove) delete out[f];
  return out as CanonicalTags;
}

const folderOf = (p: string) => (dirname(p) === "." ? "" : dirname(p));
const key = (p: string) => p.normalize("NFC").toLowerCase();

/**
 * New paths for an album's files. Two files that would get the same name get " (2)", " (3)" … before the
 * extension. `taken` is every other path in the library (any case): a target there is a conflict, since
 * nothing is ever overwritten. Names compare without case: Windows and SMB shares ignore it.
 */
export function planRenames(template: string, files: RenameFile[], taken: Iterable<string>): RenamePlan {
  const mine = new Set(files.map((f) => key(f.path)));
  const others = new Set([...taken].map(key).filter((p) => !mine.has(p)));
  const used = new Set<string>();
  const moves: PlannedMove[] = [];
  const conflicts: string[] = [];
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    const ext = extname(f.path).slice(1);
    let to = renderPath(template, f.tags as Record<string, unknown>, ext);
    for (let n = 2; used.has(key(to)); n++) {
      to = renderPath(template, f.tags as Record<string, unknown>, ext).replace(/(\.[^./]+)?$/, ` (${n})$1`);
    }
    used.add(key(to));
    if (others.has(key(to))) conflicts.push(`${to} already exists`);
    if (to !== f.path) moves.push({ fileId: f.id, from: f.path, to });
  }
  // Folders whose audio all goes to one new folder: their other files (cover, booklet) can follow.
  const targets = new Map<string, Set<string>>();
  for (const f of sorted) {
    const m = moves.find((x) => x.fileId === f.id);
    const to = folderOf(m ? m.to : f.path);
    targets.set(folderOf(f.path), (targets.get(folderOf(f.path)) ?? new Set()).add(to));
  }
  const folders = [...targets]
    .filter(([from, to]) => to.size === 1 && [...to][0] !== from)
    .map(([from, to]) => ({ from, to: [...to][0] }));
  return { moves, folders, conflicts };
}

export class RenameError extends Error {
  override name = "RenameError";
}

/** The same file under two names (a case-only rename on a case-insensitive file system). */
async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([Deno.stat(a), Deno.stat(b)]);
    return x.dev === y.dev && x.ino !== null && x.ino === y.ino;
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.lstat(p);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

async function sha256File(p: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", await Deno.readFile(p));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One move. `rename(2)` where it can; across file systems, a copy that is synced and compared by size and
 * SHA-256 before the original is removed. Never over an existing file.
 */
export async function moveFile(fromAbs: string, toAbs: string): Promise<void> {
  if (await exists(toAbs) && !(await sameFile(fromAbs, toAbs))) throw new RenameError(`${basename(toAbs)} exists`);
  await Deno.mkdir(dirname(toAbs), { recursive: true });
  try {
    await Deno.rename(fromAbs, toAbs);
    return;
  } catch (e) {
    // EXDEV: another file system (an inbox on another mount, D57).
    if (!(e instanceof Error && /EXDEV|cross-device/i.test(e.message))) throw e;
  }
  const tmp = join(dirname(toAbs), `.${basename(toAbs)}.tagmonia-tmp`);
  await Deno.copyFile(fromAbs, tmp);
  const f = await Deno.open(tmp, { read: true, write: true });
  try {
    await f.sync();
  } finally {
    f.close();
  }
  const [a, b] = await Promise.all([Deno.stat(fromAbs), Deno.stat(tmp)]);
  if (a.size !== b.size || (await sha256File(fromAbs)) !== (await sha256File(tmp))) {
    await Deno.remove(tmp);
    throw new RenameError(`the copy of ${basename(fromAbs)} did not match`);
  }
  await Deno.rename(tmp, toAbs);
  await Deno.remove(fromAbs);
}

/** Removes `folder` and its parents while they are empty, never a root itself (library or inbox). */
export async function removeEmptyFolders(roots: Roots, folder: string): Promise<void> {
  let rel = folder;
  while (rel && rel !== "." && rel !== "@inbox") {
    let abs: string;
    try {
      abs = roots.target(rel);
    } catch {
      return;
    }
    if (abs === roots.library || abs === roots.inbox) return;
    try {
      for await (const _ of Deno.readDir(abs)) return;
      await Deno.remove(abs);
    } catch {
      return;
    }
    rel = folderOf(rel);
  }
}

interface MoveRow {
  kind: "audio" | "companion";
  fileId: number | null;
  from: string;
  to: string;
}

function isAudio(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && name.slice(dot + 1).toLowerCase() in AUDIO_EXTENSIONS;
}

/** The other files of a folder whose audio all moves: they follow the album; subfolders and audio stay. */
async function companions(roots: Roots, plan: RenamePlan, moving: Set<string>): Promise<MoveRow[]> {
  const out: MoveRow[] = [];
  for (const { from, to } of plan.folders) {
    const abs = await roots.resolve(from);
    for await (const e of Deno.readDir(abs)) {
      if (!e.isFile || isAudio(e.name)) continue;
      const src = from ? `${from}/${e.name}` : e.name;
      if (moving.has(src)) continue;
      out.push({ kind: "companion", fileId: null, from: src, to: to ? `${to}/${e.name}` : e.name });
    }
  }
  return out;
}

/** Whether a folder still holds audio that is not part of this album (then nothing else leaves it). */
function foldersWithOtherAudio(db: Db, plan: RenamePlan, ids: Set<number>): Set<string> {
  const out = new Set<string>();
  for (const { from } of plan.folders) {
    const rows = db.prepare("SELECT id FROM library_file WHERE folder = ?").all(from) as { id: number }[];
    if (rows.some((r) => !ids.has(r.id))) out.add(from);
  }
  return out;
}

/**
 * Runs the plan for one write batch: checks every target first, then moves the audio and the companion
 * files, journaling each. Any failure moves back what was already moved, so an album is never split.
 * The database follows the files. Returns the moves made (none when `plan` has none).
 */
export async function applyRenames(
  db: Db,
  roots: Roots,
  batchId: number,
  plan: RenamePlan,
  candidateId: number,
): Promise<number> {
  if (plan.conflicts.length) throw new RenameError(plan.conflicts.join("; "));
  if (plan.moves.length === 0) return 0;
  const ids = new Set(plan.moves.map((m) => m.fileId));
  const busy = foldersWithOtherAudio(db, plan, ids);
  const safe = { ...plan, folders: plan.folders.filter((f) => !busy.has(f.from)) };
  const rows: MoveRow[] = [
    ...plan.moves.map((m) => ({ kind: "audio" as const, fileId: m.fileId, from: m.from, to: m.to })),
    ...await companions(roots, safe, new Set(plan.moves.map((m) => m.from))),
  ];
  // Every target checked before anything moves. Targets are always in the library, never the inbox.
  for (const r of rows) {
    if (isInboxPath(r.to)) throw new RenameError(`${r.to} is not in the library`);
    let toAbs: string;
    try {
      toAbs = roots.target(r.to);
    } catch {
      throw new RenameError(`${r.to} is outside the library`);
    }
    const fromAbs = await roots.resolve(r.from);
    if (await exists(toAbs) && !(await sameFile(fromAbs, toAbs))) {
      if (r.kind === "audio") throw new RenameError(`${r.to} already exists`);
      r.to = ""; // a companion whose name is taken stays where it is
    }
  }
  const todo = rows.filter((r) => r.to);
  const ins = db.prepare(
    "INSERT INTO file_move (write_batch_id, file_id, kind, from_path, to_path, status) VALUES (?, ?, ?, ?, ?, 'moved')",
  );
  const done: MoveRow[] = [];
  try {
    for (const r of todo) {
      await moveFile(await roots.resolve(r.from), roots.target(r.to));
      done.push(r);
    }
  } catch (e) {
    for (const r of done.reverse()) {
      await moveFile(roots.target(r.to), roots.target(r.from)).catch(() => {});
    }
    for (const r of done) await removeEmptyFolders(roots, folderOf(r.to));
    throw new RenameError(`not renamed: ${(e as Error).message}`);
  }
  for (const r of done) ins.run(batchId, r.fileId, r.kind, r.from, r.to);
  const upd = db.prepare("UPDATE library_file SET path = ?, folder = ? WHERE id = ?");
  for (const r of done) if (r.fileId !== null) upd.run(r.to, folderOf(r.to), r.fileId);
  setCandidateFolder(db, candidateId);
  for (const f of new Set(done.map((r) => folderOf(r.from)))) await removeEmptyFolders(roots, f);
  return done.filter((r) => r.kind === "audio").length;
}

/** The release's folder: the deepest folder holding all its files (the album folder, or a multi-disc parent). */
export function setCandidateFolder(db: Db, candidateId: number): void {
  const paths = (db.prepare("SELECT folder FROM library_file WHERE candidate_id = ?").all(candidateId) as {
    folder: string;
  }[]).map((r) => r.folder.split("/").filter(Boolean));
  if (paths.length === 0) return;
  let common = paths[0];
  for (const p of paths.slice(1)) {
    let i = 0;
    while (i < common.length && i < p.length && common[i] === p[i]) i++;
    common = common.slice(0, i);
  }
  db.prepare("UPDATE candidate SET folder = ? WHERE id = ?").run(common.join("/"), candidateId);
}

/**
 * Moves a batch's files back, before its tags are restored. A file that is no longer where the write put
 * it, or whose old name is taken, is left alone and reported, and its tags are not touched either.
 * Returns the paths (as the write recorded them) whose files could not be moved back.
 */
export async function undoRenames(
  db: Db,
  roots: Roots,
  batchId: number,
  undoId: number,
  candidateId: number | null,
): Promise<{ moved: number; blocked: Map<string, string> }> {
  const rows = db.prepare(
    "SELECT id, file_id, kind, from_path, to_path FROM file_move WHERE write_batch_id = ? AND status = 'moved' ORDER BY id DESC",
  ).all(batchId) as { id: number; file_id: number | null; kind: string; from_path: string; to_path: string }[];
  const blocked = new Map<string, string>();
  let moved = 0;
  const mark = db.prepare("UPDATE file_move SET status = 'undone' WHERE id = ?");
  const log = db.prepare(
    "INSERT INTO file_move (write_batch_id, file_id, kind, from_path, to_path, status, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const upd = db.prepare("UPDATE library_file SET path = ?, folder = ? WHERE id = ?");
  for (const r of rows) {
    try {
      const fromAbs = await roots.resolve(r.to_path);
      if (r.file_id !== null) {
        const now = db.prepare("SELECT path FROM library_file WHERE id = ?").get(r.file_id) as
          | { path: string }
          | undefined;
        if (now?.path !== r.to_path) throw new RenameError("moved again since the write");
      }
      await moveFile(fromAbs, roots.target(r.from_path));
      mark.run(r.id);
      log.run(undoId, r.file_id, r.kind, r.to_path, r.from_path, "moved", null);
      if (r.file_id !== null) upd.run(r.from_path, folderOf(r.from_path), r.file_id);
      if (r.kind === "audio") moved++;
    } catch (e) {
      const why = e instanceof Deno.errors.NotFound ? "no longer where the write put it" : (e as Error).message;
      log.run(undoId, r.file_id, r.kind, r.to_path, r.from_path, "failed", why);
      if (r.kind === "audio") blocked.set(r.from_path, `not moved back: ${why}`);
    }
  }
  for (const f of new Set(rows.map((r) => folderOf(r.to_path)))) await removeEmptyFolders(roots, f);
  if (candidateId !== null) setCandidateFolder(db, candidateId);
  return { moved, blocked };
}
