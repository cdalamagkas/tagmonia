/** The cover a release has now, and its cached thumbnails (D50), on real files. */
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { join } from "node:path";
import { CurrentCovers } from "../../server/covers/current.ts";
import { imageInfo } from "../../server/covers/image.ts";
import { nullLogger } from "../../server/log.ts";
import { scanLibrary } from "../../server/scanner/scan.ts";
import { createTagIO } from "../../server/tagio/mod.ts";
import { memoryDb } from "../helpers/app.ts";
import { AUDIO_DIR, fixturePictures, fixturesPresent } from "../tagio/helpers.ts";

if (!(await fixturesPresent())) throw new Error("Audio fixtures missing: run `scripts/dk scripts/gen_fixtures.sh`.");
const tagio = await createTagIO();
globalThis.addEventListener("unload", () => void tagio.close?.());

/** Three releases: Embedded (front + back pictures), Folder (cover.jpg only), None. */
async function setup(opts: { python?: string } = {}) {
  const root = await Deno.makeTempDir({ prefix: "tagmonia-current-" });
  const config = await Deno.makeTempDir({ prefix: "tagmonia-current-config-" });
  const pictures = await fixturePictures();
  for (const dir of ["Embedded", "Folder", "None"]) {
    await Deno.mkdir(join(root, dir));
    const path = join(root, dir, "01.flac");
    await Deno.copyFile(join(AUDIO_DIR, "blank.flac"), path);
    await tagio.write(path, {
      set: { album: dir, title: "One", tracknumber: 1 },
      remove: [],
      pictures: dir === "Embedded" ? pictures : [],
    });
  }
  await Deno.copyFile(join(AUDIO_DIR, "cover-back.jpg"), join(root, "Folder", "cover.jpg"));
  const db = await memoryDb();
  const rootReal = await Deno.realPath(root);
  const scan = () => scanLibrary({ db, tagio, rootReal, ignore: [], logger: nullLogger });
  await scan();
  const id = (folder: string) =>
    (db.prepare("SELECT id FROM candidate WHERE folder = ?").get(folder) as { id: number }).id;
  const cacheDir = join(config, "thumbs");
  const covers = new CurrentCovers({ db, tagio, musicDir: root, cacheDir, logger: nullLogger, python: opts.python });
  return {
    root,
    db,
    scan,
    id,
    covers,
    cacheDir,
    [Symbol.asyncDispose]: async () => {
      db.close();
      await Deno.remove(root, { recursive: true });
      await Deno.remove(config, { recursive: true });
    },
  };
}

Deno.test("the source: the embedded front picture, else a folder image, else none", async () => {
  await using s = await setup();
  assertEquals((await s.covers.source(s.id("Embedded")))?.kind, "embedded");
  assertEquals((await s.covers.source(s.id("Folder")))?.path, "Folder/cover.jpg");
  assertEquals(await s.covers.source(s.id("None")), null);
  assertEquals(await s.covers.thumbnail(s.id("None"), "thumb"), null);
});

Deno.test("thumbnails are small JPEGs, cached, and described with the original's size", async () => {
  await using s = await setup();
  const t = (await s.covers.thumbnail(s.id("Embedded"), "thumb"))!;
  const info = imageInfo(t.bytes)!;
  assertEquals(info.mime, "image/jpeg");
  assert(info.width <= 160 && info.height <= 160, `${info.width}x${info.height}`);
  const again = (await s.covers.thumbnail(s.id("Embedded"), "thumb"))!;
  assertEquals([again.bytes, again.etag], [t.bytes, t.etag]);

  const front = (await fixturePictures())[0];
  const original = imageInfo(front.data)!;
  const d = (await s.covers.info(s.id("Embedded")))!;
  assertEquals([d.kind, d.mime, d.width, d.height, d.size], [
    "embedded",
    "image/png",
    original.width,
    original.height,
    front.data.length,
  ]);
  assertEquals([d.filesWithPicture, d.files], [1, 1]);
  assertEquals((await s.covers.info(s.id("Folder")))?.kind, "folder");
});

Deno.test("a changed file gives a new thumbnail and the old one is pruned", async () => {
  await using s = await setup();
  const before = (await s.covers.thumbnail(s.id("Embedded"), "thumb"))!;
  const pictures = await fixturePictures();
  // The back picture becomes the front one, as a cover write would do.
  await tagio.write(join(s.root, "Embedded", "01.flac"), {
    set: {},
    remove: [],
    pictures: [{ ...pictures[1], type: "front" }],
  });
  await s.scan();
  const after = (await s.covers.thumbnail(s.id("Embedded"), "thumb"))!;
  assertNotEquals(after.etag, before.etag);
  assertNotEquals(after.bytes, before.bytes);
  const files = [...Deno.readDirSync(s.cacheDir)].map((e) => e.name).filter((n) => n.endsWith("-160.jpg"));
  assertEquals(files.length, 1, "only the current thumbnail of that file is kept");
});

Deno.test("a symlinked folder image is never followed", async () => {
  await using s = await setup();
  await Deno.remove(join(s.root, "Folder", "cover.jpg"));
  await Deno.symlink(join(AUDIO_DIR, "cover-back.jpg"), join(s.root, "Folder", "cover.jpg"));
  assertEquals(await s.covers.source(s.id("Folder")), null);
});

Deno.test("without Pillow, a JPEG or PNG cover is served as it is", async () => {
  await using s = await setup({ python: "/nonexistent/python3" });
  const t = (await s.covers.thumbnail(s.id("Folder"), "thumb"))!;
  assertEquals(t.bytes, await Deno.readFile(join(AUDIO_DIR, "cover-back.jpg")));
  assertEquals(t.mime, "image/jpeg");
});
