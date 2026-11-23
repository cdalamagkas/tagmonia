import { assertEquals } from "@std/assert";
import { compileIgnore, walkLibrary, type WalkStats } from "../../server/scanner/walk.ts";

async function tree(files: string[]): Promise<string> {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "tagmonia-walk-" }));
  for (const f of files) {
    const dir = f.slice(0, f.lastIndexOf("/"));
    if (dir) await Deno.mkdir(`${root}/${dir}`, { recursive: true });
    await Deno.writeTextFile(`${root}/${f}`, "x");
  }
  return root;
}

Deno.test("walk finds audio by extension and skips hidden, NAS, temp and ignored entries", async () => {
  const root = await tree([
    "A/Album/01.flac",
    "A/Album/02.MP3",
    "A/Album/cover.jpg",
    "A/Album/notes.txt",
    "A/Album/.hidden.flac",
    "A/Album/.01.flac.tagmonia-tmp-1234",
    ".Trash/x.flac",
    "@eaDir/A/thumb.flac",
    "#recycle/old.mp3",
    "Podcasts/ep1.mp3",
    "B/_Incoming/new.opus",
    "B/Keep/x.m4a",
    "B/Keep/y.oga",
  ]);
  const outside = await Deno.makeTempDir({ prefix: "tagmonia-outside-" });
  await Deno.writeTextFile(`${outside}/evil.flac`, "x");
  await Deno.symlink(`${outside}/evil.flac`, `${root}/A/Album/03.flac`);
  await Deno.symlink(outside, `${root}/Linked`);
  try {
    const stats: WalkStats = { files: 0, skippedSymlinks: 0, ignored: 0, unreadableDirs: 0 };
    const found = [];
    for await (const e of walkLibrary(root, { ignore: compileIgnore(["Podcasts/**", "**/_Incoming"]), stats })) {
      found.push([e.rel, e.format]);
    }
    assertEquals(found, [
      ["A/Album/01.flac", "flac"],
      ["A/Album/02.MP3", "mp3"],
      ["B/Keep/x.m4a", "m4a"],
      ["B/Keep/y.oga", "ogg"],
    ]);
    assertEquals(stats.skippedSymlinks, 2);
    assertEquals(stats.ignored, 2);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("walk stops when aborted", async () => {
  const root = await tree(["A/1.flac", "B/1.flac"]);
  try {
    const ac = new AbortController();
    ac.abort();
    let threw = false;
    try {
      for await (const _ of walkLibrary(root, { signal: ac.signal })) { /* nothing */ }
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
