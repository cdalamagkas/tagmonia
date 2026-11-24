import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "node:path";
import { loadConfig, resolveAcoustidKey } from "../server/config.ts";

const SECRET = "s3cret-acoustid-key";

Deno.test("the AcoustID key comes from the environment or a secret file, and is optional", async () => {
  assertEquals(await resolveAcoustidKey(loadConfig({})), undefined);
  assertEquals(await resolveAcoustidKey(loadConfig({ TAGMONIA_ACOUSTID_KEY: SECRET })), SECRET);

  const dir = await Deno.makeTempDir({ prefix: "tagmonia-cfg-" });
  try {
    const file = join(dir, "acoustid");
    await Deno.writeTextFile(file, `${SECRET}\n`);
    assertEquals(await resolveAcoustidKey(loadConfig({ TAGMONIA_ACOUSTID_KEY_FILE: file })), SECRET);
    await Deno.writeTextFile(file, "  \n");
    await assertRejects(() => resolveAcoustidKey(loadConfig({ TAGMONIA_ACOUSTID_KEY_FILE: file })), Error, "empty");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("setting both AcoustID key variables is a startup error that does not echo the key", () => {
  const e = assertThrows(() =>
    loadConfig({ TAGMONIA_ACOUSTID_KEY: SECRET, TAGMONIA_ACOUSTID_KEY_FILE: "/run/secrets/acoustid" })
  );
  assertEquals((e as Error).message.includes(SECRET), false);
});

Deno.test("an unreadable key file names the path, never contents", async () => {
  await assertRejects(
    () => resolveAcoustidKey(loadConfig({ TAGMONIA_ACOUSTID_KEY_FILE: "/nonexistent/acoustid" })),
    Error,
    "/nonexistent/acoustid",
  );
});
