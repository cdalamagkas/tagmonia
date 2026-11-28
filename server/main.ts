/** Boot: config -> settings -> database + migrations -> admin bootstrap -> job queue -> HTTP. */
import { join } from "node:path";
import { bootstrapAdmin } from "./auth/bootstrap.ts";
import { LoginThrottle } from "./auth/ratelimit.ts";
import { SessionStore } from "./auth/sessions.ts";
import { checkInbox, loadConfig, resolveAcoustidKey, resolveJellyfinKey, resolveOidcSecret } from "./config.ts";
import { OidcLogin } from "./auth/oidc.ts";
import { JellyfinClient } from "./integrations/jellyfin.ts";
import { enqueueRefresh, folderOfBatch, registerRefreshJob } from "./jobs/refresh.ts";
import { openMigratedDb } from "./db/db.ts";
import { createApp } from "./http/app.ts";
import { JobQueue } from "./jobs/queue.ts";
import { enqueueIdentify, registerIdentifyJob } from "./jobs/identify.ts";
import { enqueuePropose, registerProposeJob } from "./jobs/propose.ts";
import { registerWriteJobs } from "./jobs/write.ts";
import { enqueueInboxScan, registerScanJob } from "./jobs/scan.ts";
import { InboxWatcher } from "./inbox/watch.ts";
import { createLogger } from "./log.ts";
import { createMusicBrainzClient, createSubmissionClients } from "./providers/musicbrainz/mod.ts";
import { registerFollowUpJob, registerSubmissionJobs } from "./jobs/submission.ts";
import type { SourceProvider } from "./providers/enrichment.ts";
import { createAcoustIdSource, type FingerprintSource } from "./identify/acoustid_source.ts";
import { registerProviderTestJob } from "./jobs/provider_test.ts";
import { CredentialStore } from "./providers/credentials.ts";
import { Vault } from "./secrets/vault.ts";
import { AcoustIdClient } from "./providers/acoustid.ts";
import { isYouTubeHost, YouTubeClient } from "./providers/youtube.ts";
import { RateLimiter } from "./providers/ratelimit.ts";
import { SnapshotCache } from "./providers/snapshots.ts";
import { identifyConfig, loadSettings, namingOf } from "./settings.ts";
import { createTagIO } from "./tagio/mod.ts";
import { PROJECT_URL, USER_AGENT, VERSION } from "./version.ts";
import { createHarmonyRegistry } from "./providers/harmony_adapter.ts";
import { CoverFetcher } from "./covers/fetch.ts";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  await checkInbox(config);
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
    inboxDir: config.inboxDir,
    ignore: () => settings.scanner.ignore,
    logger,
    onCandidatesTouched: (ids) => enqueueIdentify(queue, ids),
  });
  // Credentials (§14.3, D46): environment variables win; otherwise the encrypted store behind the providers page.
  const vault = await Vault.open({ secretKey: config.secretKey, configDir: config.configDir });
  const creds = new CredentialStore(db, vault, {
    acoustid: { apiKey: await resolveAcoustidKey(config) },
    jellyfin: { url: config.jellyfinUrl, apiKey: await resolveJellyfinKey(config), library: config.jellyfinLibrary },
  });
  const snaps = new SnapshotCache(db, join(config.configDir, "snaps"));

  // Built when first needed and again whenever the key changes, so a key saved in the app applies at once.
  // One limiter for every client it builds: AcoustID allows 3 requests per second in total (D37).
  const acoustidLimiter = new RateLimiter({ requests: 1, perMs: 1000 / settings.providers.acoustid.requestsPerSecond });
  let acoustid: { key: string; source: FingerprintSource } | null = null;
  const fingerprints = async (): Promise<FingerprintSource | null> => {
    const { apiKey } = await creds.get("acoustid");
    if (!apiKey) return null;
    if (acoustid?.key !== apiKey) {
      acoustid = {
        key: apiKey,
        source: createAcoustIdSource({
          db,
          musicDir: config.musicDir,
          inboxDir: config.inboxDir,
          logger,
          minScore: settings.providers.acoustid.minScore,
          acoustid: new AcoustIdClient({
            apiKey,
            cache: snaps,
            http: { userAgent: USER_AGENT, limiter: acoustidLimiter },
          }),
        }),
      };
    }
    return acoustid.source;
  };
  // YouTube evidence (§9.5, D55): built again whenever the key changes, like AcoustID.
  const youtubeLimiter = new RateLimiter({ requests: 5, perMs: 1000 });
  let youtube: { key: string; client: YouTubeClient } | null = null;
  const youtubeClient = async (): Promise<YouTubeClient | null> => {
    const { apiKey } = await creds.get("youtube");
    if (!apiKey) return null;
    if (youtube?.key !== apiKey) {
      youtube = {
        key: apiKey,
        client: new YouTubeClient({ apiKey, cache: snaps, http: { userAgent: USER_AGENT, limiter: youtubeLimiter } }),
      };
    }
    return youtube.client;
  };
  const jellyfin = async (): Promise<JellyfinClient | null> => {
    const { url, apiKey, library } = await creds.get("jellyfin");
    return url && apiKey
      ? new JellyfinClient({ baseUrl: url, apiKey, library, userAgent: USER_AGENT, version: VERSION })
      : null;
  };

  // One client for every job: a second one would bring a second limiter and double the MusicBrainz rate.
  const mb = createMusicBrainzClient(db, config.configDir, settings);
  // Deezer, iTunes, Tidal, Spotify and Discogs through Harmony (D47, D67). Harmony reads credentials once,
  // when its modules load (D12): saving new ones takes effect after a restart, as the providers page says.
  // A provider that needs credentials is registered only when they are set.
  const discogs = await creds.get("discogs");
  const tidal = await creds.get("tidal");
  const spotify = await creds.get("spotify");
  const discogsReady = !!(discogs.consumerKey && discogs.consumerSecret);
  const tidalReady = !!(tidal.clientId && tidal.clientSecret);
  const spotifyReady = !!(spotify.clientId && spotify.clientSecret);
  const harmony = await createHarmonyRegistry({
    app: { name: "Tagmonia", version: VERSION, contact: PROJECT_URL },
    snapsDir: join(config.configDir, "snaps", "harmony"),
    // Bandcamp is registered but used only from a link, and only while its switch is on (D16, D51).
    providers: [
      "deezer",
      "itunes",
      ...(tidalReady ? ["tidal" as const] : []),
      ...(spotifyReady ? ["spotify" as const] : []),
      ...(discogsReady ? ["discogs" as const] : []),
      "bandcamp",
    ],
    credentials: {
      ...(discogsReady
        ? { discogsConsumerKey: discogs.consumerKey, discogsConsumerSecret: discogs.consumerSecret }
        : {}),
      ...(tidalReady ? { tidalClientId: tidal.clientId, tidalClientSecret: tidal.clientSecret } : {}),
      ...(spotifyReady ? { spotifyClientId: spotify.clientId, spotifyClientSecret: spotify.clientSecret } : {}),
    },
  });
  // Cover art (D49): one request per second for every cover host, images cached under /config.
  const covers = new CoverFetcher({
    cacheDir: join(config.configDir, "covers"),
    userAgent: USER_AGENT,
    limiter: new RateLimiter({ requests: 1, perMs: 1000 }),
  });
  const submissionClients = createSubmissionClients(db, config.configDir, mb);
  registerProposeJob(queue, {
    db,
    mb,
    search: mb,
    mbFor: submissionClients,
    covers: { fetcher: covers, mode: () => settings.covers.mode, musicDir: config.musicDir, inboxDir: config.inboxDir },
    settings: () => settings.proposal,
    logger,
    enrichment: { registry: harmony, enabled: (id) => settings.providers[id].enabled },
    youtube: youtubeClient,
  });
  registerRefreshJob(queue, { db, jellyfin, logger });
  registerSubmissionJobs(queue, {
    db,
    client: submissionClients,
    // YouTube is a source too (D64), outside Harmony.
    providerOf: (url) =>
      isYouTubeHost(url.hostname) ? "youtube" : harmony.providerForUrl(url) as SourceProvider | undefined,
    artistLinks: (artist) => harmony.artistLinks(artist),
    onReturned: (candidateId, mbid, server) =>
      enqueuePropose(
        queue,
        candidateId,
        mbid,
        "user",
        server === "https://test.musicbrainz.org" ? server : undefined,
      ),
    logger,
  });
  registerFollowUpJob(queue, { db, client: submissionClients, logger });
  registerProviderTestJob(queue, { db, creds, mb, userAgent: USER_AGENT, version: VERSION });
  registerWriteJobs(queue, {
    db,
    tagio,
    musicDir: config.musicDir,
    inboxDir: config.inboxDir,
    readOnly: config.readOnly,
    logger,
    covers: { read: (sha, mime) => covers.read(sha, mime), backupDir: join(config.configDir, "backups", "pictures") },
    naming: () => namingOf(settings),
    // §13: tell the music server once the files changed (when one is configured).
    afterBatch: (r) => {
      creds.configured("jellyfin").then((on) => {
        if (!on) return;
        const folder = folderOfBatch(db, r.batchId);
        enqueueRefresh(queue, db, folder === null ? [] : [folder]);
      }).catch((e) => logger.error("cannot queue the Jellyfin refresh", { error: (e as Error).message }));
    },
  });
  registerIdentifyJob(queue, {
    db,
    fingerprints,
    mb,
    config: () => identifyConfig(settings),
    logger,
  });
  queue.start();

  // New music in the inbox is scanned once it settles (D60); nothing is written by itself.
  const watcher = config.inboxDir
    ? new InboxWatcher({
      inboxDir: config.inboxDir,
      onSettled: () => enqueueInboxScan(queue),
      pollMs: () => settings.scanner.inboxPollMinutes * 60_000,
      logger,
    })
    : null;
  watcher?.start();

  const sessions = new SessionStore(db, {
    idleMs: settings.auth.sessionIdleHours * 3_600_000,
    maxMs: settings.auth.sessionMaxDays * 86_400_000,
  });
  const purge = setInterval(() => sessions.purgeExpired(), 3_600_000);

  // Single sign-on (D69): configured from the environment only.
  const oidc = config.oidc
    ? {
      name: config.oidc.name,
      login: new OidcLogin({
        issuer: config.oidc.issuer,
        clientId: config.oidc.clientId,
        clientSecret: (await resolveOidcSecret(config))!,
        group: config.oidc.group,
        groupsClaim: config.oidc.groupsClaim,
        scopes: config.oidc.scopes,
        redirectUri: new URL("/api/auth/oidc/callback", config.publicUrl).href,
      }),
    }
    : null;
  if (oidc) logger.info("single sign-on on", { provider: config.oidc!.issuer, group: config.oidc!.group });
  if (config.trustedHeader) {
    logger.info("sign-in by a trusted proxy on", {
      header: config.trustedHeader.userHeader,
      group: config.trustedHeader.group,
    });
  }
  const app = createApp({
    oidc,
    config,
    settings,
    db,
    queue,
    sessions,
    throttle: new LoginThrottle(),
    logger,
    creds,
    tagio,
    harmony,
  });
  const server = Deno.serve({
    port: config.port,
    onListen: ({ hostname, port }) =>
      logger.info(`Tagmonia ${VERSION} listening on http://${hostname}:${port}`, { readOnly: config.readOnly }),
  }, app.fetch);

  const shutdown = async () => {
    logger.info("shutting down");
    clearInterval(purge);
    await watcher?.stop();
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
