/** YouTube as a source (D64): a release from the Data API's facts, a proposal from it, and a submission seed. */
import { assert, assertEquals } from "@std/assert";
import type { Db } from "../../server/db/db.ts";
import { getEvidenceLink } from "../../server/db/repo/evidence.ts";
import { reconcileUnit, upsertFile } from "../../server/db/repo/library.ts";
import { latestProposal, providerMatches } from "../../server/db/repo/proposals.ts";
import { enqueueYouTubePropose, registerProposeJob } from "../../server/jobs/propose.ts";
import { JobQueue } from "../../server/jobs/queue.ts";
import { nullLogger } from "../../server/log.ts";
import { mergeProviderReleases } from "../../server/providers/harmony_adapter.ts";
import type { YouTubeEvidence } from "../../server/providers/youtube.ts";
import { tagsFromProviders } from "../../server/proposal/harmony_tags.ts";
import { youtubeRelease } from "../../server/proposal/youtube_release.ts";
import { mergedFromMatches, seedFor } from "../../server/submission/seed.ts";
import { memoryDb } from "../helpers/app.ts";

const PLAYLIST = "https://www.youtube.com/playlist?list=OLAK5uy_test0001";

const ALBUM: YouTubeEvidence = {
  kind: "playlist",
  url: PLAYLIST,
  title: "Album - Ambient Piano Vol.1",
  channel: "Niklas Blumenthaler - Topic",
  tracks: [
    { videoId: "a", title: "Morning", durationMs: 181_000, name: "Morning", artists: ["Niklas Blumenthaler"] },
    { videoId: "b", title: "Noon", durationMs: 120_000, name: "Noon", artists: ["Niklas Blumenthaler", "Guest"] },
  ],
  label: "LKult",
  date: "2021-07-23",
  album: "Ambient Piano Vol.1",
  providedBy: "DistroKid",
};

Deno.test("an auto-generated playlist gives album, artists, track titles, numbers, date and label", () => {
  const merged = mergeProviderReleases({ YouTube: youtubeRelease(ALBUM) }, "YouTube");
  const t = tagsFromProviders(merged, "youtube");
  assertEquals(
    [t.release.album, t.release.albumartist, t.release.date, t.release.label],
    ["Ambient Piano Vol.1", "Niklas Blumenthaler", "2021-07-23", ["LKult"]],
  );
  assertEquals(
    [...t.tracks.values()].map((x) => [x.tracknumber, x.title, x.artist, x.totaltracks]),
    [[1, "Morning", "Niklas Blumenthaler", 2], [2, "Noon", "Niklas Blumenthaler & Guest", 2]],
  );
  assert([...t.provenance.values()].every((p) => p.origin === "youtube"));
});

Deno.test("any other upload: the video's title, the channel as the artist", () => {
  const plain: YouTubeEvidence = {
    ...ALBUM,
    kind: "video",
    url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    title: "Live at the park",
    channel: "Some Band",
    tracks: [{ videoId: "jNQXAC9IVRw", title: "Live at the park", durationMs: 19_000, name: null, artists: [] }],
    label: null,
    date: null,
    album: null,
  };
  const r = youtubeRelease(plain);
  assertEquals([r.title, r.artists.map((a) => a.name), r.media[0].tracklist[0].title], [
    "Live at the park",
    ["Some Band"],
    "Live at the park",
  ]);
  assertEquals([r.releaseDate, r.labels], [undefined, undefined]);
});

function seed(db: Db): number {
  const paths = ["Misc/01.flac", "Misc/02.flac"];
  for (const [i, path] of paths.entries()) {
    upsertFile(db, {
      path,
      folder: "Misc",
      size: 1,
      mtimeMs: 1,
      format: "flac",
      durationMs: [181_500, 119_800][i],
      sampleRate: null,
      channels: null,
      bitrateKbps: null,
      tags: {},
      pictures: [],
      readError: null,
      scannedAt: 1,
    });
  }
  return reconcileUnit(db, "Misc", [{
    key: "k",
    folder: "Misc",
    paths,
    hintArtist: null,
    hintAlbum: null,
    hintMbid: null,
    contentHash: "h",
  }], 1)[0];
}

