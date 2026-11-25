/** GET /api/library/releases/:id/cover and …/cover/info (D50). */
import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { imageInfo } from "../../server/covers/image.ts";
import { nullLogger } from "../../server/log.ts";
import { scanLibrary } from "../../server/scanner/scan.ts";
import { createTagIO } from "../../server/tagio/mod.ts";
import type { CurrentCoverDto } from "../../shared/types.ts";
import { makeTestApp, signIn } from "../helpers/app.ts";
import { AUDIO_DIR, fixturePictures, fixturesPresent } from "../tagio/helpers.ts";

if (!(await fixturesPresent())) throw new Error("Audio fixtures missing: run `scripts/dk scripts/gen_fixtures.sh`.");
const tagio = await createTagIO();
globalThis.addEventListener("unload", () => void tagio.close?.());

Deno.test("covers: a revalidated thumbnail in two sizes, its description, 404 without one", async () => {
  const t = await makeTestApp({ tagio });
  try {
    const { cookie } = await signIn(t);
    for (const dir of ["A", "B"]) {
      await Deno.mkdir(join(t.ctx.config.musicDir, dir));
      const path = join(t.ctx.config.musicDir, dir, "01.flac");
      await Deno.copyFile(join(AUDIO_DIR, "blank.flac"), path);
      await tagio.write(path, {
        set: { album: dir },
        remove: [],
        pictures: dir === "A" ? await fixturePictures() : [],
      });
    }
    await scanLibrary({
      db: t.db,
      tagio,
      rootReal: await Deno.realPath(t.ctx.config.musicDir),
      ignore: [],
      logger: nullLogger,
    });
    const id = (f: string) => (t.db.prepare("SELECT id FROM candidate WHERE folder = ?").get(f) as { id: number }).id;
    const url = `/api/library/releases/${id("A")}/cover`;

    const res = await t.request(url, { cookie });
    assertEquals([res.status, res.headers.get("content-type")], [200, "image/jpeg"]);
    const small = imageInfo(new Uint8Array(await res.arrayBuffer()))!;
    const etag = res.headers.get("etag")!;
    assertEquals((await t.request(url, { cookie, headers: { "If-None-Match": etag } })).status, 304);
    const large = await t.request(`${url}?size=large`, { cookie });
    const big = imageInfo(new Uint8Array(await large.arrayBuffer()))!;
    assertEquals(big.width >= small.width && small.width <= 160 && big.width <= 600, true);
    assertEquals((await t.request(`${url}?size=huge`, { cookie })).status, 400);
    assertEquals((await t.request(`/api/library/releases/${id("B")}/cover`, { cookie })).status, 404);
    assertEquals((await t.request(url)).status, 401, "signed in only");

    const info = (await (await t.request(`${url}/info`, { cookie })).json()) as { cover: CurrentCoverDto };
    assertEquals([info.cover.kind, info.cover.mime, info.cover.filesWithPicture], ["embedded", "image/png", 1]);
    const none = await (await t.request(`/api/library/releases/${id("B")}/cover/info`, { cookie })).json();
    assertEquals(none, { cover: null });
  } finally {
    await t.cleanup();
  }
});
