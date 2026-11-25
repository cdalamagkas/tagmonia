import { join } from "node:path";
import type { Db } from "../../db/db.ts";
import type { Settings } from "../../settings.ts";
import { USER_AGENT } from "../../version.ts";
import { RateLimiter } from "../ratelimit.ts";
import { SnapshotCache } from "../snapshots.ts";
import { MusicBrainzClient } from "./client.ts";

export { MusicBrainzClient } from "./client.ts";

/** One client (and so one limiter) per process: two limiters would double the request rate. */
export function createMusicBrainzClient(db: Db, configDir: string, settings: Settings): MusicBrainzClient {
  const mb = settings.providers.musicbrainz;
  return new MusicBrainzClient({
    baseUrl: mb.baseUrl,
    cache: new SnapshotCache(db, join(configDir, "snaps")),
    http: {
      userAgent: USER_AGENT,
      limiter: new RateLimiter({ requests: 1, perMs: 1000 / mb.requestsPerSecond }),
    },
  });
}

/**
 * Clients for the servers releases can be submitted to (§12, D52). musicbrainz.org reuses the
 * main client when that is what it talks to, so the two never exceed 1 request per second
 * together; behind a mirror, and for the test server, each gets its own client and limiter.
 */
export function createSubmissionClients(
  db: Db,
  configDir: string,
  main: MusicBrainzClient,
): (server: string) => MusicBrainzClient {
  const cache = new SnapshotCache(db, join(configDir, "snaps"));
  const clients = new Map<string, MusicBrainzClient>();
  if (main.baseUrl.hostname === "musicbrainz.org") clients.set("https://musicbrainz.org", main);
  return (server) => {
    let c = clients.get(server);
    if (!c) {
      if (server !== "https://musicbrainz.org" && server !== "https://test.musicbrainz.org") {
        throw new Error(`not a MusicBrainz server Tagmonia submits to: ${server}`);
      }
      c = new MusicBrainzClient({
        baseUrl: `${server}/ws/2/`,
        cache,
        http: { userAgent: USER_AGENT, limiter: new RateLimiter({ requests: 1, perMs: 1000 }) },
      });
      clients.set(server, c);
    }
    return c;
  };
}
