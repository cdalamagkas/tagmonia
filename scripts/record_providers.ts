/**
 * Records Deezer, iTunes and Discogs responses (through Harmony) and the
 * MusicBrainz extras for releases, into tests/fixtures/snaps/ for the provider
 * lookup tests (D47). Discogs is recorded without credentials, so no
 * recording can contain one.
 *
 *   scripts/dk deno run -A scripts/record_providers.ts <mbid>...
 */
import { dirname } from "node:path";
import { openMigratedDb } from "../server/db/db.ts";
import { findOnProviders, linksOf } from "../server/providers/enrichment.ts";
import { createHarmonyRegistry } from "../server/providers/harmony_adapter.ts";
import { MusicBrainzClient } from "../server/providers/musicbrainz/client.ts";
import { RateLimiter } from "../server/providers/ratelimit.ts";
import { SnapshotCache } from "../server/providers/snapshots.ts";
import { PROJECT_URL, USER_AGENT, VERSION } from "../server/version.ts";
import { notFoundPath, snapPath } from "../tests/helpers/replay_fetch.ts";

const hosts = new Set<string>();
const realFetch = globalThis.fetch;
const recording: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  hosts.add(url.host);
  const res = await realFetch(input, init);
  if (res.status !== 200 && res.status !== 404) return res;
  const body = await res.text();
  const path = res.status === 404 ? notFoundPath(snapPath(url)) : snapPath(url);
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, body);
  return new Response(body, { status: res.status, headers: res.headers });
};
// Harmony's providers capture `fetch` when they are constructed: install it first.
globalThis.fetch = recording;

const tmp = await Deno.makeTempDir({ prefix: "tagmonia-record-providers-" });
const db = await openMigratedDb(":memory:");
const mb = new MusicBrainzClient({
  cache: new SnapshotCache(db, tmp),
  http: {
    userAgent: USER_AGENT,
    limiter: new RateLimiter({ requests: 1, perMs: 1000 }),
    fetch: recording,
    maxRetries: 8,
  },
});
const registry = await createHarmonyRegistry({
  app: { name: "Tagmonia", version: VERSION, contact: PROJECT_URL },
  snapsDir: tmp,
  providers: ["deezer", "itunes", "discogs"],
});
try {
  for (const id of Deno.args) {
    const rel = (await mb.lookupRelease(id))!.value;
    const extras = (await mb.lookupReleaseExtras(id))?.value ?? null;
    const matches = await findOnProviders({ registry, enabled: () => true }, rel, linksOf(extras));
    console.log(`${rel.title} (${rel.country}, barcode ${rel.barcode ?? "-"})`);
    for (const m of matches) {
      console.log(`  ${m.provider.padEnd(8)} ${m.status.padEnd(17)} ${m.via ?? ""} ${m.reason ?? ""} ${m.url ?? ""}`);
    }
  }
} finally {
  db.close();
  await Deno.remove(tmp, { recursive: true });
}
console.log(`hosts contacted: ${[...hosts].sort().join(", ")}`);
