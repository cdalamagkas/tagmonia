/** Search terms (D63): identification searches with them; when nothing fits, they become the tags. */
import { assert, assertEquals } from "@std/assert";
import type { Db } from "../../server/db/db.ts";
import { reconcileUnit, upsertFile } from "../../server/db/repo/library.ts";
import { latestProposal } from "../../server/db/repo/proposals.ts";
import { setSearchTerms } from "../../server/db/repo/search_terms.ts";
import { enqueueIdentify, registerIdentifyJob } from "../../server/jobs/identify.ts";
import { enqueueSearchTermsPropose, registerProposeJob } from "../../server/jobs/propose.ts";
import { JobQueue } from "../../server/jobs/queue.ts";
import { DEFAULT_IDENTIFY } from "../../server/identify/identify.ts";
import { nullLogger } from "../../server/log.ts";
import { memoryDb } from "../helpers/app.ts";
import { FakeMb } from "../identify/helpers.ts";

function seed(db: Db, files: { name: string; tags: Record<string, unknown> }[]): number {
  const paths = files.map((f) => `Misc/${f.name}`);
  for (const [i, f] of files.entries()) {
    upsertFile(db, {
      path: paths[i],
      folder: "Misc",
      size: 1,
      mtimeMs: 1,
      format: "flac",
      durationMs: 200_000,
      sampleRate: null,
      channels: null,
      bitrateKbps: null,
      tags: f.tags,
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

async function setup(files: { name: string; tags: Record<string, unknown> }[]) {
  const db = await memoryDb();
  db.prepare(
    "INSERT INTO snapshot (id, provider, request_key, status, fetched_at, body_path, size) VALUES (1, 'musicbrainz', 'k1', 200, 0, 'x', 0)",
  ).run();
  const mb = new FakeMb([]);
  const queue = new JobQueue(db, { logger: nullLogger, retryBaseMs: 10 });
  registerIdentifyJob(queue, { db, mb, config: () => DEFAULT_IDENTIFY, logger: nullLogger });
  registerProposeJob(queue, { db, mb, settings: () => ({ genres: "musicbrainz", maxGenres: 5 }), logger: nullLogger });
  return { db, mb, queue, id: seed(db, files) };
}

const searches = (mb: FakeMb) => mb.calls.filter((c) => c.startsWith("search ")).map((c) => JSON.parse(c.slice(7)));

Deno.test("a single file is searched by its title, not its folder's name", async () => {
  const { db, mb, queue, id } = await setup([{
    name: "x.flac",
    tags: { title: "Cornfield Chase", artist: "Hans Zimmer" },
  }]);
  enqueueIdentify(queue, [id]);
  await queue.drain();
  assertEquals(searches(mb)[0], { release: "Cornfield Chase", artist: "Hans Zimmer", tracks: 1 });
  assert(!mb.calls.some((c) => c.includes("Misc")), "the folder is not an album name");
  db.close();
});

Deno.test("search terms replace the files' album and artist, and a single's title", async () => {
  const { db, mb, queue, id } = await setup([{ name: "track01.flac", tags: {} }]);
  setSearchTerms(db, id, { artist: "Hans Zimmer", album: "Interstellar", title: "Day One" });
  enqueueIdentify(queue, [id]);
  await queue.drain();
  assertEquals(searches(mb)[0], { release: "Interstellar", artist: "Hans Zimmer", tracks: 1 });
  db.close();
});

Deno.test("terms as tags: album and album artist for every file, artist where missing, a single's title", async () => {
  {
    const { db, queue, id } = await setup([
      { name: "a.flac", tags: { artist: "Someone" } },
      { name: "b.flac", tags: {} },
    ]);
    setSearchTerms(db, id, { artist: "Hans Zimmer", album: "Interstellar", title: "ignored for two files" });
    enqueueSearchTermsPropose(queue, id);
    await queue.drain();
    const p = latestProposal(db, id)!;
    assertEquals([p.releaseMbid, p.sourceUrl, p.chosenBy], [null, null, "user"]);
    const rows = p.fields.map((f) => [f.fileId, f.field, f.proposed, f.status, f.origin]).sort();
    const [a, b] = p.fields.map((f) => f.fileId).filter((v, i, xs) => xs.indexOf(v) === i).sort();
    assertEquals(
      rows,
      [
        [a, "album", "Interstellar", "added", "user"],
        [a, "albumartist", "Hans Zimmer", "added", "user"],
        [b, "album", "Interstellar", "added", "user"],
        [b, "albumartist", "Hans Zimmer", "added", "user"],
        [b, "artist", "Hans Zimmer", "added", "user"],
      ].sort(),
    );
    db.close();
  }
  {
    const { db, queue, id } = await setup([{ name: "x.flac", tags: { title: "track 1" } }]);
    setSearchTerms(db, id, { title: "Day One" });
    enqueueSearchTermsPropose(queue, id);
    await queue.drain();
    assertEquals(
      latestProposal(db, id)!.fields.map((f) => [f.field, f.current, f.proposed, f.status]),
      [["title", "track 1", "Day One", "changed"]],
    );
    db.close();
  }
});
