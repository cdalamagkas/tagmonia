/**
 * Writing and undoing cover art on real files of all five formats (§11.3, D49):
 * the front cover is replaced and other pictures kept, picture bytes are backed
 * up and restored exactly, and cover.jpg is written, put back or removed.
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { coverCachePath, sha256Hex } from "../../server/covers/fetch.ts";
import { type CoverProposal, saveCover, setCoverDecision } from "../../server/db/repo/covers.ts";
import { saveProposal, setProposalState } from "../../server/db/repo/proposals.ts";
import { nullLogger } from "../../server/log.ts";
import { buildFieldProposals } from "../../server/proposal/build.ts";
import { scanLibrary } from "../../server/scanner/scan.ts";
import { createTagIO } from "../../server/tagio/mod.ts";
import type { CanonicalTags } from "../../server/tagio/types.ts";
import { undoBatch, writeProposal } from "../../server/write/apply.ts";
import { memoryDb } from "../helpers/app.ts";
import { AUDIO_DIR, fixturePictures, fixturesPresent } from "../tagio/helpers.ts";
import { fakeJpeg } from "../covers/helpers.ts";

if (!(await fixturesPresent())) throw new Error("Audio fixtures missing: run `scripts/dk scripts/gen_fixtures.sh`.");

const tagio = await createTagIO();
globalThis.addEventListener("unload", () => void tagio.close?.());

const FORMATS = ["flac", "mp3", "m4a", "ogg", "opus"] as const;
const COVER = fakeJpeg(1200, 1200, 7, 4096);

async function setup(opts: { folderImage?: Uint8Array } = {}) {
  const root = await Deno.makeTempDir({ prefix: "tagmonia-covers-write-" });
  const config = await Deno.makeTempDir({ prefix: "tagmonia-covers-config-" });
  await Deno.mkdir(join(root, "Album"));
  // Every fixture starts with a front (PNG) and a back (JPEG) picture.
  const pictures = await fixturePictures();
  for (const [i, ext] of FORMATS.entries()) {
    const path = join(root, "Album", `0${i + 1}.${ext}`);
    await Deno.copyFile(join(AUDIO_DIR, `tagged.${ext}`), path);
    await tagio.write(path, { set: {}, remove: [], pictures });
  }
  if (opts.folderImage) await Deno.writeFile(join(root, "Album", "cover.jpg"), opts.folderImage);
  const db = await memoryDb();
  await scanLibrary({ db, tagio, rootReal: await Deno.realPath(root), ignore: [], logger: nullLogger });
  const files = (db.prepare("SELECT id, path, current_tags FROM library_file ORDER BY path").all() as {
    id: number;
    path: string;
    current_tags: string;
  }[]).map((f) => ({ id: f.id, path: f.path, tags: JSON.parse(f.current_tags) as CanonicalTags }));
  const candidateId = (db.prepare("SELECT id FROM candidate").get() as { id: number }).id;

  // The downloaded cover, as the propose job leaves it in the cache.
  const cacheDir = join(config, "covers");
  await Deno.mkdir(cacheDir);
  const sha = await sha256Hex(COVER);
  await Deno.writeFile(coverCachePath(cacheDir, sha, "image/jpeg"), COVER);
  const image = { sha256: sha, mime: "image/jpeg" as const, width: 1200, height: 1200, size: COVER.length, url: "x" };

  const propose = async (cover: Partial<CoverProposal> = {}) => {
    // Tags proposed exactly as they are: only the cover changes.
    const build = buildFieldProposals({
      candidateId,
      files,
      mapping: files.map((f, i) => ({ fileId: f.id, trackId: `t${i}` })),
      proposed: { release: {}, tracks: new Map(files.map((f, i) => [`t${i}`, { title: f.tags.title }])) },
      snapshotId: null,
      locks: [],
    });
    const hash = (db.prepare("SELECT content_hash FROM candidate").get() as { content_hash: string }).content_hash;
    const id = saveProposal(db, {
      candidateId,
      releaseMbid: "00000000-0000-4000-8000-000000000001",
      chosenBy: "user",
      basedOnHash: hash,
      snapshotIds: [],
      build,
    }, 1);
    const current = opts.folderImage ? await sha256Hex(opts.folderImage) : null;
    saveCover(db, id, {
      mode: "both",
      source: "coverartarchive",
      skipped: [],
      embed: image,
      folder: image,
      embedStatus: "changed",
      folderStatus: current ? "changed" : "added",
      folderPath: "Album/cover.jpg",
      folderCurrent: current,
      ...cover,
    });
    setProposalState(db, id, "approved", 1);
    return id;
  };
  const backupDir = join(config, "backups", "pictures");
  return {
    db,
    files,
    image,
    propose,
    abs: (p: string) => join(root, p),
    deps: {
      db,
      tagio,
      musicDir: root,
      readOnly: false,
      logger: nullLogger,
      covers: { read: (s: string, m: string) => Deno.readFile(coverCachePath(cacheDir, s, m)), backupDir },
    },
    [Symbol.asyncDispose]: async () => {
      db.close();
      await Deno.remove(root, { recursive: true });
      await Deno.remove(config, { recursive: true });
    },
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Each file's pictures as [type, sha] pairs. */
async function picturesOf(s: Setup): Promise<Map<string, [string, string][]>> {
  const out = new Map<string, [string, string][]>();
  for (const f of s.files) {
    const r = await tagio.read(s.abs(f.path), { pictureData: true });
    out.set(
      f.path,
      await Promise.all(r.pictures.map(async (p) => [p.type, await sha256Hex(p.data)] as [string, string])),
    );
  }
  return out;
}

