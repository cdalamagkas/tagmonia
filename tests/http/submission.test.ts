/** Submitting a release missing from MusicBrainz, through the API with a fake MusicBrainz (§12, D52). */
import { assert, assertEquals } from "@std/assert";
import { reconcileUnit } from "../../server/db/repo/library.ts";
import { saveProposal, saveProviderMatches } from "../../server/db/repo/proposals.ts";
import { createSubmission, getSubmission } from "../../server/db/repo/submissions.ts";
import { registerFollowUpJob, registerSubmissionJobs } from "../../server/jobs/submission.ts";
import { nullLogger } from "../../server/log.ts";
import type { SubmissionDto, SubmissionOpenResponse } from "../../shared/types.ts";
import { makeTestApp, signIn, type TestApp } from "../helpers/app.ts";
import { BEETHOVEN_5, loadRelease } from "../identify/helpers.ts";
import { MATCHES } from "../submission/helpers.ts";

const NEW = "6f0e1c47-0000-4000-8000-00000000abcd";
const ARTIST = "a1a1a1a1-0000-4000-8000-000000000001";
const SUGGESTED = "b2b2b2b2-0000-4000-8000-000000000002";
const known = await loadRelease(BEETHOVEN_5);
/** Whether the fake MusicBrainz has cover art and the ISRCs (by track) for the new release (D65). */
const onServer = { cover: false, isrcs: [] as string[] };

/** The fake server's fresh lookup: the new release, with or without its cover art and ISRCs. */
function fresh(mbid: string) {
  if (mbid !== NEW) return Promise.resolve(null);
  const media = known.media.map((m, i) =>
    i > 0 ? m : {
      ...m,
      tracks: m.tracks!.map((tr, j) => ({
        ...tr,
        recording: { ...tr.recording, isrcs: onServer.isrcs[j] ? [onServer.isrcs[j]] : [] },
      })),
    }
  );
  return Promise.resolve({
    value: { ...known, id: NEW, "cover-art-archive": { front: onServer.cover }, media },
    snapshotId: 1,
  });
}

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

