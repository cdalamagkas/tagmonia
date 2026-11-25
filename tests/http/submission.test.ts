/** Submitting a release missing from MusicBrainz, through the API with a fake MusicBrainz (§12, D52). */
import { assert, assertEquals } from "@std/assert";
import { reconcileUnit } from "../../server/db/repo/library.ts";
import { saveProposal, saveProviderMatches } from "../../server/db/repo/proposals.ts";
import { createSubmission } from "../../server/db/repo/submissions.ts";
import { registerSubmissionJobs } from "../../server/jobs/submission.ts";
import { nullLogger } from "../../server/log.ts";
import type { SubmissionDto, SubmissionOpenResponse } from "../../shared/types.ts";
import { makeTestApp, signIn, type TestApp } from "../helpers/app.ts";
import { BEETHOVEN_5, loadRelease } from "../identify/helpers.ts";
import { MATCHES } from "../submission/helpers.ts";

const NEW = "6f0e1c47-0000-4000-8000-00000000abcd";
const known = await loadRelease(BEETHOVEN_5);

function seed(t: TestApp, opts: { releaseMbid?: string; folder?: string } = {}) {
  const folder = opts.folder ?? "A";
  const [candidateId] = reconcileUnit(t.db, folder, [{
    key: folder,
    folder,
    paths: [],
    hintArtist: null,
    hintAlbum: null,
    hintMbid: null,
    contentHash: "h",
  }], 1);
  const proposalId = saveProposal(t.db, {
    candidateId,
    releaseMbid: opts.releaseMbid ?? null,
    sourceUrl: opts.releaseMbid ? null : "https://www.deezer.com/album/1",
    chosenBy: "user",
    basedOnHash: "h",
    snapshotIds: [],
    build: { fields: [], unmappedFiles: [] },
  }, 1);
  saveProviderMatches(t.db, proposalId, MATCHES, 2);
  return { candidateId, proposalId };
}

async function withApp(fn: (t: TestApp, s: { cookie: string; csrf: string }, returned: string[]) => Promise<void>) {
  const t = await makeTestApp();
  const returned: string[] = [];
  registerSubmissionJobs(t.queue, {
    db: t.db,
    client: () => ({
      searchReleases: () => Promise.resolve({ value: [], snapshotId: 0 }),
      releasesForUrl: () => Promise.resolve({ value: [], snapshotId: 0 }),
      lookupReleaseFresh: (mbid: string) =>
        Promise.resolve(mbid === NEW ? { value: { ...known, id: NEW }, snapshotId: 1 } : null),
    }),
    providerOf: (u) => (u.hostname.endsWith("deezer.com") ? "deezer" : undefined),
    onReturned: (candidateId, mbid, server) => returned.push(`${candidateId} ${mbid} ${server}`),
    logger: nullLogger,
  });
  try {
    await fn(t, await signIn(t), returned);
  } finally {
    await t.cleanup();
  }
}

