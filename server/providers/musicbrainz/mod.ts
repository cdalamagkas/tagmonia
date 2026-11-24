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
