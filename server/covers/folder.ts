/**
 * The album folder's cover file (cover.jpg / cover.png, D49). Not audio, so it
 * is written here rather than through TagIO, but with the same care: the folder
 * is resolved inside the music root (§14.4), a symlinked cover file is never
 * followed, and the write is atomic (temp file, fsync, rename).
 */
import { join } from "node:path";
import { resolveInRoot, Roots } from "../fs/safe_path.ts";
import { sha256Hex } from "./fetch.ts";

export class FolderCoverError extends Error {
  override name = "FolderCoverError";
}

/**
 * The real path of `<folder>/<name>` inside its root (the library, or the inbox for `@inbox/…` folders, D58);
 * `name` is a fixed file name, never user input.
 */
export async function folderCoverPath(roots: Roots | string, folderRel: string, name: string): Promise<string> {
  if (name.includes("/") || name.includes("\\") || name.startsWith(".")) throw new FolderCoverError("bad file name");
  const dir = typeof roots !== "string"
    ? await roots.resolve(folderRel)
    : folderRel === ""
    ? roots
    : await resolveInRoot(roots, folderRel);
  return join(dir, name);
}

/** The file's bytes and hash, or null when absent. A symlink or anything but a plain file is refused. */
export async function readFolderCover(path: string): Promise<{ bytes: Uint8Array; sha256: string } | null> {
  let st: Deno.FileInfo;
  try {
    st = await Deno.lstat(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
  if (!st.isFile) throw new FolderCoverError("the cover file is a link or a folder; Tagmonia leaves it alone");
  const bytes = await Deno.readFile(path);
  return { bytes, sha256: await sha256Hex(bytes) };
}

export async function writeFolderCover(path: string, bytes: Uint8Array): Promise<void> {
  const existing = await Deno.lstat(path).catch(() => null);
  if (existing && !existing.isFile) throw new FolderCoverError("the cover file is a link or a folder");
  const tmp = `${path}.tagmonia-tmp-${crypto.randomUUID()}`;
  try {
    {
      using f = await Deno.open(tmp, { write: true, createNew: true, mode: existing?.mode ?? 0o644 });
      let at = 0;
      while (at < bytes.length) at += await f.write(bytes.subarray(at));
      await f.sync();
    }
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
}

export async function removeFolderCover(path: string): Promise<void> {
  const st = await Deno.lstat(path).catch(() => null);
  if (!st) return;
  if (!st.isFile) throw new FolderCoverError("the cover file is a link or a folder");
  await Deno.remove(path);
}
