/** The propose job: lookups, stored proposal, automatic proposals after a confident match. */
import { assert, assertEquals } from "@std/assert";
import type { Db } from "../../server/db/db.ts";
import { reconcileUnit, upsertFile } from "../../server/db/repo/library.ts";
import { latestProposal, providerMatches } from "../../server/db/repo/proposals.ts";
import { enqueueIdentify, registerIdentifyJob } from "../../server/jobs/identify.ts";
import { autoPropose, enqueuePropose, PROPOSE_JOB, registerProposeJob } from "../../server/jobs/propose.ts";
import { JobQueue } from "../../server/jobs/queue.ts";
import { nullLogger } from "../../server/log.ts";
import { DEFAULT_IDENTIFY } from "../../server/identify/identify.ts";
import { memoryDb } from "../helpers/app.ts";
import { BEETHOVEN_5, FakeMb, loadRelease, loadWork, SYMPHONY_5 } from "../identify/helpers.ts";

const release = await loadRelease(BEETHOVEN_5);
const symphony = await loadWork(SYMPHONY_5);

function seed(db: Db): number {
  for (const id of [1, 2, 3, 4, 5]) {
    db.prepare(
      "INSERT INTO snapshot (id, provider, request_key, status, fetched_at, body_path, size) VALUES (?, 'musicbrainz', ?, 200, 0, 'x', 0)",
    ).run(id, `k${id}`);
  }
  const paths: string[] = [];
  for (const t of release.media[0].tracks!) {
    const path = `K/0${t.position}.flac`;
    paths.push(path);
    upsertFile(db, {
      path,
      folder: "K",
      size: 1,
      mtimeMs: 1,
      format: "flac",
      durationMs: t.length! + 500,
      sampleRate: null,
      channels: null,
      bitrateKbps: null,
      // An already half-tagged rip: the title is right, the album is spelled differently.
      tags: { title: t.title, tracknumber: t.position, album: "Symphony No. 5", albumartist: "Karajan" },
      pictures: [],
      readError: null,
      scannedAt: 1,
    });
  }
  return reconcileUnit(db, "K", [{
    key: "k",
    folder: "K",
    paths,
    hintArtist: null,
    hintAlbum: "Symphony No. 5",
    hintMbid: null,
    contentHash: "h1",
  }], 1)[0];
}

async function setup() {
  const db = await memoryDb();
  const mb = new FakeMb([release]);
  mb.works.set(SYMPHONY_5, symphony);
  mb.genres.set(BEETHOVEN_5, {
    id: BEETHOVEN_5,
    genres: [],
    "release-group": { genres: [{ id: "g", name: "classical", count: 3 }] },
    relations: [],
  });
  const queue = new JobQueue(db, { logger: nullLogger, retryBaseMs: 10 });
  registerProposeJob(queue, { db, mb, settings: () => ({ genres: "musicbrainz", maxGenres: 5 }), logger: nullLogger });
  return { db, mb, queue, id: seed(db) };
}

Deno.test("a proposal is built from the release, its genres and its parent works", async () => {
  const { db, mb, queue, id } = await setup();
  enqueuePropose(queue, id, BEETHOVEN_5, "user");
  await queue.drain();
  assertEquals(mb.calls, [`lookup ${BEETHOVEN_5}`, `genres ${BEETHOVEN_5}`, `work ${SYMPHONY_5}`]);
  const p = latestProposal(db, id)!;
  assertEquals([p.state, p.chosenBy, p.releaseMbid, p.basedOnHash], ["needs_review", "user", BEETHOVEN_5, "h1"]);
  assertEquals(p.snapshotIds, [2, 4, 5]);
  const first = p.fields.filter((f) => f.fileId === p.fields[0].fileId);
  const status = (field: string) => first.find((f) => f.field === field)?.status;
  // "Symphony No. 5" in the files, "Symphony no. 5" on MusicBrainz: the case is proposed (D43).
  assertEquals([status("title"), status("tracknumber"), status("album"), status("genre")], [
    "unchanged",
    "unchanged",
    "changed",
    "added",
  ]);
  assertEquals(status("albumartist"), "changed");
  assertEquals(first.find((f) => f.field === "movementtotal")?.proposed, 4);
  assertEquals(p.unmappedFiles, []);
});

