/**
 * Atomic in-place file modification (ARCHITECTURE.md §11.1, CLAUDE.md safety rule 2).
 *
 * The original is copied to a hidden temp file in the same directory (same
 * filesystem, so rename is atomic), the copy is edited, fsynced, given the
 * original's mode and ownership, then renamed over the original. A crash at any
 * point leaves either the untouched original or the fully written new file.
 */
import { basename, dirname, join } from "node:path";

/** Suffix the scanner must ignore (server/scanner). */
export const TEMP_MARKER = ".tagmony-tmp";

export function isTagmonyTempFile(name: string): boolean {
  return name.startsWith(".") && name.includes(TEMP_MARKER);
}

function tempPathFor(path: string): string {
  const rand = crypto.getRandomValues(new Uint32Array(2)).join("");
  return join(dirname(path), `.${basename(path)}${TEMP_MARKER}-${rand}`);
}

export async function atomicModify(
  path: string,
  edit: (tempPath: string) => Promise<void>,
): Promise<void> {
  const st = await Deno.stat(path);
  if (!st.isFile) throw new Error(`not a regular file: ${path}`);
  const tmp = tempPathFor(path);
  try {
    await Deno.copyFile(path, tmp);
    await edit(tmp);
    {
      using f = await Deno.open(tmp, { read: true, write: true });
      await f.sync();
    }
    if (st.mode !== null) await Deno.chmod(tmp, st.mode & 0o7777);
    if (st.uid !== null && st.gid !== null) {
      try {
        await Deno.chown(tmp, st.uid, st.gid);
      } catch (e) {
        // Non-root containers cannot chown to another user; the copy is ours, which is the best possible.
        if (!(e instanceof Deno.errors.PermissionDenied || e instanceof Deno.errors.NotCapable)) throw e;
      }
    }
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
  await syncDir(dirname(path));
}

async function syncDir(dir: string): Promise<void> {
  // Makes the rename durable. Not supported everywhere (e.g. some network FS); best effort.
  try {
    using d = await Deno.open(dir, { read: true });
    await d.sync();
  } catch {
    // ignore
  }
}
