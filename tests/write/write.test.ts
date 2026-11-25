/**
 * The write procedure and undo (§11.3) on real audio: generated fixtures copied
 * into a temp music root (CLAUDE.md safety rule 1), the production TagIO and
 * the real scanner.
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import { latestProposal, saveProposal, setProposalState } from "../../server/db/repo/proposals.ts";
import { nullLogger } from "../../server/log.ts";
import { buildFieldProposals, type FieldLock } from "../../server/proposal/build.ts";
import { candidateContentHash, scanLibrary } from "../../server/scanner/scan.ts";
import { createTagIO, type TagIO } from "../../server/tagio/mod.ts";
import type { CanonicalTags } from "../../server/tagio/types.ts";
import { ReadOnlyError, undoBatch, writeProposal } from "../../server/write/apply.ts";
import { memoryDb } from "../helpers/app.ts";
import { AUDIO_DIR, fixturesPresent, sha256 } from "../tagio/helpers.ts";

if (!(await fixturesPresent())) throw new Error("Audio fixtures missing: run `scripts/dk scripts/gen_fixtures.sh`.");

const tagio = await createTagIO();
// Close the sidecar once every test in this module has run.
globalThis.addEventListener("unload", () => void tagio.close?.());

/** A mixed-format album: three tagged fixtures in one folder of a temp music root. */
async function setup() {
  const root = await Deno.makeTempDir({ prefix: "tagmonia-write-" });
  await Deno.mkdir(join(root, "Album"));
  const names = ["01.flac", "02.mp3", "03.m4a"];
  for (const [i, ext] of ["flac", "mp3", "m4a"].entries()) {
    await Deno.copyFile(join(AUDIO_DIR, `tagged.${ext}`), join(root, "Album", names[i]));
  }
  const db = await memoryDb();
  const rootReal = await Deno.realPath(root);
  const scan = () => scanLibrary({ db, tagio, rootReal, ignore: [], logger: nullLogger });
  await scan();
  const files = db.prepare("SELECT id, path, current_tags FROM library_file ORDER BY path").all() as {
    id: number;
    path: string;
    current_tags: string;
  }[];
  const candidateId = (db.prepare("SELECT id FROM candidate").get() as { id: number }).id;
  return {
    root,
    db,
    scan,
    candidateId,
    files: files.map((f) => ({ id: f.id, path: f.path, tags: JSON.parse(f.current_tags) as CanonicalTags })),
    abs: (path: string) => join(root, path),
    deps: { db, tagio, musicDir: root, readOnly: false, logger: nullLogger },
    [Symbol.asyncDispose]: async () => {
      db.close();
      await Deno.remove(root, { recursive: true });
    },
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** An approved proposal: new album, title and genre for every file; the rest proposed as it already is. */
function propose(s: Setup, opts: { locks?: FieldLock[] } = {}): number {
  const proposed = {
    release: { album: "New Album", genre: ["Jazz"], albumartist: s.files[0].tags.albumartist },
    tracks: new Map(s.files.map((f, i) => [`t${i}`, { title: `Track ${i + 1}`, tracknumber: f.tags.tracknumber }])),
  };
  const build = buildFieldProposals({
    candidateId: s.candidateId,
    files: s.files,
    mapping: s.files.map((f, i) => ({ fileId: f.id, trackId: `t${i}` })),
    proposed,
    snapshotId: null,
    locks: opts.locks ?? [],
  });
  const hash = (s.db.prepare("SELECT content_hash FROM candidate WHERE id = ?").get(s.candidateId) as {
    content_hash: string;
  }).content_hash;
  const id = saveProposal(s.db, {
    candidateId: s.candidateId,
    releaseMbid: "00000000-0000-4000-8000-000000000001",
    chosenBy: "user",
    basedOnHash: hash,
    snapshotIds: [],
    build,
  }, 1);
  setProposalState(s.db, id, "approved", 1);
  return id;
}

const read = async (s: Setup, path: string) => (await tagio.read(s.abs(path), { pictureData: false })).tags;

Deno.test("writing applies the reviewed fields, keeps the rest, and leaves nothing for a rescan to find", async () => {
  await using s = await setup();
  const before = await Promise.all(s.files.map((f) => read(s, f.path)));
  const r = await writeProposal(s.deps, propose(s));
  assertEquals([r.status, r.written, r.skipped, r.failed], ["done", 3, 0, 0]);
  for (const [i, f] of s.files.entries()) {
    const now = await read(s, f.path);
    assertEquals([now.album, now.title, now.genre], ["New Album", `Track ${i + 1}`, ["Jazz"]], f.path);
    // Untouched fields stay exactly as they were.
    assertEquals(now.artists, before[i].artists);
    assertEquals(now.musicbrainz_recordingid, before[i].musicbrainz_recordingid);
    const row = s.db.prepare("SELECT current_tags FROM library_file WHERE id = ?").get(f.id) as {
      current_tags: string;
    };
    assertEquals(JSON.parse(row.current_tags), now, "the database holds what is on disk");
  }
  const p = latestProposal(s.db, s.candidateId)!;
  assertEquals(p.state, "written");
  // The release hash is what the scanner computes, so a rescan sees no change and nothing is re-identified.
  const rescan = await s.scan();
  assertEquals([rescan.updated, rescan.candidatesTouched], [0, []]);
  const st = await Promise.all(s.files.map((f) => Deno.stat(s.abs(f.path))));
  const expected = await candidateContentHash(
    s.files.map((f, i) => ({ path: f.path, size: st[i].size, mtimeMs: Math.round(st[i].mtime!.getTime()) })),
  );
  assertEquals(
    (s.db.prepare("SELECT content_hash FROM candidate").get() as { content_hash: string }).content_hash,
    expected,
  );
});

Deno.test("undo puts every file's tags back exactly, removing fields the write added", async () => {
  await using s = await setup();
  const before = await Promise.all(s.files.map((f) => read(s, f.path)));
  const w = await writeProposal(s.deps, propose(s));
  const u = await undoBatch(s.deps, w.batchId);
  assertEquals([u.status, u.written], ["done", 3]);
  for (const [i, f] of s.files.entries()) assertEquals(await read(s, f.path), before[i], f.path);
  const batch = s.db.prepare("SELECT status FROM write_batch WHERE id = ?").get(w.batchId) as { status: string };
  assertEquals(batch.status, "undone");
  assertEquals(latestProposal(s.db, s.candidateId)!.state, "needs_review", "can be reviewed and written again");
  // The undo put back exactly the tags the proposal was built from: it is not "stale" because the files'
  // mtimes changed (D53: the header offers writing again, not "Build again").
  const { content_hash } = s.db.prepare("SELECT content_hash FROM candidate WHERE id = ?").get(s.candidateId) as {
    content_hash: string;
  };
  assertEquals(latestProposal(s.db, s.candidateId)!.basedOnHash, content_hash);
  assertEquals((await s.scan()).candidatesTouched, []);
  await assertRejects(() => undoBatch(s.deps, w.batchId), Error, "cannot be undone");
});

Deno.test("a file changed by another tagger after review is skipped, not overwritten (§11.3 step 1)", async () => {
  await using s = await setup();
  const id = propose(s);
  await tagio.write(s.abs(s.files[1].path), { set: { title: "Edited elsewhere" }, remove: [] });
  const r = await writeProposal(s.deps, id);
  assertEquals([r.status, r.written, r.skipped], ["partial", 2, 1]);
  assertEquals((await read(s, s.files[1].path)).title, "Edited elsewhere");
  const backup = s.db.prepare("SELECT status, error FROM file_backup WHERE path = ?").get(s.files[1].path) as {
    status: string;
    error: string;
  };
  assertEquals(backup.status, "skipped_stale");
  assert(backup.error.includes("title"), backup.error);
  assertEquals(latestProposal(s.db, s.candidateId)!.state, "needs_review");
});

Deno.test("undo leaves alone a file someone changed after the write", async () => {
  await using s = await setup();
  const w = await writeProposal(s.deps, propose(s));
  await tagio.write(s.abs(s.files[0].path), { set: { album: "User's own album" }, remove: [] });
  const u = await undoBatch(s.deps, w.batchId);
  assertEquals([u.status, u.written, u.skipped], ["partial", 2, 1]);
  assertEquals((await read(s, s.files[0].path)).album, "User's own album");
  const batch = s.db.prepare("SELECT status FROM write_batch WHERE id = ?").get(w.batchId) as { status: string };
  assertNotEquals(batch.status, "undone", "only a complete undo marks the write undone");
});

Deno.test("a write that does not read back as asked is rolled back (§11.3 step 4)", async () => {
  await using s = await setup();
  const before = await read(s, s.files[2].path);
  // A TagIO that silently stores a different title on the first write to the M4A file.
  let garbled = false;
  const faulty: TagIO = {
    read: (p, o) => tagio.read(p, o),
    write: (p, change) => {
      if (p.endsWith(".m4a") && change.set.title && !garbled) {
        garbled = true;
        return tagio.write(p, { ...change, set: { ...change.set, title: "garbled" } });
      }
      return tagio.write(p, change);
    },
  };
  const r = await writeProposal({ ...s.deps, tagio: faulty }, propose(s));
  assertEquals([r.status, r.written, r.failed], ["partial", 2, 1]);
  assertEquals(await read(s, s.files[2].path), before, "restored to exactly what it held");
  const backup = s.db.prepare("SELECT status FROM file_backup WHERE path = ?").get(s.files[2].path) as {
    status: string;
  };
  assertEquals(backup.status, "restored");
});

Deno.test("locked and kept fields are not written; an edited value is written instead of the proposal", async () => {
  await using s = await setup();
  const id = propose(s, { locks: [{ scope: "release", target: String(s.candidateId), field: "genre" }] });
  const albumRows = s.db.prepare("SELECT id FROM field_proposal WHERE proposal_id = ? AND field = 'album'").all(id) as {
    id: number;
  }[];
  s.db.prepare("UPDATE field_proposal SET decision = 'edited', edited_value = ? WHERE id = ?").run(
    JSON.stringify("My Album"),
    albumRows[0].id,
  );
  s.db.prepare(
    "UPDATE field_proposal SET decision = 'kept_current' WHERE proposal_id = ? AND field = 'title' AND file_id = ?",
  )
    .run(id, s.files[1].id);
  const before = await Promise.all(s.files.map((f) => read(s, f.path)));
  await writeProposal(s.deps, id);
  const after = await Promise.all(s.files.map((f) => read(s, f.path)));
  assertEquals(after.map((t) => t.genre), before.map((t) => t.genre), "genre locked for the release");
  assertEquals(after[0].album, "My Album");
  assertEquals(after[1].title, before[1].title, "kept as it was");
});

Deno.test("read-only mode refuses to write anything", async () => {
  await using s = await setup();
  const digest = async () => await sha256(await Deno.readFile(s.abs(s.files[0].path)));
  const before = await digest();
  await assertRejects(() => writeProposal({ ...s.deps, readOnly: true }, propose(s)), ReadOnlyError);
  assertEquals(await digest(), before);
  assertEquals((s.db.prepare("SELECT count(*) n FROM write_batch").get() as { n: number }).n, 0);
});

Deno.test("a stored path that escapes the music root is refused (§14.4)", async () => {
  await using s = await setup();
  const id = propose(s);
  s.db.prepare("UPDATE library_file SET path = '../../etc/passwd' WHERE id = ?").run(s.files[0].id);
  const r = await writeProposal(s.deps, id);
  assertEquals([r.written, r.failed], [2, 1]);
});

Deno.test("only an approved proposal is written", async () => {
  await using s = await setup();
  const id = propose(s);
  setProposalState(s.db, id, "needs_review", 2);
  await assertRejects(() => writeProposal(s.deps, id), Error, "not approved");
});

Deno.test("a restore that does not read back either is reported as failed, never as restored", async () => {
  await using s = await setup();
  // Every write to the M4A file is garbled, the restore included.
  const broken: TagIO = {
    read: (p, o) => tagio.read(p, o),
    write: (p, change) =>
      tagio.write(
        p,
        p.endsWith(".m4a") && change.set.title ? { ...change, set: { ...change.set, title: "x" } } : change,
      ),
  };
  const r = await writeProposal({ ...s.deps, tagio: broken }, propose(s));
  assertEquals(r.failed, 1);
  const backup = s.db.prepare("SELECT status, error, tags_before FROM file_backup WHERE path = ?").get(
    s.files[2].path,
  ) as { status: string; error: string; tags_before: string };
  assertEquals(backup.status, "failed");
  assert(backup.error.includes("original tags are in this backup"), backup.error);
  assertEquals(JSON.parse(backup.tags_before).title, s.files[2].tags.title, "the original is kept for recovery");
});
