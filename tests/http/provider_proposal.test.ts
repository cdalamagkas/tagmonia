/** POST …/proposal with a provider link: checked before anything is requested (§10.4, §14.5, D51). */
import { assertEquals } from "@std/assert";
import { reconcileUnit, upsertFile } from "../../server/db/repo/library.ts";
import { saveProposal } from "../../server/db/repo/proposals.ts";
import type { ProposalResponse } from "../../shared/types.ts";
import { PROPOSE_JOB } from "../../server/jobs/propose.ts";
import { makeTestApp, signIn } from "../helpers/app.ts";

Deno.test("provider links: known album pages only, Bandcamp only when switched on", async () => {
  const t = await makeTestApp({
    harmony: {
      providerForUrl: (u) =>
        u.hostname.endsWith("deezer.com") ? "deezer" : u.hostname.endsWith("bandcamp.com") ? "bandcamp" : undefined,
      isReleaseUrl: (u) => u.pathname.startsWith("/album/"),
    },
  });
  try {
    const { cookie, csrf } = await signIn(t);
    const [id] = reconcileUnit(t.db, "A", [{
      key: "k",
      folder: "A",
      paths: [],
      hintArtist: null,
      hintAlbum: null,
      hintMbid: null,
      contentHash: "h",
    }], 1);
    const propose = (providerUrl: string) =>
      t.request(`/api/library/releases/${id}/proposal`, {
        method: "POST",
        cookie,
        csrf,
        body: JSON.stringify({ providerUrl }),
      });
    const error = async (url: string) => {
      const res = await propose(url);
      return [res.status, ((await res.json()) as { error: string }).error];
    };
    assertEquals((await error("not a link"))[0], 400);
    assertEquals((await error("http://www.deezer.com/album/1"))[0], 400, "https only");
    assertEquals((await error("https://intranet.local/album/1"))[0], 400, "unknown hosts never reach a provider");
    assertEquals(await error("https://www.deezer.com/artist/1"), [400, "That Deezer link is not an album page"]);
    assertEquals(await error("https://x.bandcamp.com/album/y"), [
      400,
      "Bandcamp is switched off on the providers page (Settings)",
    ]);
    // Without their credentials, Tidal and Spotify are not registered; their links say what to do (D67).
    assertEquals(await error("https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy"), [
      400,
      "Spotify needs a client ID and secret (Settings → Providers), then a restart",
    ]);
    assertEquals(
      (await error("https://tidal.com/browse/album/1"))[1],
      "Tidal needs a client ID and secret (Settings → Providers), then a restart",
    );
    assertEquals(t.queue.latest(PROPOSE_JOB), undefined, "nothing was queued");

    const ok = await propose("https://www.deezer.com/album/302127");
    assertEquals(ok.status, 202);
    assertEquals(t.queue.latest(PROPOSE_JOB)?.payload, {
      candidateId: id,
      providerUrl: "https://www.deezer.com/album/302127",
      chosenBy: "user",
    });
    // The switch applies at once (D46).
    t.queue.cancel(t.queue.latest(PROPOSE_JOB)!.id);
    t.ctx.settings.providers.bandcamp.enabled = true;
    assertEquals((await propose("https://x.bandcamp.com/album/y")).status, 202);
  } finally {
    await t.cleanup();
  }
});

Deno.test("a provider proposal: its own provider is the primary source; only other providers count as filled", async () => {
  const t = await makeTestApp({
    harmony: {
      providerForUrl: (u) => (u.hostname.endsWith("deezer.com") ? "deezer" : undefined),
      isReleaseUrl: () => true,
    },
  });
  try {
    const { cookie } = await signIn(t);
    upsertFile(t.db, {
      path: "A/01.flac",
      folder: "A",
      size: 1,
      mtimeMs: 1,
      format: "flac",
      durationMs: 1000,
      sampleRate: null,
      channels: null,
      bitrateKbps: null,
      tags: {},
      pictures: [],
      readError: null,
      scannedAt: 1,
    });
    const [id] = reconcileUnit(t.db, "A", [{
      key: "k",
      folder: "A",
      paths: ["A/01.flac"],
      hintArtist: null,
      hintAlbum: null,
      hintMbid: null,
      contentHash: "h",
    }], 1);
    const fileId = (t.db.prepare("SELECT id FROM library_file").get() as { id: number }).id;
    const row = (field: "album" | "isrc", origin: "deezer" | "itunes") => ({
      fileId,
      field,
      current: null,
      proposed: field === "album" ? "X" : ["ITX000000001"],
      status: "added" as const,
      locked: false,
      sources: [],
      origin,
      conflict: false,
    });
    saveProposal(t.db, {
      candidateId: id,
      releaseMbid: null,
      sourceUrl: "https://www.deezer.com/album/1",
      chosenBy: "user",
      basedOnHash: "h",
      snapshotIds: [],
      build: { fields: [row("album", "deezer"), row("isrc", "itunes")], unmappedFiles: [] },
    }, 1);
    const p = ((await (await t.request(`/api/library/releases/${id}/proposal`, { cookie })).json()) as ProposalResponse)
      .proposal!;
    assertEquals([p.releaseMbid, p.sourceUrl, p.primarySource, p.counts.filled], [
      null,
      "https://www.deezer.com/album/1",
      "deezer",
      1,
    ]);
  } finally {
    await t.cleanup();
  }
});
