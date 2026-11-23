/**
 * End-to-end scan over a library built from generated fixtures in a temp dir
 * (CLAUDE.md safety rule 1): HTTP -> job queue -> scanner -> TagIO -> SQLite -> HTTP.
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { registerScanJob, SCAN_JOB } from "../../server/jobs/scan.ts";
import { nullLogger } from "../../server/log.ts";
import { type CanonicalTags, createTagIO, type TagIO } from "../../server/tagio/mod.ts";
import type { ReleaseDetail, ReleaseList, ScanJobDto, ScanResultDto } from "../../shared/types.ts";
import { makeTestApp, signIn, type TestApp } from "../helpers/app.ts";
import { AUDIO_DIR, fixturePictures, fixturesPresent } from "../tagio/helpers.ts";

const present = await fixturesPresent();

interface Spec {
  path: string;
  tags?: CanonicalTags;
  cover?: boolean;
  garbage?: boolean;
}

const LIBRARY: Spec[] = [
  {
    path: "Artist A/Album One/01.flac",
    tags: { album: "Album One", albumartist: "Artist A", title: "First", tracknumber: 1 },
  },
  {
    path: "Artist A/Album One/02.flac",
    tags: { album: "Album One", albumartist: "Artist A", title: "Second", tracknumber: 2 },
  },
  {
    path: "Artist B/Double/CD1/01.mp3",
    tags: { album: "Double", albumartist: "Artist B", discnumber: 1, tracknumber: 1 },
  },
  {
    path: "Artist B/Double/CD2/01.mp3",
    tags: { album: "Double", albumartist: "Artist B", discnumber: 2, tracknumber: 1 },
  },
  { path: "Various/Hits/01.opus", tags: { album: "Hits", albumartist: "Various Artists", artist: "X" } },
  { path: "Various/Hits/02.opus", tags: { album: "Hits", albumartist: "Various Artists", artist: "Y" } },
  { path: "Mixed/a.m4a", tags: { album: "P", albumartist: "Pa" } },
  { path: "Mixed/b.m4a", tags: { album: "Q", albumartist: "Qa" } },
  { path: "Loose/x.ogg", tags: { title: "Untitled" } },
  { path: "Covered/01.flac", tags: { album: "Covered", albumartist: "C" }, cover: true },
  { path: "Broken/bad.mp3", garbage: true },
];

async function buildLibrary(root: string, tagio: TagIO): Promise<void> {
  const [front] = await fixturePictures();
  for (const s of LIBRARY) {
    const abs = join(root, s.path);
    await Deno.mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    if (s.garbage) {
      await Deno.writeTextFile(abs, "this is not audio");
      continue;
    }
    await Deno.copyFile(join(AUDIO_DIR, `blank.${s.path.split(".").pop()}`), abs);
    await tagio.write(abs, { set: s.tags ?? {}, remove: [], pictures: s.cover ? [front] : undefined });
  }
}

/** Every file's bytes and mtime, to prove a scan never writes to the library. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string) => {
    for await (const e of Deno.readDir(dir)) {
      const p = join(dir, e.name);
      if (e.isDirectory) await walk(p);
      else if (e.isFile) {
        const st = await Deno.stat(p);
        const sha = new Uint8Array(await crypto.subtle.digest("SHA-256", await Deno.readFile(p)));
        out.set(p, `${st.mtime?.getTime()}:${Array.from(sha).join(",")}`);
      }
    }
  };
  await walk(root);
  return out;
}

async function scan(t: TestApp, auth: { cookie: string; csrf: string }): Promise<ScanResultDto> {
  const res = await t.request("/api/library/scan", { method: "POST", ...auth });
  assertEquals(res.status, 202);
  const job: ScanJobDto = await res.json();
  await t.queue.drain();
  const done: ScanJobDto = await (await t.request(`/api/jobs/${job.id}`, auth)).json();
  assertEquals(done.state, "done", done.error ?? "");
  return done.result!;
}

async function releases(t: TestApp, auth: { cookie: string }, q = ""): Promise<ReleaseList> {
  return await (await t.request(`/api/library/releases?limit=200${q ? `&q=${encodeURIComponent(q)}` : ""}`, auth))
    .json();
}

Deno.test({
  name: "scan groups the library, serves it read-only over the API, and rescans incrementally",
  ignore: !present,
  sanitizeResources: false,
  async fn() {
    const t = await makeTestApp();
    const tagio = await createTagIO();
    try {
      await buildLibrary(t.musicDir, tagio);
      registerScanJob(t.queue, { db: t.db, tagio, musicDir: t.musicDir, ignore: () => [], logger: nullLogger });
      const auth = await signIn(t);
      const before = await snapshot(t.musicDir);

      // ---- first scan
      const r1 = await scan(t, auth);
      assertEquals([r1.seen, r1.added, r1.unchanged, r1.unreadable], [LIBRARY.length, LIBRARY.length, 0, 1]);
      assertEquals(await snapshot(t.musicDir), before, "scanning must not modify any file");

      const list = await releases(t, auth);
      const byAlbum = new Map(list.items.map((r) => [r.album ?? `loose:${r.folder}`, r]));
      assertEquals(
        [...byAlbum.keys()].sort(),
        ["Album One", "Covered", "Double", "Hits", "P", "Q", "loose:Broken", "loose:Loose"].sort(),
      );
      assertEquals(byAlbum.get("Double")!.trackCount, 2, "CD1 + CD2 merged");
      assertEquals(byAlbum.get("Double")!.folder, "Artist B/Double");
      assertEquals(byAlbum.get("Hits")!.artist, "Various Artists", "compilation stays one release");
      assertEquals(byAlbum.get("Covered")!.hasCover, true);
      assertEquals(byAlbum.get("Album One")!.hasCover, false);
      assertEquals(byAlbum.get("loose:Broken")!.errorCount, 1);
      assertEquals(byAlbum.get("P")!.formats, ["m4a"]);

      // ---- detail: current tags in track order, paths relative
      const detail: ReleaseDetail =
        await (await t.request(`/api/library/releases/${byAlbum.get("Album One")!.id}`, auth))
          .json();
      assertEquals(detail.files.map((f) => [f.path, f.tags.title]), [
        ["Artist A/Album One/01.flac", "First"],
        ["Artist A/Album One/02.flac", "Second"],
      ]);
      assert(detail.files.every((f) => f.format === "flac" && f.durationMs! > 1000 && f.readError === null));
      const broken: ReleaseDetail =
        await (await t.request(`/api/library/releases/${byAlbum.get("loose:Broken")!.id}`, auth))
          .json();
      assertEquals(broken.files[0].readError, "not a valid mp3 file");
      assert(!JSON.stringify(broken).includes(t.musicDir), "absolute paths never reach the API");

      // ---- search
      assertEquals((await releases(t, auth, "artist b")).items.map((r) => r.album), ["Double"]);
      assertEquals((await releases(t, auth, "100%_")).total, 0, "LIKE wildcards are escaped");

      // ---- unchanged rescan reads nothing and touches nothing
      const r2 = await scan(t, auth);
      assertEquals([r2.added, r2.updated, r2.removed, r2.unchanged, r2.candidatesTouched], [
        0,
        0,
        0,
        LIBRARY.length,
        [],
      ]);

      // ---- a retagged file is re-read; its release keeps its id and is flagged changed once reviewed
      const albumOne = byAlbum.get("Album One")!;
      t.db.prepare("UPDATE candidate SET status = 'identified' WHERE id = ?").run(albumOne.id);
      await tagio.write(join(t.musicDir, "Artist A/Album One/02.flac"), {
        set: { title: "Second (edit)" },
        remove: [],
      });
      const r3 = await scan(t, auth);
      assertEquals([r3.updated, r3.candidatesTouched], [1, [albumOne.id]]);
      const after = (await releases(t, auth)).items.find((r) => r.id === albumOne.id)!;
      assertEquals(after.status, "changed");

      // ---- deletions and moves
      await Deno.remove(join(t.musicDir, "Mixed/b.m4a"));
      await Deno.rename(join(t.musicDir, "Loose"), join(t.musicDir, "Loose2"));
      const r4 = await scan(t, auth);
      assertEquals([r4.removed, r4.added], [2, 1]);
      const names = (await releases(t, auth)).items.map((r) => r.album ?? `loose:${r.folder}`).sort();
      assert(!names.includes("Q") && !names.includes("loose:Loose") && names.includes("loose:Loose2"), names.join());

      // ---- summary
      const summary = await (await t.request("/api/library/summary", auth)).json();
      assertEquals([summary.files, summary.unreadable, summary.scan.kind], [LIBRARY.length - 1, 1, SCAN_JOB]);
    } finally {
      await tagio.close?.();
      await t.cleanup();
    }
  },
});
