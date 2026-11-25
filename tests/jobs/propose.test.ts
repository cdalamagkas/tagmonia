/** The propose job: lookups, stored proposal, automatic proposals after a confident match. */
import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import type { Db } from "../../server/db/db.ts";
import { getCover } from "../../server/db/repo/covers.ts";
import { reconcileUnit, upsertFile } from "../../server/db/repo/library.ts";
import { latestProposal, providerMatches } from "../../server/db/repo/proposals.ts";
import { enqueueIdentify, registerIdentifyJob } from "../../server/jobs/identify.ts";
import {
  autoPropose,
  enqueuePropose,
  enqueueProviderPropose,
  PROPOSE_JOB,
  registerProposeJob,
} from "../../server/jobs/propose.ts";
import { JobQueue } from "../../server/jobs/queue.ts";
import { nullLogger } from "../../server/log.ts";
import type { HarmonizedRelease } from "../../server/providers/harmony_adapter.ts";
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

Deno.test("found providers are merged into the fields: fallbacks are marked, disagreements are conflicts (D48)", async () => {
  const { db, id } = await setup();
  const q2 = new JobQueue(db, { logger: nullLogger });
  const mb = new FakeMb([release]);
  mb.genres.set(BEETHOVEN_5, {
    id: BEETHOVEN_5,
    genres: [],
    relations: [{ type: "discogs", url: { resource: "https://www.discogs.com/release/1" } }],
  });
  const discogs = {
    title: release.title,
    artists: [],
    externalLinks: [],
    gtin: "028925421059",
    releaseDate: { date: { year: 1977 }, quality: "assumed-valid" },
    media: [{ tracklist: release.media[0].tracks!.map((t) => ({ title: t.title })) }],
    info: {
      providers: [{ name: "Discogs", internalName: "discogs", id: "1", url: "https://www.discogs.com/release/1" }],
      messages: [],
    },
  } as unknown as HarmonizedRelease;
  registerProposeJob(q2, {
    db,
    mb,
    settings: () => ({ genres: "musicbrainz", maxGenres: 5 }),
    logger: nullLogger,
    enrichment: {
      registry: {
        providerIds: ["discogs"],
        providerForUrl: (u) => (u.host.includes("discogs") ? "discogs" : undefined),
        lookupByUrl: () => Promise.resolve(discogs),
        lookupByGtin: () => Promise.reject(new Error("unused")),
      },
      enabled: () => true,
    },
  });
  enqueuePropose(q2, id, BEETHOVEN_5, "user");
  await q2.drain();
  const p = latestProposal(db, id)!;
  const row = (field: string) => p.fields.find((f) => f.field === field)!;
  assertEquals([row("barcode").origin, row("barcode").conflict, row("barcode").proposed], [
    "discogs",
    false,
    "028925421059",
  ]);
  assertEquals([row("discogs_release_id").origin, row("discogs_release_id").proposed], ["discogs", "1"]);
  assertEquals([row("date").origin, row("date").conflict, row("date").proposed], ["musicbrainz", true, "1978"]);
  assertEquals(row("date").sources.map((s) => [s.provider, s.value, s.agreesWithProposed]), [
    ["musicbrainz", "1978", true],
    ["discogs", "1977", false],
  ]);
  assertEquals(row("album").origin, "musicbrainz");
  assertEquals(providerMatches(db, p.id).find((m) => m.provider === "discogs")?.status, "found");
});

Deno.test("the cover is chosen, compared with the files and folder, and stored with the proposal (D49)", async () => {
  const { db, id } = await setup();
  const music = await Deno.makeTempDir({ prefix: "tagmonia-propose-covers-" });
  await Deno.mkdir(join(music, "K"));
  try {
    const q2 = new JobQueue(db, { logger: nullLogger });
    const image = { sha256: "a".repeat(64), mime: "image/jpeg" as const, width: 1200, height: 1200, size: 9, url: "u" };
    const asked: string[] = [];
    registerProposeJob(q2, {
      db,
      mb: new FakeMb([release]),
      settings: () => ({ genres: "none", maxGenres: 5 }),
      logger: nullLogger,
      covers: {
        musicDir: music,
        mode: () => "both",
        fetcher: {
          listing: (mbid) => {
            asked.push(`listing ${mbid}`);
            return Promise.resolve({
              images: [{ front: true, image: "https://coverartarchive.org/1.jpg", thumbnails: {} }],
            });
          },
          download: (url) => {
            asked.push(url);
            return Promise.resolve({ ...image, url });
          },
        },
      },
    });
    enqueuePropose(q2, id, BEETHOVEN_5, "user");
    await q2.drain();
    const p = latestProposal(db, id)!;
    const c = getCover(db, p.id)!;
    // The recorded release says the Cover Art Archive has a front image; its original is the only variant.
    assertEquals(asked, [`listing ${BEETHOVEN_5}`, "https://coverartarchive.org/1.jpg"]);
    assertEquals([c.mode, c.source, c.embedStatus, c.folderStatus, c.folderPath, c.folderCurrent], [
      "both",
      "coverartarchive",
      "added",
      "added",
      "K/cover.jpg",
      null,
    ]);
    assertEquals(c.decision, "auto");
  } finally {
    await Deno.remove(music, { recursive: true });
  }
});

