/** Fingerprint evidence: fpcalc results cached per file, AcoustID results filtered and stored. */
import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { getFingerprint, reconcileUnit, upsertFile } from "../../server/db/repo/library.ts";
import { createAcoustIdSource } from "../../server/identify/acoustid_source.ts";
import type { AcoustIdClient, AcoustIdResult } from "../../server/providers/acoustid.ts";
import { nullLogger } from "../../server/log.ts";
import { FingerprintError, type fingerprintFile } from "../../server/tagio/mod.ts";
import { memoryDb } from "../helpers/app.ts";

const REC = "11111111-1111-4111-8111-111111111111";
const REL = "22222222-2222-4222-8222-222222222222";

async function setup() {
  const root = await Deno.makeTempDir({ prefix: "tagmonia-music-" });
  await Deno.mkdir(join(root, "A"));
  for (const n of ["01.flac", "02.flac", "03.flac"]) await Deno.writeFile(join(root, "A", n), new Uint8Array(1));
  const db = await memoryDb();
  for (const n of ["01.flac", "02.flac", "03.flac"]) {
    upsertFile(db, {
      path: `A/${n}`,
      folder: "A",
      size: 1,
      mtimeMs: 1,
      format: "flac",
      durationMs: 200_000,
      sampleRate: null,
      channels: null,
      bitrateKbps: null,
      tags: {},
      pictures: [],
      readError: null,
      scannedAt: 1,
    });
  }
  reconcileUnit(db, "A", [{
    key: "k",
    folder: "A",
    paths: ["A/01.flac", "A/02.flac", "A/03.flac"],
    hintArtist: null,
    hintAlbum: null,
    hintMbid: null,
    contentHash: "h",
  }], 1);
  const ids = (db.prepare("SELECT id FROM library_file ORDER BY path").all() as { id: number }[]).map((r) => r.id);

  const fpCalls: string[] = [];
  const fingerprint: typeof fingerprintFile = (abs) => {
    fpCalls.push(abs);
    if (abs.endsWith("03.flac")) return Promise.reject(new FingerprintError("Empty fingerprint"));
    return Promise.resolve({ fingerprint: `FP-${abs.slice(-7)}`, durationSec: 200 });
  };
  const lookups: string[] = [];
  const acoustid = {
    lookup: (fp: string) => {
      lookups.push(fp);
      const results: AcoustIdResult[] = fp.endsWith("01.flac")
        ? [
          { id: "weak-track", score: 0.2, recordings: [{ id: "99999999-9999-4999-8999-999999999999" }] },
          { id: "good-track", score: 0.95, recordings: [{ id: REC, releases: [{ id: REL }] }] },
        ]
        : [];
      return Promise.resolve({ value: results, snapshotId: 1 });
    },
  } as unknown as AcoustIdClient;
  const source = createAcoustIdSource({ db, acoustid, musicDir: root, logger: nullLogger, fingerprint });
  const files = ids.map((id, i) => ({ fileId: id, path: `A/0${i + 1}.flac`, durationMs: 200_000 }));
  return {
    db,
    ids,
    files,
    source,
    fpCalls,
    lookups,
    [Symbol.asyncDispose]: async () => {
      db.close();
      await Deno.remove(root, { recursive: true });
    },
  };
}

Deno.test("matches keep only results above the minimum score, and store the AcoustID track id", async () => {
  await using s = await setup();
  const m = await s.source.lookup(s.files);
  assertEquals([...m.keys()], [s.ids[0]]);
  assertEquals(m.get(s.ids[0]), { recordingIds: [REC], releaseIds: [REL] });
  const acoustid = s.db.prepare("SELECT acoustid_id FROM library_file ORDER BY path").all() as {
    acoustid_id: string | null;
  }[];
  assertEquals(acoustid.map((r) => r.acoustid_id), ["good-track", null, null]);
});

Deno.test("fingerprints are computed once and reused; a file fpcalc cannot read is skipped", async () => {
  await using s = await setup();
  await s.source.lookup(s.files);
  await s.source.lookup(s.files);
  // 03 fails each time (nothing to cache); 01 and 02 are computed once.
  assertEquals(s.fpCalls.filter((p) => p.endsWith("01.flac")).length, 1);
  assertEquals(s.fpCalls.filter((p) => p.endsWith("03.flac")).length, 2);
  assertEquals(getFingerprint(s.db, s.ids[0]), { fingerprint: "FP-01.flac", durationSec: 200 });
  assertEquals(s.lookups.length, 4);
});

Deno.test("a rescanned (changed) file loses its stale fingerprint and AcoustID id", async () => {
  await using s = await setup();
  await s.source.lookup(s.files);
  const row = s.db.prepare("SELECT * FROM library_file WHERE id = ?").get(s.ids[0]) as Record<string, unknown>;
  upsertFile(s.db, {
    path: "A/01.flac",
    folder: "A",
    size: 2,
    mtimeMs: 2,
    format: "flac",
    durationMs: 100_000,
    sampleRate: null,
    channels: null,
    bitrateKbps: null,
    tags: {},
    pictures: [],
    readError: null,
    scannedAt: 2,
  });
  assertEquals(row.acoustid_id, "good-track");
  assertEquals(getFingerprint(s.db, s.ids[0]), null);
  const after = s.db.prepare("SELECT acoustid_id FROM library_file WHERE id = ?").get(s.ids[0]) as {
    acoustid_id: string | null;
  };
  assertEquals(after.acoustid_id, null);
});

Deno.test("paths are resolved inside the music root before fpcalc sees them", async () => {
  await using s = await setup();
  await s.source.lookup([{ fileId: s.ids[0], path: "../../etc/passwd", durationMs: 1 }]).catch(() => {});
  assertEquals(s.fpCalls.length, 0);
});