Deno.test("rebuilding replaces the unwritten proposal instead of piling up", async () => {
  const { db, queue, id } = await setup();
  enqueuePropose(queue, id, BEETHOVEN_5, "auto");
  await queue.drain();
  enqueuePropose(queue, id, BEETHOVEN_5, "user");
  await queue.drain();
  assertEquals((db.prepare("SELECT count(*) n FROM proposal").get() as { n: number }).n, 1);
  assertEquals(latestProposal(db, id)!.chosenBy, "user");
});

Deno.test("an automatic proposal never replaces one the user chose", async () => {
  const { db, queue, id } = await setup();
  enqueuePropose(queue, id, BEETHOVEN_5, "user");
  await queue.drain();
  assertEquals(autoPropose(db, queue, id, BEETHOVEN_5), null);
});

Deno.test("a confident identification prepares the proposal automatically", async () => {
  const { db, mb, queue, id } = await setup();
  mb.search = () => [release];
  // The rip is tagged like the release, so identification is confident.
  db.prepare("UPDATE library_file SET current_tags = json_set(current_tags, '$.album', ?, '$.albumartist', ?)").run(
    release.title,
    "Beethoven; Berlin Philharmonic Orchestra, Herbert von Karajan",
  );
  registerIdentifyJob(queue, { db, mb, config: () => DEFAULT_IDENTIFY, logger: nullLogger });
  enqueueIdentify(queue, [id]);
  await queue.drain();
  await queue.drain();
  assert(queue.latest(PROPOSE_JOB), "propose job enqueued");
  assertEquals(latestProposal(db, id)?.chosenBy, "auto");
});

Deno.test("an unknown release fails the job permanently, without retries", async () => {
  const { queue, id } = await setup();
  const job = enqueuePropose(queue, id, "00000000-0000-4000-8000-000000000000", "user");
  await queue.drain();
  const done = queue.get(job.id)!;
  assertEquals([done.state, done.attempts], ["failed", 1]);
});

Deno.test("the release's matches on other providers are stored with the proposal (D47)", async () => {
  const { db, id } = await setup();
  const seen: string[][] = [];
  // A propose job registered with a fake registry: it sees the links MusicBrainz gave.
  const q2 = new JobQueue(db, { logger: nullLogger });
  const mb = new FakeMb([release]);
  mb.genres.set(BEETHOVEN_5, {
    id: BEETHOVEN_5,
    genres: [],
    relations: [{ type: "discogs", url: { resource: "https://www.discogs.com/release/1" } }],
  });
  registerProposeJob(q2, {
    db,
    mb,
    settings: () => ({ genres: "musicbrainz", maxGenres: 5 }),
    logger: nullLogger,
    enrichment: {
      registry: {
        providerIds: ["discogs"],
        providerForUrl: (u) => (u.host.includes("discogs") ? "discogs" : undefined),
        lookupByUrl: (u) => {
          seen.push([u.href]);
          return Promise.reject(new Error("API returned no results"));
        },
        lookupByGtin: () => Promise.reject(new Error("unused")),
      },
      enabled: () => true,
    },
  });
  enqueuePropose(q2, id, BEETHOVEN_5, "user");
  await q2.drain();
  const p = latestProposal(db, id)!;
  assertEquals(seen, [["https://www.discogs.com/release/1"]]);
  assertEquals(
    providerMatches(db, p.id).map((m) => [m.provider, m.status, m.via]),
    [["deezer", "skipped", null], ["itunes", "skipped", null], ["discogs", "not_found", "link"]],
  );
});
