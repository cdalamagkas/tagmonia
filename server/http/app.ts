/**
 * Hono app and middleware order (ARCHITECTURE.md §14.2):
 * security headers -> body limit -> /api/health -> Origin check -> public auth
 * routes -> session required -> CSRF -> everything else.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/deno";
import type { LoginThrottle } from "../auth/ratelimit.ts";
import type { SessionStore } from "../auth/sessions.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/db.ts";
import type { JobQueue } from "../jobs/queue.ts";
import type { Logger } from "../log.ts";
import type { Settings } from "../settings.ts";
import { type AuthEnv, authRoutes, originGuard, requireCsrf, requireSession } from "./auth.ts";
import { healthRoutes } from "./routes/health.ts";
import { jobRoutes, libraryRoutes } from "./routes/library.ts";
import { writeRoutes } from "./routes/writes.ts";
import { reviewRoutes } from "./routes/review.ts";

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; " +
    "form-action 'self' https://musicbrainz.org; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
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
}

export function createApp(ctx: AppContext): Hono<AuthEnv> {
  const { config, db, queue, sessions } = ctx;
  const app = new Hono<AuthEnv>();

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
      thresholds: () => ({ auto: ctx.settings.identify.autoThreshold, review: ctx.settings.identify.reviewThreshold }),
    }),
  );
  app.route("/api/jobs", jobRoutes(queue));
  app.route("/api", writeRoutes({ db, queue, readOnly: config.readOnly }));
  app.route("/api", reviewRoutes({ db }));
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  if (config.webDir) {
    const root = config.webDir;
    app.use("/*", serveStatic({ root }));
    // SPA fallback: client-side routes resolve to index.html.
    app.get("*", serveStatic({ root, path: "index.html" }));
  }
  return app;
}
