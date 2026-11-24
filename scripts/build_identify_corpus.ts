/**
 * Builds and records the labelled identification corpus (D26, D33, D38).
 *
 *   scripts/dk deno run --allow-net --allow-read --allow-write --allow-env --allow-run=python3,fpcalc \
 *     scripts/build_identify_corpus.ts [--only <slug>]
 *
 * 1. Each entry in tests/identify/corpus/sources.json without a pinned release
 *    is resolved by a MusicBrainz search and pinned in manifest.json, so the
 *    corpus never drifts when MusicBrainz changes.
 * 2. Every case runs through the real identifier. Responses already recorded
 *    are served from tests/fixtures/snaps/; only missing ones go to the live
 *    API, through Tagmonia's client (User-Agent, 1 req/s, Retry-After). Re-run
 *    it after changing identification code: it records only what is new.
 */
import { dirname } from "node:path";
import { openMigratedDb } from "../server/db/db.ts";
import { DEFAULT_IDENTIFY } from "../server/identify/identify.ts";
import { similarity } from "../server/identify/normalize.ts";
import { MusicBrainzClient, MusicBrainzResponseError } from "../server/providers/musicbrainz/client.ts";
import { RateLimiter } from "../server/providers/ratelimit.ts";
import { SnapshotCache } from "../server/providers/snapshots.ts";
import { USER_AGENT } from "../server/version.ts";
import { type ManifestCase, runCase, summarize, table } from "../tests/identify/corpus/evaluate.ts";
import type { Damage } from "../tests/identify/corpus/synth.ts";
import { notFoundPath, readSnap, snapPath, writeSnapGz } from "../tests/helpers/replay_fetch.ts";
import { isReleaseLookup, pruneRelease } from "../tests/identify/corpus/prune.ts";

interface Source {
  slug: string;
  artist: string;
  album: string;
  damage: Damage;
  edition?: number;
  multiDisc?: boolean;
}

const CORPUS = new URL("../tests/identify/corpus/", import.meta.url);
const sources: Source[] = JSON.parse(await Deno.readTextFile(new URL("sources.json", CORPUS))).cases;
const manifestUrl = new URL("manifest.json", CORPUS);
let manifest: { cases: ManifestCase[] } = { cases: [] };
try {
  manifest = JSON.parse(await Deno.readTextFile(manifestUrl));
} catch { /* first run */ }

const only = Deno.args[0] === "--only" ? Deno.args[1] : undefined;
let live = 0;

/** Serves recordings; fetches and records only what is missing. */
const recordingFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  for (const [path, status] of [[snapPath(url), 200], [notFoundPath(snapPath(url)), 404]] as const) {
    const bytes = await readSnap(path);
    if (bytes) return new Response(bytes, { status });
  }
  live++;
  const res = await fetch(input, init);
  if (res.status !== 200 && res.status !== 404) return res;
  const raw = await res.text();
  const body = res.status === 200 && isReleaseLookup(url) ? pruneRelease(raw) : raw;
  const path = res.status === 404 ? notFoundPath(snapPath(url)) : snapPath(url);
  await Deno.mkdir(dirname(path), { recursive: true });
  // Compressed: the corpus is hundreds of responses (D38).
  await writeSnapGz(path, body);
  return new Response(body, { status: res.status, headers: res.headers });
};

const tmp = await Deno.makeTempDir({ prefix: "tagmonia-corpus-" });
const db = await openMigratedDb(":memory:");
const client = new MusicBrainzClient({
  cache: new SnapshotCache(db, tmp),
  // A one-off batch can wait out MusicBrainz overload longer than the server should.
  http: {
    userAgent: USER_AGENT,
    limiter: new RateLimiter({ requests: 1, perMs: 1000 }),
    fetch: recordingFetch,
    maxRetries: 10,
  },
});

async function resolve(s: Source): Promise<ManifestCase> {
  const hits = (await client.searchReleases({ release: s.album, artist: s.artist }, { limit: 25 })).value
    .filter((h) => similarity(h.title, s.album) >= 0.85)
    .filter((h) => !s.multiDisc || h.media.length >= 2)
    .sort((a, b) => b.score - a.score || (a.status === "Official" ? -1 : 1));
  if (hits.length === 0) throw new Error(`${s.slug}: no search hit for ${s.artist} - ${s.album}`);
  const group = hits[0]["release-group"]?.id;
  const pool = s.edition ? hits.filter((h) => h["release-group"]?.id === group).slice(s.edition - 1) : hits;
  for (const h of pool) {
    try {
      const r = (await client.lookupRelease(h.id))?.value;
      if (r) {
        return {
          slug: s.slug,
          damage: s.damage,
          releaseMbid: r.id,
          releaseGroupMbid: r["release-group"]?.id ?? null,
          title: r.title,
        };
      }
    } catch (e) {
      if (!(e instanceof MusicBrainzResponseError)) throw e;
      console.warn(`${s.slug}: skipping ${h.id}: ${e.message}`);
    }
  }
  throw new Error(`${s.slug}: no usable release (edition ${s.edition ?? 1})`);
}

try {
  const pinned = new Map(manifest.cases.map((c) => [c.slug, c]));
  for (const s of sources) {
    if (only && s.slug !== only) continue;
    if (!pinned.has(s.slug)) {
      pinned.set(s.slug, await resolve(s));
      console.log(`pinned ${s.slug} -> ${pinned.get(s.slug)!.releaseMbid} (${pinned.get(s.slug)!.title})`);
      manifest = { cases: sources.map((x) => pinned.get(x.slug)).filter((x): x is ManifestCase => !!x) };
      await Deno.writeTextFile(manifestUrl, JSON.stringify(manifest, null, 2) + "\n");
    }
  }
  const outcomes = [];
  for (const c of manifest.cases) {
    if (only && c.slug !== only) continue;
    outcomes.push(await runCase(c, client, DEFAULT_IDENTIFY));
  }
  console.log(table(outcomes));
  console.log(JSON.stringify(summarize(outcomes), null, 2));
  console.log(`live requests: ${live}`);
} finally {
  db.close();
  await Deno.remove(tmp, { recursive: true });
}
