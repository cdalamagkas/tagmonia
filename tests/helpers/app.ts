/** Builds a complete app on temp dirs and an in-memory database; no real library is ever touched. */
import { LoginThrottle } from "../../server/auth/ratelimit.ts";
import { SessionStore } from "../../server/auth/sessions.ts";
import { type Config, loadConfig } from "../../server/config.ts";
import { type Db, loadMigrations, migrate, openDb } from "../../server/db/db.ts";
import { type AppContext, createApp } from "../../server/http/app.ts";
import { JobQueue } from "../../server/jobs/queue.ts";
import { type Logger, nullLogger } from "../../server/log.ts";
import { DEFAULT_SETTINGS } from "../../server/settings.ts";
import { CredentialStore, type EnvCredentials } from "../../server/providers/credentials.ts";
import { Vault } from "../../server/secrets/vault.ts";
import { CSRF_HEADER } from "../../shared/types.ts";

export const ORIGIN = "http://tagmonia.test";
export const PASSWORD = "correct horse battery";

export async function memoryDb(): Promise<Db> {
  const db = openDb(":memory:");
  migrate(db, await loadMigrations());
  return db;
}

export interface TestApp {
  app: ReturnType<typeof createApp>;
  ctx: AppContext;
  db: Db;
  queue: JobQueue;
  musicDir: string;
  configDir: string;
  /** Request against the app with same-origin headers (Origin + Host) by default. */
  request(
    path: string,
    init?: RequestInit & { cookie?: string; csrf?: string; origin?: string | null },
  ): Promise<Response>;
  cleanup(): Promise<void>;
}

export async function makeTestApp(
  opts: {
    env?: Record<string, string>;
    config?: Partial<Config>;
    logger?: Logger;
    now?: () => number;
    envCredentials?: EnvCredentials;
    tagio?: AppContext["tagio"];
    harmony?: AppContext["harmony"];
    oidc?: AppContext["oidc"];
  } = {},
): Promise<TestApp> {
  const musicDir = await Deno.makeTempDir({ prefix: "tagmonia-music-" });
  const configDir = await Deno.makeTempDir({ prefix: "tagmonia-config-" });
  const config = {
    ...loadConfig({ TAGMONIA_MUSIC_DIR: musicDir, TAGMONIA_CONFIG_DIR: configDir, ...opts.env }),
    ...opts.config,
  };
  const db = await memoryDb();
  const logger = opts.logger ?? nullLogger;
  const queue = new JobQueue(db, { logger });
  const sessions = new SessionStore(db, { idleMs: 3_600_000, maxMs: 86_400_000 }, opts.now);
  const ctx: AppContext = {
    config,
    settings: structuredClone(DEFAULT_SETTINGS),
    db,
    queue,
    sessions,
    throttle: new LoginThrottle(undefined, opts.now),
    logger,
    creds: new CredentialStore(db, await Vault.open({ configDir }), opts.envCredentials ?? {}),
    tagio: opts.tagio,
    harmony: opts.harmony,
    oidc: opts.oidc,
  };
  const app = createApp(ctx);
  return {
    app,
    ctx,
    db,
    queue,
    musicDir,
    configDir,
    request(path, init = {}) {
      const { cookie, csrf, origin, ...rest } = init;
      const headers = new Headers(rest.headers);
      headers.set("host", new URL(ORIGIN).host);
      if (origin !== null) headers.set("origin", origin ?? ORIGIN);
      if (cookie) headers.set("cookie", cookie);
      if (csrf) headers.set(CSRF_HEADER, csrf);
      if (rest.body && !headers.has("content-type")) headers.set("content-type", "application/json");
      return Promise.resolve(app.request(`${ORIGIN}${path}`, { ...rest, headers }));
    },
    async cleanup() {
      await queue.stop();
      db.close();
      await Deno.remove(musicDir, { recursive: true });
      await Deno.remove(configDir, { recursive: true });
    },
  };
}

/** `name=value` from a Set-Cookie header, for sending back. */
export function cookieFrom(res: Response): string {
  const set = res.headers.get("set-cookie");
  if (!set) throw new Error("no Set-Cookie header");
  return set.split(";")[0];
}

/** Runs first-run setup and returns the session cookie and CSRF token. */
export async function signIn(t: TestApp, username = "admin"): Promise<{ cookie: string; csrf: string }> {
  const res = await t.request("/api/auth/setup", {
    method: "POST",
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return { cookie: cookieFrom(res), csrf: body.csrfToken };
}