Deno.test("prepare, open the editor, come back: verified with MusicBrainz, then follow-ups", () =>
  withApp(async (t, { cookie, csrf }, returned) => {
    const { candidateId, proposalId } = seed(t);
    const post = (path: string, body?: unknown) =>
      t.request(path, { method: "POST", cookie, csrf, body: body === undefined ? undefined : JSON.stringify(body) });
    const latest = async () =>
      ((await (await t.request(`/api/library/releases/${candidateId}/submission`, { cookie })).json()) as {
        submission: SubmissionDto;
      }).submission;

    const prepared = await post(`/api/proposals/${proposalId}/submission`);
    assertEquals(prepared.status, 202);
    const { id } = (await prepared.json()) as SubmissionDto;
    assertEquals((await post(`/api/submissions/${id}/callback`, { release: NEW })).status, 409, "not opened yet");
    await t.queue.drain();
    let s = await latest();
    assertEquals([s.state, s.server, s.duplicates], ["ready", "https://musicbrainz.org", []]);

    const open = await post(`/api/submissions/${id}/open`);
    const form = (await open.json()) as SubmissionOpenResponse;
    assertEquals(form.action, "https://musicbrainz.org/release/add");
    assertEquals(form.fields.name, "Ambient Piano Vol.1");
    // Back to Tagmonia's own origin; the submission id is in the path, Harmony's lookup details in the query.
    const back0 = new URL(form.fields.redirect_uri);
    assertEquals([back0.origin, back0.pathname], ["http://tagmonia.test", `/mb/callback/${id}`]);
    assert(form.fields.edit_note.startsWith("Imported with Tagmonia"));

    assertEquals((await post(`/api/submissions/${id}/callback`, { release: "nothing here" })).status, 400);
    // A pasted link works as well as MusicBrainz's redirect.
    const back = await post(`/api/submissions/${id}/callback`, { release: `https://musicbrainz.org/release/${NEW}` });
    assertEquals([back.status, ((await back.json()) as SubmissionDto).state], [202, "verifying"]);
    await t.queue.drain();
    s = await latest();
    assertEquals([s.state, s.releaseMbid], ["returned", NEW]);
    assertEquals(returned, [`${candidateId} ${NEW} https://musicbrainz.org`]);
    assertEquals(s.followUps!.addCoverArt, `https://musicbrainz.org/release/${NEW}/add-cover-art`);
    const isrc = new URL(s.followUps!.isrcs!);
    assertEquals([isrc.host, isrc.searchParams.get("isrc1"), isrc.searchParams.get("musicbrainzid")], [
      "magicisrc.kepstin.ca",
      "QMFME2130070",
      NEW,
    ]);
    // The same answer again (a reload of the callback page) is accepted, not re-verified.
    assertEquals((await post(`/api/submissions/${id}/callback`, { release: NEW })).status, 200);
  }));

Deno.test("an MBID MusicBrainz does not have is not trusted; the submission waits for another try", () =>
  withApp(async (t, { cookie, csrf }, returned) => {
    const { proposalId } = seed(t);
    const post = (path: string, body?: unknown) =>
      t.request(path, { method: "POST", cookie, csrf, body: body === undefined ? undefined : JSON.stringify(body) });
    const { id } = (await (await post(`/api/proposals/${proposalId}/submission`)).json()) as SubmissionDto;
    await t.queue.drain();
    await post(`/api/submissions/${id}/open`);
    await post(`/api/submissions/${id}/callback`, { release: "00000000-0000-4000-8000-000000000000" });
    await t.queue.drain();
    const s = ((await (await t.request(`/api/library/releases/1/submission`, { cookie })).json()) as {
      submission: SubmissionDto;
    }).submission;
    assertEquals([s.state, s.error], ["seeded", "musicbrainz.org has no release 00000000-0000-4000-8000-000000000000"]);
    assertEquals(returned, []);
  }));

Deno.test("only releases missing from MusicBrainz, the test server when chosen, and only your own submissions", () =>
  withApp(async (t, { cookie, csrf }) => {
    const mb = seed(t, { releaseMbid: BEETHOVEN_5 });
    const post = (path: string) => t.request(path, { method: "POST", cookie, csrf });
    assertEquals((await post(`/api/proposals/${mb.proposalId}/submission`)).status, 409);

    const { proposalId, candidateId } = seed(t, { folder: "B" });
    t.ctx.settings.submission.server = "https://test.musicbrainz.org";
    const s = (await (await post(`/api/proposals/${proposalId}/submission`)).json()) as SubmissionDto;
    assertEquals(s.server, "https://test.musicbrainz.org");
    await t.queue.drain();
    assertEquals(
      ((await (await post(`/api/submissions/${s.id}/open`)).json()) as SubmissionOpenResponse).action,
      "https://test.musicbrainz.org/release/add",
    );

    const other = Number(
      (t.db.prepare("INSERT INTO app_user (username, password_hash, created_at) VALUES ('other', 'x', 1) RETURNING id")
        .get() as { id: number }).id,
    );
    const theirs = createSubmission(t.db, {
      candidateId,
      proposalId,
      userId: other,
      server: "https://musicbrainz.org",
      returnBase: "http://x",
    }, 5);
    assertEquals((await post(`/api/submissions/${theirs.id}/open`)).status, 404);
    const latest = await (await t.request(`/api/library/releases/${candidateId}/submission`, { cookie })).json();
    assertEquals(latest, { submission: null }, "someone else's latest submission is not shown");
  }));
