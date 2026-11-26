/**
 * Hono app and middleware order (ARCHITECTURE.md §14.2):
 * security headers -> body limit -> /api/health -> Origin check -> public auth
 * routes -> session required -> CSRF -> everything else.
 */
import { join } from "node:path";
import { Hono } from "hono";
import { CurrentCovers } from "../covers/current.ts";
import type { TagIO } from "../tagio/types.ts";
import type { HarmonyRegistry } from "../providers/harmony_adapter.ts";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/deno";
import type { LoginThrottle } from "../auth/ratelimit.ts";
import type { SessionStore } from "../auth/sessions.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/db.ts";
import type { JobQueue } from "../jobs/queue.ts";
import type { Logger } from "../log.ts";
import { namingOf, type Settings } from "../settings.ts";
import { type AuthEnv, authRoutes, originGuard, requireCsrf, requireSession } from "./auth.ts";
import { healthRoutes } from "./routes/health.ts";
import { jobRoutes, libraryRoutes } from "./routes/library.ts";
import { writeRoutes } from "./routes/writes.ts";
import { reviewRoutes } from "./routes/review.ts";
import { submissionRoutes } from "./routes/submission.ts";
import { providerRoutes } from "./routes/providers.ts";
import type { CredentialStore } from "../providers/credentials.ts";

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; " +
    "form-action 'self' https://musicbrainz.org https://test.musicbrainz.org; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

export interface AppContext {
  config: Config;
  settings: Settings;
  db: Db;
  queue: JobQueue;
  sessions: SessionStore;
  throttle: LoginThrottle;
  logger: Logger;
  /** Provider credentials, encrypted at rest (§14.3, D46). */
  creds: CredentialStore;
  /** Reads the releases' current covers (D50); without it, no cover previews are served. */
  tagio?: Pick<TagIO, "read">;
  /** Recognises provider release links for "not in MusicBrainz" proposals (§10.4, D51). */
  harmony?: Pick<HarmonyRegistry, "providerForUrl" | "isReleaseUrl">;
}

export function createApp(ctx: AppContext): Hono<AuthEnv> {
  const { config, db, queue, sessions } = ctx;
  const app = new Hono<AuthEnv>();
  const covers = ctx.tagio
    ? new CurrentCovers({
      db,
      tagio: ctx.tagio,
      musicDir: config.musicDir,
      inboxDir: config.inboxDir,
      cacheDir: join(config.configDir, "thumbs"),
      logger: ctx.logger,
    })
    : null;

  app.use("*", async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v);
  });
  app.use(
    "/api/*",
    bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "request body too large" }, 413) }),
  );

  app.route("/api/health", healthRoutes(config, db));

  app.use("/api/*", originGuard(config.publicUrl));
  const auth = authRoutes({
    db,
    sessions,
    throttle: ctx.throttle,
    logger: ctx.logger,
    publicUrl: config.publicUrl,
    sessionMaxMs: ctx.settings.auth.sessionMaxDays * 86_400_000,
  });
  app.route("/api/auth", auth.public);

  // Everything below requires a signed-in session (CLAUDE.md safety rule 8).
  app.use("/api/*", requireSession(sessions));
  app.use("/api/*", requireCsrf());
  app.route("/api/auth", auth.signedIn);
  app.route(
    "/api/library",
    libraryRoutes({
      db,
      queue,
      readOnly: config.readOnly,
      musicServer: async () =>
        (await ctx.creds.configured("jellyfin"))
          ? { name: "jellyfin", library: (await ctx.creds.get("jellyfin")).library ?? null }
          : null,
      thresholds: () => ({ auto: ctx.settings.identify.autoThreshold, review: ctx.settings.identify.reviewThreshold }),
      naming: () => namingOf(ctx.settings),
      musicDir: config.musicDir,
      inbox: !!config.inboxDir,
      covers,
      sources: ctx.harmony
        ? {
          providerFor: (u) => ctx.harmony!.providerForUrl(u),
          isReleaseUrl: (u) => ctx.harmony!.isReleaseUrl(u),
          enabled: (id) => (ctx.settings.providers as Record<string, { enabled?: boolean }>)[id]?.enabled ?? false,
        }
        : null,
    }),
  );
  app.route("/api/jobs", jobRoutes(queue));
  app.route("/api", writeRoutes({ db, queue, readOnly: config.readOnly }));
  app.route(
    "/api",
    submissionRoutes({
      db,
      queue,
      server: () => ctx.settings.submission.server,
      publicUrl: config.publicUrl,
    }),
  );
  app.route("/api", reviewRoutes({ db, coverDir: join(config.configDir, "covers") }));
  app.route(
    "/api",
    providerRoutes({ db, queue, creds: ctx.creds, settings: ctx.settings, configDir: config.configDir }),
  );
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  if (config.webDir) {
    const root = config.webDir;
    app.use("/*", serveStatic({ root }));
    // SPA fallback: client-side routes resolve to index.html.
    app.get("*", serveStatic({ root, path: "index.html" }));
  }
  return app;
}
