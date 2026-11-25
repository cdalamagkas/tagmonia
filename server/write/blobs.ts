/**
 * Picture backups (§11.3, D49): image bytes from before a write, stored once per
 * content under /config/backups/pictures and referenced by SHA-256 from
 * file_backup, so a cover shared by every track of an album is kept once.
 */
import { join } from "node:path";
import { sha256Hex } from "../covers/fetch.ts";
import type { Picture } from "../tagio/types.ts";

/** A picture as recorded in a backup: everything but the bytes, which are in the store. */
export interface PictureRef {
  type: Picture["type"];
  mime: string;
  description?: string;
  sha256: string;
}

function blobPath(dir: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("bad blob id");
  return join(dir, `${sha256}.bin`);
}

export async function storeBlob(dir: string, bytes: Uint8Array): Promise<string> {
  const sha = await sha256Hex(bytes);
  const path = blobPath(dir, sha);
  try {
    await Deno.stat(path);
    return sha;
  } catch {
    // not stored yet
  }
  await Deno.mkdir(dir, { recursive: true });
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  {
    using f = await Deno.open(tmp, { write: true, createNew: true, mode: 0o600 });
    let at = 0;
    while (at < bytes.length) at += await f.write(bytes.subarray(at));
    await f.sync();
  }
  await Deno.rename(tmp, path);
  return sha;
}

export function readBlob(dir: string, sha256: string): Promise<Uint8Array> {
  return Deno.readFile(blobPath(dir, sha256));
}

export async function backupPictures(dir: string, pictures: Picture[]): Promise<PictureRef[]> {
  const out: PictureRef[] = [];
  for (const p of pictures) {
    out.push({
      type: p.type,
      mime: p.mime,
      ...(p.description ? { description: p.description } : {}),
      sha256: await storeBlob(dir, p.data),
    });
  }
  return out;
}

export async function restorePictures(dir: string, refs: PictureRef[]): Promise<Picture[]> {
  return await Promise.all(refs.map(async (r) => ({
    type: r.type,
    mime: r.mime,
    ...(r.description ? { description: r.description } : {}),
    data: await readBlob(dir, r.sha256),
  })));
}

/** Pictures as an order-free list of content hashes: what verification and undo compare. */
export async function pictureShas(pictures: Picture[]): Promise<string[]> {
  return (await Promise.all(pictures.map((p) => sha256Hex(p.data)))).sort();
}
