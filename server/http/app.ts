/**
 * Hono app and middleware order (ARCHITECTURE.md §14.2). Phase 1 inserts
 * session auth and CSRF between the security headers and the API routes.
 */
import { Hono } from "hono";
import { serveStatic } from "hono/deno";
import type { Config } from "../config.ts";
import { healthRoutes } from "./routes/health.ts";

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; " +
    "form-action 'self' https://musicbrainz.org; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

export function createApp(config: Config): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v);
  });

  app.route("/api/health", healthRoutes(config));
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  if (config.webDir) {
    const root = config.webDir;
    app.use("/*", serveStatic({ root }));
    // SPA fallback: client-side routes resolve to index.html.
    app.get("*", serveStatic({ root, path: "index.html" }));
  }
  return app;
}
