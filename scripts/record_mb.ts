/**
 * Records live MusicBrainz responses into tests/fixtures/snaps/ for the replay
 * helper (CLAUDE.md testing rules: tests never call the live API). Requests go
 * through Tagmonia's own client, so they use the real User-Agent, the 1 req/s
 * limiter and the Retry-After handling.
 *
 *   scripts/dk deno run --allow-net --allow-read --allow-write --allow-env scripts/record_mb.ts \
 *     release <mbid>... | work <mbid>... | search --release <title> [--artist <name>] [--tracks <n>] [--barcode <code>] [--catno <no>]
 *
 * Existing recordings are kept unless --force is given.
 */
import { dirname } from "node:path";
import { openMigratedDb } from "../server/db/db.ts";
import { MusicBrainzClient, RELEASE_INC, type ReleaseQuery, WORK_INC } from "../server/providers/musicbrainz/client.ts";
import { RateLimiter } from "../server/providers/ratelimit.ts";
import { SnapshotCache } from "../server/providers/snapshots.ts";
import { USER_AGENT } from "../server/version.ts";
import { notFoundPath, snapPath } from "../tests/helpers/replay_fetch.ts";

const FLAGS = new Set(["release", "artist", "tracks", "barcode", "catno"]);
const args: Partial<Record<string, string>> = {};
let force = false;
const positional: string[] = [];
for (let i = 0; i < Deno.args.length; i++) {
  const a = Deno.args[i];
  if (a === "--force") force = true;
  else if (a.startsWith("--") && FLAGS.has(a.slice(2)) && i + 1 < Deno.args.length) args[a.slice(2)] = Deno.args[++i];
  else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
  else positional.push(a);
}
const [command, ...ids] = positional;

const skipped: string[] = [];
const recordingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const url = new URL(input instanceof Request ? input.url : input);
  if (res.status !== 200 && res.status !== 404) return res;
  const body = await res.text();
  const path = res.status === 404 ? notFoundPath(snapPath(url)) : snapPath(url);
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, body);
  console.log(`${res.status} ${url.pathname}${url.search.length > 80 ? url.search.slice(0, 80) + "…" : url.search}`);
  return new Response(body, { status: res.status, headers: res.headers });
};

// A throwaway cache so every request reaches the network once and nothing lands in /config.
const tmp = await Deno.makeTempDir({ prefix: "tagmonia-record-" });
const db = await openMigratedDb(":memory:");
const client = new MusicBrainzClient({
  cache: new SnapshotCache(db, tmp),
  http: { userAgent: USER_AGENT, limiter: new RateLimiter({ requests: 1, perMs: 1000 }), fetch: recordingFetch },
});

async function exists(url: URL): Promise<boolean> {
  for (const p of [snapPath(url), notFoundPath(snapPath(url))]) {
    try {
      await Deno.stat(p);
      return true;
    } catch { /* not recorded */ }
  }
  return false;
}

try {
  switch (command) {
    case "release":
    case "work":
      for (const id of ids) {
        const url = new URL(`${command}/${id}`, client.baseUrl);
        if (!force && await exists(withInc(url, command))) {
          skipped.push(id);
          continue;
        }
        await (command === "release" ? client.lookupRelease(id) : client.lookupWork(id));
      }
      break;
    case "search": {
      const q: ReleaseQuery = {
        release: args.release,
        artist: args.artist,
        tracks: args.tracks ? Number(args.tracks) : undefined,
        barcode: args.barcode,
        catno: args.catno,
      };
      await client.searchReleases(q);
      break;
    }
    default:
      console.error("usage: record_mb.ts release <mbid>... | work <mbid>... | search --release <title> [...]");
      Deno.exitCode = 2;
  }
} finally {
  db.close();
  await Deno.remove(tmp, { recursive: true });
}
if (skipped.length) console.log(`already recorded (use --force to refresh): ${skipped.join(", ")}`);

function withInc(url: URL, kind: string): URL {
  // Must mirror the client's URL exactly, or the skip check never matches.
  const u = new URL(url);
  u.searchParams.set("inc", kind === "release" ? RELEASE_INC : WORK_INC);
  u.searchParams.set("fmt", "json");
  return u;
}
