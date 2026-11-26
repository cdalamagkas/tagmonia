/**
 * The cover a release has now (D50), for the library and release pages: the
 * first track's embedded front picture, else a folder image. Small JPEG
 * thumbnails are made with Pillow and cached under /config/thumbs, keyed by the
 * source file's path, size and modification time, so a write or undo (which
 * changes those) shows the new cover and old thumbnails are pruned.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../db/db.ts";
import { Roots } from "../fs/safe_path.ts";
import type { Logger } from "../log.ts";
import type { Picture, TagIO } from "../tagio/types.ts";
import { sha256Hex } from "./fetch.ts";
import { folderCoverPath, readFolderCover } from "./folder.ts";
import { imageInfo } from "./image.ts";

const SCRIPT = fileURLToPath(new URL("./thumbnail.py", import.meta.url));

/** Folder images music servers read, in the order Tagmonia looks for them. */
export const FOLDER_IMAGE_NAMES = ["cover.jpg", "cover.png", "folder.jpg", "folder.png", "front.jpg", "front.png"];

/** Thumbnail edge lengths the API serves: the library list and the release page. */
export const THUMB_SIZES = { thumb: 160, large: 600 } as const;
export type ThumbSize = keyof typeof THUMB_SIZES;

export interface CoverSourceRef {
  kind: "embedded" | "folder";
  /** Relative to the music root. */
  path: string;
  /** Identifies this version of the source: changes whenever the file does. */
  key: string;
}

export interface CurrentCoverInfo {
  kind: "embedded" | "folder";
  path: string;
  mime: string;
  width: number | null;
  height: number | null;
  /** Bytes of the image itself. */
  size: number;
  /** How many of the release's files have an embedded picture. */
  filesWithPicture: number;
  files: number;
}

export interface CurrentCoversOptions {
  db: Db;
  tagio: Pick<TagIO, "read">;
  musicDir: string;
  /** The inbox (D58): its albums' covers are shown too. */
  inboxDir?: string | null;
  cacheDir: string;
  logger: Logger;
  python?: string;
  /** Thumbnails made at once; each is a short Python process. */
  concurrency?: number;
}

interface FileRow {
  path: string;
  size: number;
  mtime_ms: number;
  pictures: string;
}

