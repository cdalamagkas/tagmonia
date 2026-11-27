/** GET /api/library/releases/:id/identification and POST …/identify (Phase 2 part 5b). */
import { assert, assertEquals } from "@std/assert";
import { reconcileUnit, upsertFile } from "../../server/db/repo/library.ts";
import { saveIdentifyResult } from "../../server/db/repo/matches.ts";
import { identify } from "../../server/identify/identify.ts";
import { buildEvidence } from "../../server/jobs/identify.ts";
import { getRelease } from "../../server/db/repo/library.ts";
import type { IdentificationDto, JobDto } from "../../shared/types.ts";
import { makeTestApp, signIn, type TestApp } from "../helpers/app.ts";
import { BEETHOVEN_5, FakeMb, loadRelease, variant } from "../identify/helpers.ts";

const release = await loadRelease(BEETHOVEN_5);
const CD = "00000000-0000-4000-8000-0000000000cd";

/** A candidate holding a tagged rip of the recorded release, identified against a fake MusicBrainz. */
async function seedIdentified(t: TestApp): Promise<number> {
  for (const id of [1, 2]) {
    t.db.prepare(
      "INSERT INTO snapshot (id, provider, request_key, status, fetched_at, body_path, size) VALUES (?, 'musicbrainz', ?, 200, 0, 'x', 0)",
    ).run(id, `k${id}`);
  }
  const paths: string[] = [];
  for (const tr of release.media[0].tracks!) {
    const path = `Karajan/0${tr.position}.flac`;
    paths.push(path);
    upsertFile(t.db, {
      path,
      folder: "Karajan",
      size: 1,
      mtimeMs: 1,
      format: "flac",
      durationMs: tr.length! + 700,
      sampleRate: null,
      channels: null,
      bitrateKbps: null,
      tags: {
        title: tr.title,
        tracknumber: tr.position,
        album: release.title,
        albumartist: "Beethoven; Berlin Philharmonic Orchestra, Herbert von Karajan",
      },
      pictures: [],
      readError: null,
      scannedAt: 1,
    });
  }
  const [id] = reconcileUnit(t.db, "Karajan", [{
    key: "k",
    folder: "Karajan",
    paths,
    hintArtist: null,
    hintAlbum: release.title,
    hintMbid: null,
    contentHash: "h1",
  }], 1);
  const cd = variant(release, CD, { format: "CD", country: "DE" });
  const mb = new FakeMb([release]);
  mb.search = () => [release];
  mb.browse = () => [release, cd];
  const found = getRelease(t.db, id)!;
  const result = await identify(buildEvidence(null, found.files), mb, "Karajan");
  saveIdentifyResult(t.db, id, "h1", result, 5000);
  return id;
}

async function withApp(fn: (t: TestApp, s: { cookie: string; csrf: string }) => Promise<void>) {
  const t = await makeTestApp();
  try {
    await fn(t, await signIn(t));
  } finally {
    await t.cleanup();
  }
}

Deno.test("identification lists matches and an edition picker with examined and unexamined editions", () =>
  withApp(async (t, { cookie }) => {
    const id = await seedIdentified(t);
    const res = await t.request(`/api/library/releases/${id}/identification`, { cookie });
    assertEquals(res.status, 200);
    const body: IdentificationDto = await res.json();
    assertEquals(body.status, "needs_review");
    assertEquals([body.identifiedAt, body.stale, body.error, body.job], [5000, false, null, null]);
    assertEquals(body.thresholds, { auto: 0.92, review: 0.70 });
    assertEquals(body.matches[0].releaseMbid, BEETHOVEN_5);
    assertEquals(body.matches[0].mapping.pairs.length, 4);
    assertEquals(body.matches[0].pinned, false);
    assert(!("snapshotId" in body.matches[0]), "snapshot ids are internal");
    assertEquals(
      body.editions.map((e) => [e.releaseMbid, e.examined, e.summary.format, e.score === null]),
      [[BEETHOVEN_5, true, '12" Vinyl', false], [CD, false, "CD", true]],
    );
  }));

