/** A YouTube link as evidence for a release (§9.5, D55): checked, stored, and the proposal built again. */
import { assertEquals } from "@std/assert";
import { reconcileUnit } from "../../server/db/repo/library.ts";
import { providerMatches, saveProposal, saveProviderMatches } from "../../server/db/repo/proposals.ts";
import { setEvidenceLink } from "../../server/db/repo/evidence.ts";
import { evidenceMatch, PROPOSE_JOB } from "../../server/jobs/propose.ts";
import { createLogger } from "../../server/log.ts";
import type { YouTubeEvidence } from "../../server/providers/youtube.ts";
import type { EvidenceResponse, ProposalResponse } from "../../shared/types.ts";
import { makeTestApp, signIn } from "../helpers/app.ts";

const PLAYLIST = "https://www.youtube.com/playlist?list=OLAK5uy_test0001";

function release(t: Awaited<ReturnType<typeof makeTestApp>>) {
  const [id] = reconcileUnit(t.db, "A", [{
    key: "k",
    folder: "A",
    paths: [],
    hintArtist: null,
    hintAlbum: null,
    hintMbid: null,
    contentHash: "h",
  }], 1);
  return id;
}

Deno.test("evidence API: YouTube links only, stored canonical; with a proposal, it is built again", async () => {
  const t = await makeTestApp();
  try {
    const { cookie, csrf } = await signIn(t);
    const id = release(t);
    const put = (url: string) =>
      t.request(`/api/library/releases/${id}/evidence`, { method: "PUT", cookie, csrf, body: JSON.stringify({ url }) });
    const get = async () =>
      ((await (await t.request(`/api/library/releases/${id}/proposal`, { cookie })).json()) as ProposalResponse)
        .evidence;

    assertEquals((await put("https://www.deezer.com/album/1")).status, 400);
    assertEquals((await put("http://www.youtube.com/playlist?list=OLAK5uy_test0001")).status, 400);
    assertEquals((await put("not a link")).status, 400);
    assertEquals(
      (await t.request(`/api/library/releases/999/evidence`, {
        method: "PUT",
        cookie,
        csrf,
        body: JSON.stringify({ url: PLAYLIST }),
      })).status,
      404,
    );

    // No proposal yet: kept for when there is one.
    const first = await put("https://music.youtube.com/watch?v=jNQXAC9IVRw&list=OLAK5uy_test0001");
    assertEquals(await first.json() as EvidenceResponse, {
      evidence: { provider: "youtube", url: PLAYLIST },
      job: null,
    });
    assertEquals(await get(), { provider: "youtube", url: PLAYLIST });

    saveProposal(t.db, {
      candidateId: id,
      releaseMbid: null,
      sourceUrl: "https://www.deezer.com/album/1",
      chosenBy: "user",
      basedOnHash: "h",
      snapshotIds: [],
      build: { fields: [], unmappedFiles: [] },
    }, 1);
    const again = (await (await put("https://youtu.be/jNQXAC9IVRw")).json()) as EvidenceResponse;
    assertEquals(again.evidence?.url, "https://www.youtube.com/watch?v=jNQXAC9IVRw");
    assertEquals(t.queue.latest(PROPOSE_JOB)?.payload, {
      candidateId: id,
      providerUrl: "https://www.deezer.com/album/1",
      chosenBy: "user",
    });
    t.queue.cancel(again.job!.id);

    const del = () => t.request(`/api/library/releases/${id}/evidence`, { method: "DELETE", cookie, csrf });
    assertEquals((await del()).status, 200);
    assertEquals(await get(), null);
    assertEquals((await del()).status, 404);
  } finally {
    await t.cleanup();
  }
});

Deno.test("the propose job's YouTube row: skipped without a key, an error kept, found when the count fits", async () => {
  const t = await makeTestApp();
  try {
    const id = release(t);
    const ev: YouTubeEvidence = {
      kind: "playlist",
      url: PLAYLIST,
      title: null,
      channel: null,
      tracks: [{ videoId: "v", title: "t", durationMs: 1, name: null, artists: [] }],
      label: "LKult",
      date: "2021",
      album: null,
      providedBy: null,
    };
    const deps = (youtube: (() => Promise<{ evidence(): Promise<YouTubeEvidence> } | null>) | undefined) => ({
      db: t.db,
      mb: {} as never,
      settings: () => ({ genres: "none" as const, maxGenres: 1 }),
      logger: createLogger("error"),
      youtube,
    });
    assertEquals(await evidenceMatch(deps(undefined), id, 1), null, "no link, no row");
    setEvidenceLink(t.db, id, { provider: "youtube", url: PLAYLIST }, 1);
    assertEquals((await evidenceMatch(deps(() => Promise.resolve(null)), id, 1))?.status, "skipped");
    const failing = await evidenceMatch(
      deps(() => Promise.resolve({ evidence: () => Promise.reject(new Error("quota used up")) })),
      id,
      1,
    );
    assertEquals([failing?.status, failing?.reason], ["error", "quota used up"]);
    const found = await evidenceMatch(deps(() => Promise.resolve({ evidence: () => Promise.resolve(ev) })), id, 1);
    assertEquals([found?.status, found?.evidence?.label], ["found", "LKult"]);

    // Stored with the proposal and read back as evidence, not as a Harmony release.
    const pid = saveProposal(t.db, {
      candidateId: id,
      releaseMbid: null,
      sourceUrl: "https://www.deezer.com/album/1",
      chosenBy: "user",
      basedOnHash: "h",
      snapshotIds: [],
      build: { fields: [], unmappedFiles: [] },
    }, 1);
    saveProviderMatches(t.db, pid, [found!], 1);
    const [row] = providerMatches(t.db, pid);
    assertEquals([row.provider, row.release, row.evidence?.date], ["youtube", null, "2021"]);
  } finally {
    await t.cleanup();
  }
});