Deno.test("a release not on MusicBrainz: built from the linked album, others found by barcode fill gaps (D51)", async () => {
  const { db, id } = await setup();
  const q2 = new JobQueue(db, { logger: nullLogger });
  const album = (name: string, internalName: string, extra: Record<string, unknown> = {}) =>
    ({
      title: "Fifth Symphony (Live)",
      artists: [{ name: "Some Orchestra" }],
      gtin: "0123456789012",
      externalLinks: [],
      media: [{
        format: "Digital Media",
        tracklist: release.media[0].tracks!.map((t) => ({ title: t.title, length: t.length, ...extra })),
      }],
      info: {
        providers: [{ name, internalName, id: `${internalName}-1`, url: `https://www.${internalName}.com/album/1` }],
        messages: [],
      },
    }) as unknown as HarmonizedRelease;
  const asked: string[] = [];
  const mb = new FakeMb([]);
  registerProposeJob(q2, {
    db,
    mb,
    settings: () => ({ genres: "musicbrainz", maxGenres: 5 }),
    logger: nullLogger,
    enrichment: {
      registry: {
        providerIds: ["deezer", "itunes"],
        providerForUrl: (u) => (u.host.includes("deezer") ? "deezer" : undefined),
        lookupByUrl: (u) => {
          asked.push(`url ${u.href}`);
          return Promise.resolve(album("Deezer", "deezer"));
        },
        lookupByGtin: (p, g) => {
          asked.push(`gtin ${p} ${g}`);
          return Promise.resolve(album("iTunes", "itunes", { isrc: "ITX000000001" }));
        },
      },
      enabled: () => true,
    },
  });
  enqueueProviderPropose(q2, id, "https://www.deezer.com/album/1");
  await q2.drain();
  const p = latestProposal(db, id)!;
  assertEquals([p.releaseMbid, p.sourceUrl, p.chosenBy], [null, "https://www.deezer.com/album/1", "user"]);
  assertEquals(asked.filter((a) => a.startsWith("gtin")), ["gtin itunes 0123456789012"]);
  // Every file mapped by title and length; no MusicBrainz identifiers proposed.
  assertEquals(p.unmappedFiles, []);
  assertEquals(p.fields.some((f) => f.field.startsWith("musicbrainz_")), false);
  const row = (field: string) => p.fields.find((f) => f.field === field)!;
  assertEquals([row("album").proposed, row("album").origin], ["Fifth Symphony (Live)", "deezer"]);
  assertEquals([row("deezer_album_id").proposed, row("isrc").proposed, row("isrc").origin], [
    "deezer-1",
    ["ITX000000001"],
    "itunes",
  ]);
  assertEquals(
    providerMatches(db, p.id).map((m) => [m.provider, m.status, m.via]),
    [["deezer", "found", "link"], ["itunes", "found", "barcode"], ["discogs", "skipped", null]],
  );
  assertEquals(mb.calls, [], "MusicBrainz is not asked");
});

Deno.test("a release on the test server is read from there, and the proposal says so (D52)", async () => {
  const { db, id } = await setup();
  const q2 = new JobQueue(db, { logger: nullLogger });
  const main = new FakeMb([]);
  const test = new FakeMb([release]);
  const servers: string[] = [];
  registerProposeJob(q2, {
    db,
    mb: main,
    mbFor: (server) => {
      servers.push(server);
      return test;
    },
    settings: () => ({ genres: "none", maxGenres: 5 }),
    logger: nullLogger,
  });
  enqueuePropose(q2, id, BEETHOVEN_5, "user", "https://test.musicbrainz.org");
  await q2.drain();
  const p = latestProposal(db, id)!;
  assertEquals([p.releaseMbid, p.mbServer], [BEETHOVEN_5, "https://test.musicbrainz.org"]);
  assertEquals([main.calls, test.calls[0], servers[0]], [[], `lookup ${BEETHOVEN_5}`, "https://test.musicbrainz.org"]);
});
