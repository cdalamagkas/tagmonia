import { assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import { atomicModify, isTagmoniaTempFile } from "../../server/tagio/atomic.ts";

async function setup(): Promise<{ dir: string; path: string }> {
  const dir = await Deno.makeTempDir({ prefix: "tagmonia-atomic-" });
  const path = join(dir, "song.flac");
  await Deno.writeTextFile(path, "original");
  return { dir, path };
}

async function names(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) out.push(e.name);
  return out.sort();
}

Deno.test("atomicModify replaces the file only after the edit succeeds", async () => {
  const { dir, path } = await setup();
  await atomicModify(path, async (tmp) => {
    assertEquals(await Deno.readTextFile(tmp), "original");
    assertEquals(await Deno.readTextFile(path), "original");
    await Deno.writeTextFile(tmp, "new");
  });
  assertEquals(await Deno.readTextFile(path), "new");
  assertEquals(await names(dir), ["song.flac"]);
});

Deno.test("atomicModify: a failing edit after partial writes leaves the original and no temp file", async () => {
  const { dir, path } = await setup();
  await assertRejects(() =>
    atomicModify(path, async (tmp) => {
      await Deno.writeTextFile(tmp, "half-writ");
      throw new Error("simulated crash");
    })
  );
  assertEquals(await Deno.readTextFile(path), "original");
  assertEquals(await names(dir), ["song.flac"]);
});

Deno.test("atomicModify preserves the file mode", async () => {
  const { path } = await setup();
  await Deno.chmod(path, 0o604);
  await atomicModify(path, (tmp) => Deno.writeTextFile(tmp, "x"));
  assertEquals((await Deno.stat(path)).mode! & 0o777, 0o604);
});

Deno.test("temp files are hidden and recognisable so the scanner can skip them", async () => {
  const { dir, path } = await setup();
  let seen = "";
  await atomicModify(path, (tmp) => {
    seen = tmp.slice(dir.length + 1);
    return Promise.resolve();
  });
  assertEquals(isTagmoniaTempFile(seen), true);
  assertEquals(isTagmoniaTempFile("song.flac"), false);
});
