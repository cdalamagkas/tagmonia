/** Image headers: only real JPEG and PNG bytes are accepted, with their dimensions (D49). */
import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { imageInfo } from "../../server/covers/image.ts";
import { AUDIO_DIR, fixturesPresent } from "../tagio/helpers.ts";
import { fakeJpeg, fakePng } from "./helpers.ts";

Deno.test("JPEG and PNG dimensions come from the frame and IHDR headers", () => {
  assertEquals(imageInfo(fakeJpeg(1200, 1199)), { mime: "image/jpeg", width: 1200, height: 1199 });
  assertEquals(imageInfo(fakePng(3000, 3000)), { mime: "image/png", width: 3000, height: 3000 });
});

Deno.test("anything else is refused: HTML error pages, GIF, truncated headers", () => {
  assertEquals(imageInfo(new TextEncoder().encode("<html>not found</html>")), null);
  assertEquals(imageInfo(new TextEncoder().encode("GIF89a......")), null);
  assertEquals(imageInfo(fakeJpeg(10, 10).subarray(0, 24)), null);
  assertEquals(imageInfo(new Uint8Array()), null);
});

Deno.test("the generated audio fixtures' covers parse", async () => {
  if (!(await fixturesPresent())) return;
  assertEquals(imageInfo(await Deno.readFile(join(AUDIO_DIR, "cover-front.png")))?.mime, "image/png");
  assertEquals(imageInfo(await Deno.readFile(join(AUDIO_DIR, "cover-back.jpg")))?.mime, "image/jpeg");
});
