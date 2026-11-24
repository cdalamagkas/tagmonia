/** The identify job: evidence from stored files, persisted matches and candidate status. */
import { assert, assertEquals } from "@std/assert";
import type { Db } from "../../server/db/db.ts";
import { type FileRecord, reconcileUnit, upsertFile } from "../../server/db/repo/library.ts";
import { matchesFor } from "../../server/db/repo/matches.ts";
import { buildEvidence, enqueueIdentify, IDENTIFY_JOB, registerIdentifyJob } from "../../server/jobs/identify.ts";
import { JobQueue } from "../../server/jobs/queue.ts";
import { nullLogger } from "../../server/log.ts";
import { DEFAULT_IDENTIFY } from "../../server/identify/identify.ts";
import type { CanonicalTags } from "../../server/tagio/types.ts";
import { memoryDb } from "../helpers/app.ts";
import { BEETHOVEN_5, FakeMb, loadRelease } from "../identify/helpers.ts";

const release = await loadRelease(BEETHOVEN_5);

function file(path: string, durationMs: number, tags: CanonicalTags): FileRecord {
  return {
    path,
    folder: "Karajan - Beethoven 5",
    size: 1,
    mtimeMs: 1,
    format: "flac",
    durationMs,
    sampleRate: 44100,
    channels: 2,
    bitrateKbps: 900,
    tags,
    pictures: [],
    readError: null,
    scannedAt: 1,
  };
}

/** One candidate holding a tagged rip of the recorded release. Returns its id. */
function seedCandidate(db: Db, extraTags: CanonicalTags = {}): number {
  const tracks = release.media[0].tracks!;
  const paths: string[] = [];
  for (const t of tracks) {
    const path = `Karajan - Beethoven 5/0${t.position}.flac`;
    paths.push(path);
    upsertFile(
      db,
      file(path, t.length! + 800, {
        title: t.title,
        tracknumber: t.position,
        album: "Symphony no. 5",
        albumartist: "Beethoven; Berlin Philharmonic Orchestra, Herbert von Karajan",
        ...extraTags,
      }),
    );
  }
  const [id] = reconcileUnit(db, "Karajan - Beethoven 5", [{
    key: "k",
    folder: "Karajan - Beethoven 5",
    paths,
    hintArtist: "Beethoven; Berlin Philharmonic Orchestra, Herbert von Karajan",
    hintAlbum: "Symphony no. 5",
    hintMbid: null,
    contentHash: "h1",
  }], 1);
  return id;
}

async function setup(mb: FakeMb) {
  const db = await memoryDb();
  // match.snapshot_id is a foreign key; FakeMb cites snapshots 1 (searches) and 2 (lookups).
  for (const id of [1, 2]) {
    db.prepare(
      "INSERT INTO snapshot (id, provider, request_key, status, fetched_at, body_path, size) VALUES (?, 'musicbrainz', ?, 200, 0, 'x', 0)",
    ).run(id, `k${id}`);
  }
  let now = 5_000;
  const queue = new JobQueue(db, { logger: nullLogger, retryBaseMs: 10, now: () => now });
  registerIdentifyJob(queue, { db, mb, config: () => DEFAULT_IDENTIFY, logger: nullLogger, now: () => now });
  return { db, queue, advance: (ms: number) => (now += ms) };
}

function status(db: Db, id: number) {
  return db.prepare("SELECT status, identified_hash, identify_error FROM candidate WHERE id = ?").get(id) as {
    status: string;
    identified_hash: string | null;
    identify_error: string | null;
  };
}

Deno.test("identify stores ranked matches with mapping and summary, and marks the candidate matched", async () => {
  const mb = new FakeMb([release]);
  mb.search = () => [release];
  const { db, queue } = await setup(mb);
  const id = seedCandidate(db);
  enqueueIdentify(queue, [id]);
  await queue.drain();

  assertEquals(status(db, id), { status: "matched", identified_hash: "h1", identify_error: null });
  const [best] = matchesFor(db, id);
  assertEquals([best.rank, best.releaseMbid, best.method], [0, BEETHOVEN_5, "text"]);
  assertEquals(best.summary.catalogNumbers, ["2542 105"]);
  assertEquals(best.mapping.pairs.length, 4);
  assertEquals(best.signals.fingerprint, null);
  assert(best.snapshotId !== null);
  db.close();
});

Deno.test("a rerun replaces the previous matches instead of adding to them", async () => {
  const mb = new FakeMb([release]);
  mb.search = () => [release];
  const { db, queue } = await setup(mb);
  const id = seedCandidate(db);
  enqueueIdentify(queue, [id]);
  await queue.drain();
  enqueueIdentify(queue, [id]);
  await queue.drain();
  assertEquals(matchesFor(db, id).length, 1);
  db.close();
});

Deno.test("enqueueing the same candidate twice while queued runs it once", async () => {
  const { db, queue } = await setup(new FakeMb());
  const id = seedCandidate(db);
  enqueueIdentify(queue, [id, id]);
  assertEquals(
    (db.prepare("SELECT count(*) n FROM job WHERE kind = ?").get(IDENTIFY_JOB) as { n: number }).n,
    1,
  );
  db.close();
});

Deno.test("network failures retry; after the last attempt the candidate shows the error", async () => {
  const mb = new FakeMb();
  mb.search = () => {
    throw new TypeError("connection reset");
  };
  const { db, queue, advance } = await setup(mb);
  const id = seedCandidate(db);
  enqueueIdentify(queue, [id]);
  await queue.drain();
  assertEquals(status(db, id).status, "identifying", "still retrying");
  for (let i = 0; i < 2; i++) {
    advance(10_000);
    await queue.drain();
  }
  assertEquals(status(db, id), { status: "error", identified_hash: null, identify_error: "connection reset" });
  db.close();
});

Deno.test("a candidate deleted by a rescan before its job runs is skipped quietly", async () => {
  const { db, queue } = await setup(new FakeMb());
  const id = seedCandidate(db);
  enqueueIdentify(queue, [id]);
  db.prepare("DELETE FROM candidate WHERE id = ?").run(id);
  await queue.drain();
  const job = queue.latest(IDENTIFY_JOB)!;
  assertEquals([job.state, job.result], ["done", null]);
  db.close();
});

Deno.test("buildEvidence takes the majority tags, unreadable files excluded", () => {
  const ok = (n: number, tags: CanonicalTags) => ({ ...file(`a/${n}.flac`, 1000, tags), id: n, candidateId: 1 });
  const ev = buildEvidence(null, [
    ok(1, { album: "A", artist: "X", barcode: "123456789012", catalognumber: ["C1"] }),
    ok(2, { album: "A", artist: "X", musicbrainz_albumid: BEETHOVEN_5 }),
    ok(3, { album: "B", artist: "X" }),
    { ...ok(4, { album: "B" }), readError: "broken" },
  ]);
  assertEquals(ev.files.map((f) => f.fileId), [1, 2, 3]);
  assertEquals([ev.album, ev.albumArtist, ev.barcode, ev.albumMbid], ["A", "X", "123456789012", BEETHOVEN_5]);
  assertEquals(ev.catalogNumbers, ["C1"]);
});
