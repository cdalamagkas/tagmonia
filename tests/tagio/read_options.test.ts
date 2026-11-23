import { assertEquals } from "@std/assert";
import { copyFixture, fixturePictures, fixturesPresent, FORMATS, newTagIO } from "./helpers.ts";

const present = await fixturesPresent();

Deno.test({
  name: "read with pictureData:false returns picture metadata without bytes",
  ignore: !present,
  async fn() {
    const tagio = await newTagIO();
    const pictures = await fixturePictures();
    try {
      for (const format of FORMATS) {
        const { path, dir } = await copyFixture(`tagged.${format}`);
        try {
          await tagio.write(path, { set: {}, remove: [], pictures: [pictures[0]] });
          const full = await tagio.read(path);
          const light = await tagio.read(path, { pictureData: false });
          assertEquals(light.pictures.length, 1, format);
          assertEquals(light.pictures[0].data.length, 0, format);
          assertEquals(light.pictures[0].size, pictures[0].data.length, format);
          assertEquals(light.pictures[0].mime, full.pictures[0].mime, format);
          assertEquals(light.tags, full.tags, format);
          // The option is per request: the next default read has the bytes again.
          assertEquals((await tagio.read(path)).pictures[0].data.length, pictures[0].data.length, format);
        } finally {
          await Deno.remove(dir, { recursive: true });
        }
      }
    } finally {
      await tagio.close?.();
    }
  },
});
