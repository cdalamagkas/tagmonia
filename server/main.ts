/** Boot: config -> settings -> database + migrations -> admin bootstrap -> job queue -> HTTP. */
import { join } from "node:path";
import { bootstrapAdmin } from "./auth/bootstrap.ts";
import { LoginThrottle } from "./auth/ratelimit.ts";
import { SessionStore } from "./auth/sessions.ts";
import { loadConfig } from "./config.ts";
import { openMigratedDb } from "./db/db.ts";
import { createApp } from "./http/app.ts";
import { JobQueue } from "./jobs/queue.ts";
import { registerScanJob } from "./jobs/scan.ts";
import { createLogger } from "./log.ts";
import { loadSettings } from "./settings.ts";
import { createTagIO } from "./tagio/mod.ts";
import { VERSION } from "./version.ts";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  await Deno.mkdir(config.configDir, { recursive: true });
  const settings = await loadSettings(config.configDir);
  const db = await openMigratedDb(join(config.configDir, "tagmony.db"));
  await bootstrapAdmin(db, config.adminPasswordFile, logger);

  const tagio = await createTagIO();
  const queue = new JobQueue(db, { logger });
  registerScanJob(queue, {
    db,
    tagio,
    musicDir: config.musicDir,
    ignore: () => settings.scanner.ignore,
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
      logger.info(`Tagmony ${VERSION} listening on http://${hostname}:${port}`, { readOnly: config.readOnly }),
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
