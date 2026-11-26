/**
 * Renaming on write and its undo (D57) on real audio in a temp music root (CLAUDE.md safety rule 1): the
 * production TagIO, the real scanner and the write procedure.
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { latestProposal, saveProposal, setProposalState, setRenameSkip } from "../../server/db/repo/proposals.ts";
import { planRenames, setDestination, tagsAfter } from "../../server/files/rename.ts";
import { nullLogger } from "../../server/log.ts";
import { buildFieldProposals } from "../../server/proposal/build.ts";
import { scanLibrary } from "../../server/scanner/scan.ts";
import { createTagIO } from "../../server/tagio/mod.ts";
import type { CanonicalTags } from "../../server/tagio/types.ts";
import { undoBatch, writeProposal } from "../../server/write/apply.ts";
import { memoryDb } from "../helpers/app.ts";
import { AUDIO_DIR, fixturesPresent } from "../tagio/helpers.ts";

if (!(await fixturesPresent())) throw new Error("Audio fixtures missing: run `scripts/dk scripts/gen_fixtures.sh`.");

const tagio = await createTagIO();
globalThis.addEventListener("unload", () => void tagio.close?.());

const TEMPLATE = "{album}/{title}";

/** Three tracks in "Old Folder" with a cover and a booklet; optionally another album's track in the same folder. */
async function setup(opts: { neighbour?: boolean; renameLibrary?: boolean; template?: string } = {}) {
  const root = await Deno.makeTempDir({ prefix: "tagmonia-rename-" });
  await Deno.mkdir(join(root, "Old Folder"));
  const names = ["01.flac", "02.mp3", "03.m4a"];
  for (const [i, ext] of ["flac", "mp3", "m4a"].entries()) {
    await Deno.copyFile(join(AUDIO_DIR, `tagged.${ext}`), join(root, "Old Folder", names[i]));
  }
  await Deno.writeTextFile(join(root, "Old Folder", "cover.jpg"), "not really a jpeg");
  await Deno.writeTextFile(join(root, "Old Folder", "booklet.pdf"), "pdf");
  const db = await memoryDb();
  const rootReal = await Deno.realPath(root);
  const scan = () => scanLibrary({ db, tagio, rootReal, ignore: [], logger: nullLogger });
  await scan();
  const candidateId = (db.prepare("SELECT id FROM candidate").get() as { id: number }).id;
  if (opts.neighbour) {
    // Another release's file in the same folder: the folder and its other files stay.
    db.prepare(
      "INSERT INTO candidate (group_key, folder, content_hash, created_at, updated_at) VALUES ('other', 'Old Folder', 'x', 1, 1)",
    ).run();
    db.prepare(
      `INSERT INTO library_file (path, folder, size, mtime_ms, format, candidate_id, scanned_at)
       VALUES ('Old Folder/99.flac', 'Old Folder', 1, 1, 'flac', last_insert_rowid(), 1)`,
    ).run();
    await Deno.copyFile(join(AUDIO_DIR, "tagged.flac"), join(root, "Old Folder", "99.flac"));
  }
  const files = (db.prepare("SELECT id, path, current_tags FROM library_file WHERE candidate_id = ? ORDER BY path").all(
    candidateId,
  ) as { id: number; path: string; current_tags: string }[]).map((f) => ({
    id: f.id,
    path: f.path,
    tags: JSON.parse(f.current_tags) as CanonicalTags,
  }));
  const naming = { template: opts.template ?? TEMPLATE, renameLibrary: opts.renameLibrary ?? true };
  return {
    root,
    db,
    scan,
    candidateId,
    files,
    exists: async (p: string) => !!(await Deno.lstat(join(root, p)).catch(() => null)),
    deps: { db, tagio, musicDir: root, readOnly: false, logger: nullLogger, naming: () => naming },
    [Symbol.asyncDispose]: async () => {
      db.close();
      await Deno.remove(root, { recursive: true });
    },
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

function propose(s: Setup): number {
  const build = buildFieldProposals({
    candidateId: s.candidateId,
    files: s.files,
    mapping: s.files.map((f, i) => ({ fileId: f.id, trackId: `t${i}` })),
    proposed: {
      release: { album: "New Album" },
      tracks: new Map(s.files.map((_, i) => [`t${i}`, { title: `Track ${i + 1}` }])),
    },
    snapshotId: null,
    locks: [],
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

const NEW = ["New Album/Track 1.flac", "New Album/Track 2.mp3", "New Album/Track 3.m4a"];
const OLD = ["Old Folder/01.flac", "Old Folder/02.mp3", "Old Folder/03.m4a"];

Deno.test("the plan: new names from the tags after the write, numbered when they collide, taken names refused", () => {
  const f = (id: number, path: string, title: string) => ({ id, path, tags: { album: "A", title } });
  const p = planRenames("{album}/{title}", [
    f(1, "x/1.flac", "Same"),
    f(2, "x/2.flac", "Same"),
    f(3, "A/Kept.flac", "Kept"),
  ], [
    "a/other.FLAC",
  ]);
  assertEquals(p.moves.map((m) => m.to), ["A/Same.flac", "A/Same (2).flac"], "a file already right is not moved");
  assertEquals(p.folders, [{ from: "x", to: "A" }]);
  assertEquals(p.conflicts, []);
  const taken = planRenames("{album}/{title}", [f(1, "x/1.flac", "Other")], ["a/other.flac"]);
  assertEquals(taken.conflicts, ["A/Other.flac already exists"], "names compare without case (SMB, Windows)");
  assertEquals(tagsAfter({ album: "A", genre: ["x"] }, { set: { album: "B" }, remove: ["genre"] }), { album: "B" });
});

Deno.test("a write renames the album's files, moves its cover and booklet, and removes the old folder", async () => {
  await using s = await setup();
  const r = await writeProposal(s.deps, propose(s));
  assertEquals([r.status, r.written], ["done", 3]);
  for (const p of [...NEW, "New Album/cover.jpg", "New Album/booklet.pdf"]) assert(await s.exists(p), p);
  assert(!(await s.exists("Old Folder")), "the emptied folder is gone");
  const rows = s.db.prepare("SELECT id, path, folder FROM library_file ORDER BY path").all() as {
    id: number;
    path: string;
    folder: string;
  }[];
  assertEquals(rows.map((x) => x.path), NEW);
  assertEquals(rows.map((x) => x.id), s.files.map((f) => f.id), "the same files: locks and history follow them");
  assertEquals((s.db.prepare("SELECT folder FROM candidate").get() as { folder: string }).folder, "New Album");
  assertEquals((await tagio.read(join(s.root, NEW[0]), { pictureData: false })).tags.title, "Track 1");
  // A rescan finds the same files, unchanged.
  const rescan = await s.scan();
  assertEquals([rescan.updated, rescan.candidatesTouched], [0, []]);
  assertEquals(latestProposal(s.db, s.candidateId)!.state, "written");
});

Deno.test("undo moves the files back first, then restores their tags", async () => {
  await using s = await setup();
  const before = await Promise.all(
    OLD.map(async (p) => (await tagio.read(join(s.root, p), { pictureData: false })).tags),
  );
  const w = await writeProposal(s.deps, propose(s));
  const u = await undoBatch(s.deps, w.batchId);
  assertEquals([u.status, u.written], ["done", 3]);
  for (const p of [...OLD, "Old Folder/cover.jpg", "Old Folder/booklet.pdf"]) assert(await s.exists(p), p);
  assert(!(await s.exists("New Album")), "the new folder is gone again");
  for (const [i, p] of OLD.entries()) {
    assertEquals((await tagio.read(join(s.root, p), { pictureData: false })).tags, before[i], p);
  }
  assertEquals(
    (s.db.prepare("SELECT path FROM library_file ORDER BY path").all() as { path: string }[]).map((x) => x.path),
    OLD,
  );
  const moves = s.db.prepare("SELECT status FROM file_move WHERE write_batch_id = ?").all(w.batchId) as {
    status: string;
  }[];
  assert(moves.length === 5 && moves.every((m) => m.status === "undone"));
});

Deno.test("a taken name: the tags are written, nothing is renamed, and the batch says why", async () => {
  await using s = await setup();
  await Deno.mkdir(join(s.root, "New Album"));
  await Deno.writeTextFile(join(s.root, "New Album", "Track 2.mp3"), "someone else's file");
  const r = await writeProposal(s.deps, propose(s));
  assertEquals(r.status, "partial");
  const batch = s.db.prepare("SELECT error FROM write_batch WHERE id = ?").get(r.batchId) as { error: string };
  assert(batch.error.includes("Track 2.mp3"), batch.error);
  for (const p of OLD) assert(await s.exists(p), p);
  assertEquals(await Deno.readTextFile(join(s.root, "New Album", "Track 2.mp3")), "someone else's file");
  assertEquals((await tagio.read(join(s.root, OLD[0]), { pictureData: false })).tags.title, "Track 1");
});

Deno.test("renaming off, or left out of this write: only the tags change", async () => {
  {
    await using s = await setup({ renameLibrary: false });
    await writeProposal(s.deps, propose(s));
    for (const p of OLD) assert(await s.exists(p), p);
  }
  {
    await using s = await setup();
    const id = propose(s);
    setRenameSkip(s.db, id, true);
    await writeProposal(s.deps, id);
    for (const p of OLD) assert(await s.exists(p), p);
  }
});

Deno.test("another album's track in the folder: its folder, cover and booklet stay", async () => {
  await using s = await setup({ neighbour: true });
  const r = await writeProposal(s.deps, propose(s));
  assertEquals(r.status, "done");
  for (const p of NEW) assert(await s.exists(p), p);
  for (const p of ["Old Folder/99.flac", "Old Folder/cover.jpg", "Old Folder/booklet.pdf"]) {
    assert(await s.exists(p), p);
  }
});

Deno.test("an inbox album: scanned under @inbox, written into the library, and undone back into the inbox", async () => {
  const lib = await Deno.makeTempDir({ prefix: "tagmonia-lib-" });
  const inbox = await Deno.makeTempDir({ prefix: "tagmonia-inbox-" });
  const db = await memoryDb();
  try {
    await Deno.mkdir(join(inbox, "Download 123"));
    for (const [i, ext] of ["flac", "mp3", "m4a"].entries()) {
      await Deno.copyFile(join(AUDIO_DIR, `tagged.${ext}`), join(inbox, "Download 123", `0${i + 1}.${ext}`));
    }
    await Deno.writeTextFile(join(inbox, "Download 123", "cover.jpg"), "cover");
    // A real "@inbox" folder in the library is never scanned: it would collide with the inbox's paths.
    await Deno.mkdir(join(lib, "@inbox"));
    await Deno.copyFile(join(AUDIO_DIR, "tagged.flac"), join(lib, "@inbox", "x.flac"));
    const scan = async () => {
      const a = await scanLibrary({ db, tagio, rootReal: await Deno.realPath(lib), ignore: [], logger: nullLogger });
      const b = await scanLibrary({
        db,
        tagio,
        rootReal: await Deno.realPath(inbox),
        ignore: [],
        logger: nullLogger,
        inbox: true,
      });
      return { library: a, inbox: b };
    };
    await scan();
    const paths = () =>
      (db.prepare("SELECT path FROM library_file ORDER BY path").all() as { path: string }[]).map((r) => r.path);
    assertEquals(paths(), ["@inbox/Download 123/01.flac", "@inbox/Download 123/02.mp3", "@inbox/Download 123/03.m4a"]);
    assertEquals((await scan()).library.removed, 0, "a library scan leaves the inbox's files alone");

    const candidateId = (db.prepare("SELECT id FROM candidate").get() as { id: number }).id;
    const files = (db.prepare("SELECT id, path, current_tags FROM library_file ORDER BY path").all() as {
      id: number;
      path: string;
      current_tags: string;
    }[]).map((f) => ({ id: f.id, path: f.path, tags: JSON.parse(f.current_tags) as CanonicalTags }));
    const s = { db, candidateId, files } as unknown as Setup;
    // Renaming in the library is off: an inbox album moves anyway, that is what the inbox is for.
    const deps = {
      db,
      tagio,
      musicDir: lib,
      inboxDir: inbox,
      readOnly: false,
      logger: nullLogger,
      naming: () => ({ template: TEMPLATE, renameLibrary: false }),
    };
    const w = await writeProposal(deps, propose(s));
    assertEquals([w.status, w.written], ["done", 3]);
    assertEquals(paths(), NEW);
    for (const p of [...NEW, "New Album/cover.jpg"]) assert(await Deno.lstat(join(lib, p)).catch(() => null), p);
    assert(!(await Deno.lstat(join(inbox, "Download 123")).catch(() => null)), "the inbox folder is emptied away");
    assert(await Deno.lstat(inbox), "the inbox itself stays");
    assertEquals((db.prepare("SELECT folder FROM candidate").get() as { folder: string }).folder, "New Album");
    const again = await scan();
    assertEquals([again.library.added, again.library.updated, again.inbox.removed], [0, 0, 0], "nothing to rescan");

    const u = await undoBatch(deps, w.batchId);
    assertEquals(u.status, "done");
    assertEquals(paths(), ["@inbox/Download 123/01.flac", "@inbox/Download 123/02.mp3", "@inbox/Download 123/03.m4a"]);
    assert(await Deno.lstat(join(inbox, "Download 123", "cover.jpg")), "the cover went back too");
    assert(!(await Deno.lstat(join(lib, "New Album")).catch(() => null)));
  } finally {
    db.close();
    await Deno.remove(lib, { recursive: true });
    await Deno.remove(inbox, { recursive: true });
  }
});

Deno.test("the plan under a destination (D59): the chosen folder, then the template's album part", () => {
  const p = planRenames(
    "{artist}/{album}/{title}",
    [{ id: 1, path: "x/1.flac", tags: { artist: "A", album: "B", title: "T" } }],
    [],
    "Films/F",
  );
  assertEquals(p.moves.map((m) => m.to), ["Films/F/B/T.flac"]);
  assertEquals(p.folders, [{ from: "x", to: "Films/F/B" }]);
});

Deno.test("a destination moves the album there on write, even with renaming off; undo keeps the chosen folder", async () => {
  await using s = await setup({ renameLibrary: false, template: "{artist}/{album}/{title}" });
  // A folder the user made by hand, still empty.
  await Deno.mkdir(join(s.root, "Films", "Interstellar"), { recursive: true });
  setDestination(s.db, s.candidateId, "Films/Interstellar");
  const w = await writeProposal(s.deps, propose(s));
  assertEquals([w.status, w.written], ["done", 3]);
  const placed = NEW.map((p) => `Films/Interstellar/${p}`);
  for (const p of [...placed, "Films/Interstellar/New Album/cover.jpg"]) assert(await s.exists(p), p);
  assertEquals(
    (s.db.prepare("SELECT folder FROM candidate").get() as { folder: string }).folder,
    "Films/Interstellar/New Album",
  );
  const u = await undoBatch(s.deps, w.batchId);
  assertEquals(u.status, "done");
  for (const p of OLD) assert(await s.exists(p), p);
  assert(!(await s.exists("Films/Interstellar/New Album")), "the album folder the write made is gone");
  assert(await s.exists("Films/Interstellar"), "the chosen folder stays, though empty");
});

Deno.test("a destination that does not exist yet is made on write", async () => {
  await using s = await setup({ renameLibrary: false });
  setDestination(s.db, s.candidateId, "Series/Dark (2017)");
  const w = await writeProposal(s.deps, propose(s));
  assertEquals(w.status, "done");
  for (const p of NEW) assert(await s.exists(`Series/Dark (2017)/${p}`), p);
  assert(!(await s.exists("Old Folder")));
});