export class CurrentCovers {
  readonly #o: CurrentCoversOptions;
  #running = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(o: CurrentCoversOptions) {
    this.#o = o;
  }

  #files(candidateId: number): FileRow[] {
    return this.#o.db.prepare(
      `SELECT path, size, mtime_ms, pictures FROM library_file WHERE candidate_id = ? AND read_error IS NULL
       ORDER BY coalesce(json_extract(current_tags, '$.discnumber'), 1), json_extract(current_tags, '$.tracknumber'), path`,
    ).all(candidateId) as unknown as FileRow[];
  }

  /** Where the release's cover is, without reading any image: database rows and a few stats. */
  async source(candidateId: number): Promise<CoverSourceRef | null> {
    const files = this.#files(candidateId);
    const pics = (f: FileRow) => JSON.parse(f.pictures) as { type: string }[];
    const embedded = files.find((f) => pics(f).some((p) => p.type === "front")) ?? files.find((f) => pics(f).length);
    if (embedded) {
      return {
        kind: "embedded",
        path: embedded.path,
        key: await versionKey(embedded.path, embedded.size, embedded.mtime_ms),
      };
    }
    const row = this.#o.db.prepare("SELECT folder FROM candidate WHERE id = ?").get(candidateId) as
      | { folder: string }
      | undefined;
    if (!row) return null;
    const root = await Roots.open(this.#o.musicDir, this.#o.inboxDir);
    for (const name of FOLDER_IMAGE_NAMES) {
      try {
        const abs = await folderCoverPath(root, row.folder, name);
        const st = await Deno.lstat(abs);
        if (!st.isFile) continue; // a link or a folder: never followed
        const path = row.folder === "" ? name : `${row.folder}/${name}`;
        return { kind: "folder", path, key: await versionKey(path, st.size, st.mtime?.getTime() ?? 0) };
      } catch {
        // not there, or not inside the music root
      }
    }
    return null;
  }

  /** The source image's bytes and type. */
  async #read(src: CoverSourceRef): Promise<{ bytes: Uint8Array; mime: string } | null> {
    const root = await Roots.open(this.#o.musicDir, this.#o.inboxDir);
    if (src.kind === "folder") {
      const dir = src.path.includes("/") ? src.path.slice(0, src.path.lastIndexOf("/")) : "";
      const abs = await folderCoverPath(root, dir, src.path.slice(src.path.lastIndexOf("/") + 1));
      const f = await readFolderCover(abs);
      if (!f) return null;
      return { bytes: f.bytes, mime: imageInfo(f.bytes)?.mime ?? "application/octet-stream" };
    }
    const abs = await root.resolve(src.path);
    const { pictures } = await this.#o.tagio.read(abs, { pictureData: true });
    const p: Picture | undefined = pictures.find((x) => x.type === "front") ?? pictures[0];
    return p ? { bytes: p.data, mime: p.mime } : null;
  }

  #cachePaths(src: CoverSourceRef, size?: number) {
    const prefix = src.key.slice(0, 16);
    const base = join(this.#o.cacheDir, `${prefix}-${src.key.slice(16, 40)}`);
    return { prefix, info: `${base}.json`, thumb: size ? `${base}-${size}.jpg` : "" };
  }

  /** Older thumbnails of the same source file, made before it changed. */
  async #prune(prefix: string, keep: string) {
    try {
      for await (const e of Deno.readDir(this.#o.cacheDir)) {
        if (e.name.startsWith(`${prefix}-`) && !e.name.startsWith(keep)) {
          await Deno.remove(join(this.#o.cacheDir, e.name)).catch(() => {});
        }
      }
    } catch {
      // no cache yet
    }
  }

  async info(candidateId: number): Promise<CurrentCoverInfo | null> {
    const src = await this.source(candidateId);
    if (!src) return null;
    const files = this.#files(candidateId);
    const counts = {
      filesWithPicture: files.filter((f) => JSON.parse(f.pictures).length > 0).length,
      files: files.length,
    };
    const paths = this.#cachePaths(src);
    try {
      return { ...JSON.parse(await Deno.readTextFile(paths.info)), ...counts };
    } catch {
      // not described yet
    }
    const img = await this.#read(src);
    if (!img) return null;
    const dims = imageInfo(img.bytes);
    const info = {
      kind: src.kind,
      path: src.path,
      mime: img.mime,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      size: img.bytes.length,
    };
    await this.#store(paths.info, new TextEncoder().encode(JSON.stringify(info)), paths.prefix, src);
    return { ...info, ...counts };
  }

  async #store(path: string, bytes: Uint8Array, prefix: string, src: CoverSourceRef) {
    await Deno.mkdir(this.#o.cacheDir, { recursive: true });
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    await Deno.writeFile(tmp, bytes);
    await Deno.rename(tmp, path);
    await this.#prune(prefix, `${prefix}-${src.key.slice(16, 40)}`);
  }

  /** A JPEG of at most `size` px a side, with an ETag that changes with the source; null when there is no cover. */
  async thumbnail(
    candidateId: number,
    size: ThumbSize,
  ): Promise<{ bytes: Uint8Array; mime: string; etag: string } | null> {
    const src = await this.source(candidateId);
    if (!src) return null;
    const px = THUMB_SIZES[size];
    const paths = this.#cachePaths(src, px);
    const etag = `"${src.key.slice(0, 32)}-${px}"`;
    try {
      return { bytes: await Deno.readFile(paths.thumb), mime: "image/jpeg", etag };
    } catch {
      // not made yet
    }
    return await this.#limited(async () => {
      const img = await this.#read(src);
      if (!img) return null;
      const thumb = await this.#resize(img.bytes, px);
      if (thumb) {
        await this.#store(paths.thumb, thumb, paths.prefix, src);
        return { bytes: thumb, mime: "image/jpeg", etag };
      }
      // No Pillow, or an image it cannot read: a JPEG or PNG is still shown as it is.
      const known = imageInfo(img.bytes);
      return known ? { bytes: img.bytes, mime: known.mime, etag } : null;
    });
  }

  async #resize(bytes: Uint8Array, px: number): Promise<Uint8Array | null> {
    try {
      const child = new Deno.Command(this.#o.python ?? "python3", {
        args: ["-I", SCRIPT, String(px)],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const w = child.stdin.getWriter();
      await w.write(bytes);
      await w.close();
      const out = await child.output();
      if (out.code === 0 && out.stdout.length > 0) return out.stdout;
      if (out.code !== 2) {
        this.#o.logger.warn("cover thumbnail failed", { error: new TextDecoder().decode(out.stderr).slice(-300) });
      }
    } catch (e) {
      this.#o.logger.warn("cover thumbnail failed", { error: (e as Error).message });
    }
    return null;
  }

  async #limited<T>(fn: () => Promise<T>): Promise<T> {
    const max = this.#o.concurrency ?? 2;
    if (this.#running >= max) await new Promise<void>((r) => this.#waiting.push(r));
    this.#running++;
    try {
      return await fn();
    } finally {
      this.#running--;
      this.#waiting.shift()?.();
    }
  }
}

async function versionKey(path: string, size: number, mtimeMs: number): Promise<string> {
  // The first 16 hex digits name the source file (for pruning); the rest its version.
  const file = (await sha256Hex(new TextEncoder().encode(path))).slice(0, 16);
  const version = await sha256Hex(new TextEncoder().encode(`${path}\0${size}\0${Math.round(mtimeMs)}`));
  return file + version;
}
