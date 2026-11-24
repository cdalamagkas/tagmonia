/** Boot: config -> settings -> database + migrations -> admin bootstrap -> job queue -> HTTP. */
import { join } from "node:path";
import { bootstrapAdmin } from "./auth/bootstrap.ts";
import { LoginThrottle } from "./auth/ratelimit.ts";
import { SessionStore } from "./auth/sessions.ts";
import { loadConfig, resolveAcoustidKey } from "./config.ts";
import { openMigratedDb } from "./db/db.ts";
import { createApp } from "./http/app.ts";
import { JobQueue } from "./jobs/queue.ts";
import { enqueueIdentify, registerIdentifyJob } from "./jobs/identify.ts";
import { registerScanJob } from "./jobs/scan.ts";
import { createLogger } from "./log.ts";
import { createMusicBrainzClient } from "./providers/musicbrainz/mod.ts";
import { createAcoustIdSource } from "./identify/acoustid_source.ts";
import { AcoustIdClient } from "./providers/acoustid.ts";
import { RateLimiter } from "./providers/ratelimit.ts";
import { SnapshotCache } from "./providers/snapshots.ts";
import { identifyConfig, loadSettings } from "./settings.ts";
import { createTagIO } from "./tagio/mod.ts";
import { USER_AGENT, VERSION } from "./version.ts";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  await Deno.mkdir(config.configDir, { recursive: true });
  const settings = await loadSettings(config.configDir);
  const db = await openMigratedDb(join(config.configDir, "tagmonia.db"));
  await bootstrapAdmin(db, config.adminPasswordFile, logger);

  const tagio = await createTagIO();
  const queue = new JobQueue(db, { logger });
  registerScanJob(queue, {
    db,
    tagio,
    musicDir: config.musicDir,
    ignore: () => settings.scanner.ignore,
    logger,
    onCandidatesTouched: (ids) => enqueueIdentify(queue, ids),
  });
  const acoustidKey = await resolveAcoustidKey(config);
  if (!acoustidKey) logger.info("no AcoustID key: fingerprint identification is off (set TAGMONIA_ACOUSTID_KEY)");
  const fingerprints = acoustidKey
    ? createAcoustIdSource({
      db,
      musicDir: config.musicDir,
      logger,
      minScore: settings.providers.acoustid.minScore,
      acoustid: new AcoustIdClient({
        apiKey: acoustidKey,
        cache: new SnapshotCache(db, join(config.configDir, "snaps")),
        http: {
          userAgent: USER_AGENT,
          limiter: new RateLimiter({ requests: 1, perMs: 1000 / settings.providers.acoustid.requestsPerSecond }),
        },
      }),
    })
    : null;
  registerIdentifyJob(queue, {
    db,
    fingerprints,
    mb: createMusicBrainzClient(db, config.configDir, settings),
    config: () => identifyConfig(settings),
    logger,
  });
  queue.start();

  const sessions = new SessionStore(db, {
    idleMs: settings.auth.sessionIdleHours * 3_600_000,
    maxMs: settings.auth.sessionMaxDays * 86_400_000,
  });
  const purge = setInterval(() => sessions.purgeExpired(), 3_600_000);

  const app = createApp({ config, settings, db, queue, sessions, throttle: new LoginThrottle(), logger });
  const server = Deno.serve({
    port: config.port,
    onListen: ({ hostname, port }) =>
      logger.info(`Tagmonia ${VERSION} listening on http://${hostname}:${port}`, { readOnly: config.readOnly }),
  }, app.fetch);

  const shutdown = async () => {
    logger.info("shutting down");
    clearInterval(purge);
    await server.shutdown();
    await queue.stop();
    await tagio.close?.();
    db.close();
    Deno.exit(0);
  };
  Deno.addSignalListener("SIGTERM", shutdown);
  Deno.addSignalListener("SIGINT", shutdown);
}

if (import.meta.main) await main();
