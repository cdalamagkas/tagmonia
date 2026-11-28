/** A pasted link's release may be on MusicBrainz after all (D68): switched to when certain, offered otherwise. */
import { assert, assertEquals } from "@std/assert";
import type { Db } from "../../server/db/db.ts";
import { reconcileUnit, upsertFile } from "../../server/db/repo/library.ts";
import { latestProposal, musicBrainzCandidates, providerMatches } from "../../server/db/repo/proposals.ts";
import { enqueueProviderPropose, registerProposeJob } from "../../server/jobs/propose.ts";
import { JobQueue } from "../../server/jobs/queue.ts";
import { nullLogger } from "../../server/log.ts";
import type { HarmonizedRelease } from "../../server/providers/harmony_adapter.ts";
import type { MbSearchRelease } from "../../server/providers/musicbrainz/schema.ts";
import { certainDuplicate } from "../../server/submission/duplicates.ts";
import { memoryDb } from "../helpers/app.ts";
import { BEETHOVEN_5, FakeMb, loadRelease } from "../identify/helpers.ts";

const release = await loadRelease(BEETHOVEN_5);
const LINK = "https://www.deezer.com/album/1";

function seed(db: Db): number {
  for (const id of [1, 2, 3, 4, 5]) {
    db.prepare(
      "INSERT INTO snapshot (id, provider, request_key, status, fetched_at, body_path, size) VALUES (?, 'musicbrainz', ?, 200, 0, 'x', 0)",
    ).run(id, `k${id}`);
  }
  const paths = release.media[0].tracks!.map((t) => `K/0${t.position}.flac`);
  for (const [i, t] of release.media[0].tracks!.entries()) {
    upsertFile(db, {
      path: paths[i],
      folder: "K",
      size: 1,
      mtimeMs: 1,
      format: "flac",
      durationMs: t.length! + 500,
      sampleRate: null,
      channels: null,
      bitrateKbps: null,
      tags: { title: t.title, tracknumber: t.position },
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
    hintAlbum: null,
    hintMbid: null,
    contentHash: "h",
  }], 1)[0];
}

const deezerAlbum = {
  title: "Symphony No. 5",
  artists: [{ name: "Wiener Philharmoniker" }],
  gtin: "028925421059",
  externalLinks: [],
  media: [{ tracklist: release.media[0].tracks!.map((t) => ({ title: t.title, length: t.length })) }],
  info: { providers: [{ name: "Deezer", internalName: "deezer", id: "1", url: LINK }], messages: [] },
} as unknown as HarmonizedRelease;

const hit = (over: Partial<MbSearchRelease> = {}) =>
  ({
    id: BEETHOVEN_5,
    title: release.title,
    "track-count": release.media[0].tracks!.length,
    score: 100,
    ...over,
  }) as MbSearchRelease;

async function run(answers: { linked?: MbSearchRelease[]; byBarcode?: MbSearchRelease[]; byText?: MbSearchRelease[] }) {
  const db = await memoryDb();
  const id = seed(db);
  const q = new JobQueue(db, { logger: nullLogger });
  const mb = new FakeMb([release]);
  const searched: string[] = [];
  registerProposeJob(q, {
    db,
    mb,
    search: {
      releasesForUrl: (url: string) => {
        searched.push(`url ${url}`);
        return Promise.resolve({ value: url === LINK ? answers.linked ?? [] : [], snapshotId: 0 });
      },
      searchReleases: (query: { barcode?: string }) => {
        searched.push(query.barcode ? `barcode ${query.barcode}` : "text");
        return Promise.resolve({
          value: query.barcode ? answers.byBarcode ?? [] : answers.byText ?? [],
          snapshotId: 0,
        });
      },
    } as never,
    settings: () => ({ genres: "none", maxGenres: 5 }),
    logger: nullLogger,
    enrichment: {
      registry: {
        providerIds: ["deezer"],
        providerForUrl: (u) => (u.host.includes("deezer") ? "deezer" : undefined),
        lookupByUrl: () => Promise.resolve(deezerAlbum),
        lookupByGtin: () => Promise.reject(new Error("not found")),
      },
      enabled: (p) => p === "deezer",
    },
  });
  enqueueProviderPropose(q, id, LINK);
  await q.drain();
  return { db, id, p: latestProposal(db, id)!, searched };
}

Deno.test("MusicBrainz links the pasted page: the tags come from MusicBrainz, the link fills the gaps", async () => {
  const { db, p, searched } = await run({ linked: [hit()] });
  assertEquals([p.releaseMbid, p.sourceUrl, p.chosenBy], [BEETHOVEN_5, LINK, "user"], "found from the link");
  assert(p.fields.some((f) => f.field === "musicbrainz_albumid" && f.proposed === BEETHOVEN_5));
  assertEquals(providerMatches(db, p.id).find((m) => m.provider === "deezer")?.via, "link", "Deezer still asked");
  assert(searched.includes(`url ${LINK}`) && searched.includes("barcode 028925421059"));
  db.close();
});

Deno.test("the same barcode and track count is certain; a title alone is only offered", async () => {
  {
    const { db, p } = await run({ byBarcode: [hit()] });
    assertEquals(p.releaseMbid, BEETHOVEN_5);
    db.close();
  }
  {
    const { db, p } = await run({ byText: [hit({ score: 95 })] });
    assertEquals([p.releaseMbid, p.sourceUrl], [null, LINK], "still built from the link");
    assertEquals(musicBrainzCandidates(db, p.id).map((c) => [c.mbid, c.reasons]), [[
      BEETHOVEN_5,
      ["same title, artist and tracks"],
    ]]);
    db.close();
  }
  {
    const { db, p } = await run({});
    assertEquals([p.releaseMbid, musicBrainzCandidates(db, p.id)], [null, []], "nothing found: a link as before");
    db.close();
  }
});

Deno.test("certain means one release linked to the page, or one with the same barcode and track count", () => {
  const d = (mbid: string, reasons: string[], trackCount: number | null = 9) => ({
    mbid,
    title: "T",
    artist: null,
    date: null,
    country: null,
    barcode: null,
    trackCount,
    reasons,
  });
  assertEquals(certainDuplicate([d("a", ["linked to the Deezer page"])], 9), "a");
  assertEquals(certainDuplicate([d("a", ["same barcode"])], 9), "a");
  assertEquals(certainDuplicate([d("a", ["same barcode"], 10)], 9), null, "another edition");
  assertEquals(certainDuplicate([d("a", ["same barcode"]), d("b", ["same barcode"])], 9), null, "two: offered");
  assertEquals(certainDuplicate([d("a", ["same title, artist and tracks"])], 9), null);
});