async function setup(client: { evidence(): Promise<YouTubeEvidence> } | null) {
  const db = await memoryDb();
  const queue = new JobQueue(db, { logger: nullLogger, retryBaseMs: 10 });
  registerProposeJob(queue, {
    db,
    mb: {} as never,
    settings: () => ({ genres: "none", maxGenres: 1 }),
    logger: nullLogger,
    youtube: () => Promise.resolve(client),
  });
  return { db, queue, id: seed(db) };
}

Deno.test("a proposal from a YouTube link maps the files by length and can seed MusicBrainz's release editor", async () => {
  const { db, queue, id } = await setup({ evidence: () => Promise.resolve(ALBUM) });
  enqueueYouTubePropose(queue, id, PLAYLIST);
  await queue.drain();
  const p = latestProposal(db, id)!;
  assertEquals([p.releaseMbid, p.sourceUrl, p.chosenBy], [null, PLAYLIST, "user"]);
  const titles = p.fields.filter((f) => f.field === "title").map((f) => f.proposed);
  assertEquals(titles, ["Morning", "Noon"], "each file gets the track of its length");
  assert(p.fields.every((f) => f.origin === "youtube" && f.status === "added"));
  assertEquals(getEvidenceLink(db, id)?.url, PLAYLIST, "kept as evidence for a MusicBrainz release chosen later");

  // The submission is seeded from the stored YouTube release, with the playlist as a free streaming link.
  const merged = mergedFromMatches(providerMatches(db, p.id), "youtube");
  const s = seedFor(merged, { returnUrl: new URL("http://localhost/mb/callback/1"), fetchedAt: 0 });
  assertEquals(s.name, "Ambient Piano Vol.1");
  assertEquals(s["mediums.0.track.1.name"], "Noon");
  const urlKey = Object.keys(s).find((k) => /^urls\.\d+\.url$/.test(k) && s[k] === PLAYLIST);
  assert(urlKey, JSON.stringify(Object.keys(s).filter((k) => k.startsWith("urls"))));
  assert(s.edit_note.includes(`YouTube: ${PLAYLIST}`));
  db.close();
});

Deno.test("without a YouTube key the proposal is refused with what to do", async () => {
  const { db, queue, id } = await setup(null);
  const job = enqueueYouTubePropose(queue, id, PLAYLIST);
  await queue.drain();
  const row = db.prepare("SELECT state, error FROM job WHERE id = ?").get(job.id) as { state: string; error: string };
  assertEquals(row.state, "failed");
  assert(row.error.includes("Settings → Providers"), row.error);
  assertEquals(latestProposal(db, id), undefined);
  db.close();
});

Deno.test("a failed attempt to prepare changes is shown until changes are prepared again", async () => {
  const { makeTestApp, signIn } = await import("../helpers/app.ts");
  const t = await makeTestApp();
  try {
    const { cookie, csrf } = await signIn(t);
    const id = seed(t.db);
    const get = async () =>
      (await (await t.request(`/api/library/releases/${id}/proposal`, { cookie })).json()).proposeError;
    assertEquals(await get(), null);
    const bad = await t.request(`/api/library/releases/${id}/proposal`, {
      method: "POST",
      cookie,
      csrf,
      body: JSON.stringify({ youtubeUrl: "https://music.youtube.com/browse/MPREb_abc" }),
    });
    assertEquals(bad.status, 400, "album pages are not in the Data API");
    const ok = await t.request(`/api/library/releases/${id}/proposal`, {
      method: "POST",
      cookie,
      csrf,
      body: JSON.stringify({ youtubeUrl: PLAYLIST }),
    });
    assertEquals([ok.status, (await ok.json()).kind], [202, "propose"]);
    // The test app has no propose handler: fail the job as a missing key would.
    t.db.prepare("UPDATE job SET state = 'failed', error = 'YouTube needs an API key', finished_at = 5").run();
    assertEquals(await get(), "YouTube needs an API key");
  } finally {
    await t.cleanup();
  }
});