Deno.test("the cover replaces each file's front picture, keeps the back one, and saves cover.jpg; undo restores all", async () => {
  await using s = await setup();
  const before = await picturesOf(s);
  const [front, back] = await Promise.all((await fixturePictures()).map((p) => sha256Hex(p.data)));
  const r = await writeProposal(s.deps, await s.propose());
  assertEquals([r.status, r.written, r.failed], ["done", FORMATS.length + 1, 0]);

  const after = await picturesOf(s);
  for (const f of s.files) {
    const pics = after.get(f.path)!;
    // Order is the format's own (ID3 sorts frames by key), so pictures are compared as a set.
    const sorted = [...pics].sort((x, y) => x[0].localeCompare(y[0]));
    // MP4 covers have no type (D10): the old back cover read as a front one and was replaced with it.
    assertEquals(
      sorted,
      f.path.endsWith(".m4a") ? [["front", s.image.sha256]] : [["back", back], ["front", s.image.sha256]],
      f.path,
    );
    assert(!pics.some(([, sha]) => sha === front), `${f.path}: old front cover gone`);
  }
  assertEquals(await sha256Hex(await Deno.readFile(s.abs("Album/cover.jpg"))), s.image.sha256);
  // The database follows the files, so the next proposal sees the new cover as already there.
  const meta = s.db.prepare("SELECT pictures FROM library_file WHERE path = ?").get(s.files[0].path) as {
    pictures: string;
  };
  assertEquals(JSON.parse(meta.pictures)[0], { type: "front", mime: "image/jpeg", size: COVER.length });

  const u = await undoBatch(s.deps, r.batchId);
  assertEquals([u.status, u.written, u.failed], ["done", FORMATS.length + 1, 0]);
  assertEquals(await picturesOf(s), before, "every picture back, byte for byte");
  assertEquals(await Deno.lstat(s.abs("Album/cover.jpg")).catch(() => null), null, "the cover.jpg it created is gone");
});

Deno.test("an existing cover.jpg is backed up, replaced, and put back by undo", async () => {
  const old = fakeJpeg(500, 500, 1);
  await using s = await setup({ folderImage: old });
  const r = await writeProposal(s.deps, await s.propose({ embed: null, embedStatus: null, mode: "folder" }));
  assertEquals([r.status, r.written], ["done", 1], "folder mode leaves the files alone");
  assertEquals(await sha256Hex(await Deno.readFile(s.abs("Album/cover.jpg"))), s.image.sha256);
  await undoBatch(s.deps, r.batchId);
  assertEquals(await Deno.readFile(s.abs("Album/cover.jpg")), old);
});

Deno.test("a cover.jpg changed since review is not overwritten; undo never removes someone else's cover.jpg", async () => {
  await using s = await setup({ folderImage: fakeJpeg(500, 500, 1) });
  const id = await s.propose({ embed: null, embedStatus: null, mode: "folder" });
  const theirs = fakeJpeg(800, 800, 2);
  await Deno.writeFile(s.abs("Album/cover.jpg"), theirs);
  const r = await writeProposal(s.deps, id);
  assertEquals([r.status, r.skipped], ["failed", 1]);
  assertEquals(await Deno.readFile(s.abs("Album/cover.jpg")), theirs);

  // Written, then replaced by someone else: the undo leaves theirs.
  await using t = await setup();
  const w = await writeProposal(t.deps, await t.propose({ embed: null, embedStatus: null, mode: "folder" }));
  await Deno.writeFile(t.abs("Album/cover.jpg"), theirs);
  const u = await undoBatch(t.deps, w.batchId);
  assertEquals([u.status, u.skipped], ["failed", 1]);
  assertEquals(await Deno.readFile(t.abs("Album/cover.jpg")), theirs);
});

Deno.test("'keep current' writes no cover at all", async () => {
  await using s = await setup();
  const before = await picturesOf(s);
  const id = await s.propose();
  setProposalState(s.db, id, "needs_review", 1);
  setCoverDecision(s.db, id, "kept_current", 2);
  setProposalState(s.db, id, "approved", 3);
  const r = await writeProposal(s.deps, id);
  assertEquals(r.written, 0);
  assertEquals(await picturesOf(s), before);
  assertEquals(await Deno.lstat(s.abs("Album/cover.jpg")).catch(() => null), null);
});