Deno.test("a rescan that changes the files marks the identification stale", () =>
  withApp(async (t, { cookie }) => {
    const id = await seedIdentified(t);
    t.db.prepare("UPDATE candidate SET content_hash = 'h2' WHERE id = ?").run(id);
    const body: IdentificationDto = await (await t.request(`/api/library/releases/${id}/identification`, { cookie }))
      .json();
    assertEquals(body.stale, true);
  }));

Deno.test("re-identify queues one job per release and shows it while live; it needs CSRF", () =>
  withApp(async (t, { cookie, csrf }) => {
    const id = await seedIdentified(t);
    const path = `/api/library/releases/${id}/identify`;
    assertEquals((await t.request(path, { method: "POST", cookie })).status, 403);
    const a: JobDto = await (await t.request(path, { method: "POST", cookie, csrf })).json();
    const b: JobDto = await (await t.request(path, { method: "POST", cookie, csrf })).json();
    assertEquals([a.kind, a.state, a.id], ["identify", "queued", b.id]);
    const body: IdentificationDto = await (await t.request(`/api/library/releases/${id}/identification`, { cookie }))
      .json();
    assertEquals(body.job?.id, a.id);
  }));

Deno.test("identification of an unknown release is 404", () =>
  withApp(async (t, { cookie, csrf }) => {
    assertEquals((await t.request("/api/library/releases/999/identification", { cookie })).status, 404);
    assertEquals((await t.request("/api/library/releases/999/identify", { method: "POST", cookie, csrf })).status, 404);
  }));

Deno.test("a pasted MusicBrainz link queues a manual identification; other links are refused", () =>
  withApp(async (t, { cookie, csrf }) => {
    const id = await seedIdentified(t);
    const path = `/api/library/releases/${id}/identify`;
    const post = (body: unknown) => t.request(path, { method: "POST", cookie, csrf, body: JSON.stringify(body) });
    assertEquals((await post({ releaseUrl: "https://www.discogs.com/release/1" })).status, 400);
    assertEquals((await post({ releaseUrl: 42 })).status, 400);
    const res = await post({ releaseUrl: `https://musicbrainz.org/release/${CD}` });
    assertEquals(res.status, 202);
    const job: JobDto = await res.json();
    const stored = t.queue.get(job.id)!;
    assertEquals(stored.payload, { candidateId: id, releaseMbid: CD });
    // While that job is live, another choice is refused rather than silently dropped.
    assertEquals((await post({ releaseUrl: `https://musicbrainz.org/release/${BEETHOVEN_5}` })).status, 409);
  }));

Deno.test("proposal API: none at first, a user pick queues a job, invalid ids and busy releases refused", () =>
  withApp(async (t, { cookie, csrf }) => {
    const id = await seedIdentified(t);
    const get = async () => await (await t.request(`/api/library/releases/${id}/proposal`, { cookie })).json();
    assertEquals(await get(), {
      proposal: null,
      job: null,
      readOnly: false,
      locks: [],
      evidence: null,
      destination: null,
      proposeError: null,
    });
    const post = (body: unknown) =>
      t.request(`/api/library/releases/${id}/proposal`, { method: "POST", cookie, csrf, body: JSON.stringify(body) });
    assertEquals((await post({ releaseMbid: "not-an-mbid" })).status, 400);
    const res = await post({ releaseMbid: CD });
    assertEquals(res.status, 202);
    const job: JobDto = await res.json();
    assertEquals(t.queue.get(job.id)!.payload, { candidateId: id, releaseMbid: CD, chosenBy: "user" });
    assertEquals((await get()).job.id, job.id);
    assertEquals((await post({ releaseMbid: BEETHOVEN_5 })).status, 409);
    assertEquals((await t.request("/api/library/releases/999/proposal", { cookie })).status, 404);
  }));