async function withApp(
  fn: (t: TestApp, s: { cookie: string; csrf: string }, returned: string[]) => Promise<void>,
  opts: { artistLinked?: boolean } = {},
) {
  const t = await makeTestApp();
  const returned: string[] = [];
  registerSubmissionJobs(t.queue, {
    db: t.db,
    client: () => ({
      searchReleases: () => Promise.resolve({ value: [], snapshotId: 0 }),
      releasesForUrl: () => Promise.resolve({ value: [], snapshotId: 0 }),
      lookupReleaseFresh: fresh,
      // The artist's Deezer page is linked on MusicBrainz only when the test says so.
      artistsForUrl: (url: string) =>
        Promise.resolve({
          value: opts.artistLinked !== false && url === "https://www.deezer.com/artist/9"
            ? [{ id: ARTIST, name: "Niklas Blumenthaler" }]
            : [],
          snapshotId: 0,
        }),
      lookupArtist: (mbid: string) => Promise.resolve({ id: mbid, name: "x" }),
      searchArtists: () =>
        Promise.resolve({
          value: [
            // Not the exact name, so offered rather than linked.
            { id: SUGGESTED, name: "N. Blumenthaler", score: 95, disambiguation: "pianist" },
            { id: "c3", name: "Nicklas Blum", score: 40 },
          ],
          snapshotId: 0,
        }),
    }),
    providerOf: (u) => (u.hostname.endsWith("deezer.com") ? "deezer" : undefined),
    artistLinks: (
      a,
    ) => (a.name === "Niklas Blumenthaler" ? [{ url: "https://www.deezer.com/artist/9", linkTypeIds: [194] }] : []),
    onReturned: (candidateId, mbid, server) => returned.push(`${candidateId} ${mbid} ${server}`),
    logger: nullLogger,
  });
  registerFollowUpJob(t.queue, {
    db: t.db,
    client: () => ({ lookupReleaseFresh: fresh }) as never,
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
    assertEquals(s.artists.map((a) => [a.name, a.mbid, a.via, a.createUrl]), [[
      "Niklas Blumenthaler",
      ARTIST,
      "link",
      null,
    ]]);

    const open = await post(`/api/submissions/${id}/open`);
    const form = (await open.json()) as SubmissionOpenResponse;
    assertEquals(form.action, "https://musicbrainz.org/release/add");
    assertEquals(form.fields.name, "Ambient Piano Vol.1");
    // §12.3: the found artist is linked in the editor by its MBID, not left as a name to resolve.
    assertEquals(form.fields["artist_credit.names.0.mbid"], ARTIST);
    assertEquals(form.fields["artist_credit.names.0.artist.name"], undefined);
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

    // Follow-ups (D65): looked up at the return, and again on request once they are added on MusicBrainz.
    assertEquals([s.followUps!.coverArtAdded, s.followUps!.isrcsAdded], [false, false]);
    onServer.cover = true;
    onServer.isrcs = getSubmission(t.db, id)!.isrcs;
    const checked = await post(`/api/submissions/${id}/follow-ups/check`);
    assertEquals([checked.status, ((await checked.json()) as SubmissionDto).followUps!.checking], [202, true]);
    assertEquals((await latest()).followUps!.checking, true, "the page polls meanwhile");
    await t.queue.drain();
    s = await latest();
    assertEquals([s.followUps!.coverArtAdded, s.followUps!.isrcsAdded, s.followUps!.checking], [true, true, false]);
    onServer.cover = false;
    onServer.isrcs = [];
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

Deno.test("an artist MusicBrainz lacks: an Add artist link and suggestions; a chosen one is linked after a re-check", () =>
  withApp(async (t, { cookie, csrf }) => {
    const { candidateId, proposalId } = seed(t);
    const post = (path: string, body?: unknown) =>
      t.request(path, { method: "POST", cookie, csrf, body: body === undefined ? undefined : JSON.stringify(body) });
    const latest = async () =>
      ((await (await t.request(`/api/library/releases/${candidateId}/submission`, { cookie })).json()) as {
        submission: SubmissionDto;
      }).submission;
    const { id } = (await (await post(`/api/proposals/${proposalId}/submission`)).json()) as SubmissionDto;
    await t.queue.drain();
    let [artist] = (await latest()).artists;
    assertEquals([artist.mbid, artist.via], [null, null]);
    assertEquals(
      artist.suggestions.map((g) => [g.mbid, g.disambiguation]),
      [[SUGGESTED, "pianist"]],
      "weak matches dropped",
    );
    const create = new URL(artist.createUrl!);
    assertEquals(create.origin + create.pathname, "https://musicbrainz.org/artist/create");
    assertEquals(create.searchParams.get("edit-artist.name"), "Niklas Blumenthaler");
    assertEquals(create.searchParams.get("edit-artist.url.0.text"), "https://www.deezer.com/artist/9");
    assertEquals(create.searchParams.get("edit-artist.url.0.link_type_id"), "194");

    assertEquals(
      (await post(`/api/submissions/${id}/artists`, { name: "Someone Else", artist: SUGGESTED })).status,
      400,
    );
    assertEquals((await post(`/api/submissions/${id}/artists`, { name: artist.name, artist: "no id" })).status, 400);
    const chose = await post(`/api/submissions/${id}/artists`, {
      name: artist.name,
      artist: `https://musicbrainz.org/artist/${SUGGESTED}`,
    });
    assertEquals([chose.status, ((await chose.json()) as SubmissionDto).state], [202, "checking"]);
    await t.queue.drain();
    [artist] = (await latest()).artists;
    assertEquals([artist.mbid, artist.via, artist.createUrl], [SUGGESTED, "chosen", null]);
    // Matched by hand: offered the artist's edit form with its Deezer page, so future releases find it.
    const addLinks = new URL(artist.addLinksUrl!);
    assertEquals(addLinks.pathname, `/artist/${SUGGESTED}/edit`);
    assertEquals(addLinks.searchParams.get("edit-artist.url.0.text"), "https://www.deezer.com/artist/9");
    const form = (await (await post(`/api/submissions/${id}/open`)).json()) as SubmissionOpenResponse;
    assertEquals(form.fields["artist_credit.names.0.mbid"], SUGGESTED);

    // "Not this artist": the choice is replaced by a rejection; the artist is unlinked again.
    assertEquals((await post(`/api/submissions/${id}/artists`, { name: artist.name, artist: "none" })).status, 202);
    await t.queue.drain();
    [artist] = (await latest()).artists;
    assertEquals([artist.mbid, artist.via], [null, null]);
    await post(`/api/submissions/${id}/open`);

    // Re-checking keeps working after the editor was opened (e.g. once the artist was added there).
    assertEquals((await post(`/api/submissions/${id}/recheck`)).status, 202);
    await t.queue.drain();
    assertEquals((await latest()).state, "ready");
  }, { artistLinked: false }));
