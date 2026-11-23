import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { assertSafeRelative, PathEscapeError, resolveInRoot, toRelative } from "../../server/fs/safe_path.ts";

Deno.test("relative paths with .., absolute paths or NUL are rejected lexically", () => {
  for (const bad of ["../x", "a/../../x", "/etc/passwd", "a\0b", "C:\\x", "a\\..\\..\\x"]) {
    assertThrows(() => assertSafeRelative(bad), PathEscapeError, undefined, bad);
  }
  assertSafeRelative("Artist/Album (2020)/01 - ..Intro.flac");
});

Deno.test("resolveInRoot follows symlinks and refuses targets outside the root (§14.4)", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "tagmony-root-" }));
  const outside = await Deno.realPath(await Deno.makeTempDir({ prefix: "tagmony-outside-" }));
  try {
    await Deno.mkdir(`${root}/A`);
    await Deno.writeTextFile(`${root}/A/in.txt`, "x");
    await Deno.writeTextFile(`${outside}/secret.txt`, "x");
    await Deno.symlink(`${outside}/secret.txt`, `${root}/A/link-out.txt`);
    await Deno.symlink(`${root}/A/in.txt`, `${root}/A/link-in.txt`);
    assertEquals(await resolveInRoot(root, "A/in.txt"), `${root}/A/in.txt`);
    assertEquals(await resolveInRoot(root, "A/link-in.txt"), `${root}/A/in.txt`);
    await assertRejects(() => resolveInRoot(root, "A/link-out.txt"), PathEscapeError);
    await assertRejects(() => resolveInRoot(root, "../" + outside.split("/").pop() + "/secret.txt"), PathEscapeError);
    assertEquals(toRelative(root, `${root}/A/in.txt`), "A/in.txt");
    assertThrows(() => toRelative(root, `${outside}/secret.txt`), PathEscapeError);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});
