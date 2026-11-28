/**
 * Sessions, login, first-run setup and CSRF (ARCHITECTURE.md §14.1-14.2,
 * CLAUDE.md safety rule 8). Every /api route requires a session except
 * /api/health and the PUBLIC_API routes below; every state-changing request
 * must pass the Origin check, and, once signed in, carry the session's CSRF token.
 */
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getConnInfo } from "hono/deno";
import { z } from "zod";
import { type AuthState, CSRF_HEADER } from "../../shared/types.ts";
import {
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  verifyAgainstDummy,
  verifyPassword,
} from "../auth/password.ts";
import type { LoginThrottle } from "../auth/ratelimit.ts";
import { type ActiveSession, safeEqual, type SessionStore } from "../auth/sessions.ts";
import type { Db } from "../db/db.ts";
import { countUsers, createFirstAdmin, findOrCreateExternalUser, findUserByName } from "../db/repo/users.ts";
import { OidcError, type OidcLogin } from "../auth/oidc.ts";
import { type TrustedHeaderSettings, trustedUser } from "../auth/trusted_header.ts";
import type { Logger } from "../log.ts";

export const SESSION_COOKIE = "tagmonia_session";

/** Reachable without a session: the auth state probe, login and first-run setup. */
export const PUBLIC_API: ReadonlySet<string> = new Set([
  "GET /api/auth/session",
  "POST /api/auth/login",
  "POST /api/auth/setup",
  // Single sign-on (D69): the way to the identity provider and back, part of signing in.
  "GET /api/auth/oidc/start",
  "GET /api/auth/oidc/callback",
]);

/** Holds the key of a pending single sign-on between the start and the callback (D69). */
export const OIDC_COOKIE = "tagmonia_oidc";

export type AuthEnv = { Variables: { session: ActiveSession; proxyRefused?: string } };

export interface AuthDeps {
  db: Db;
  sessions: SessionStore;
  throttle: LoginThrottle;
  logger: Logger;
  /** From TAGMONIA_PUBLIC_URL: decides the cookie's Secure flag and the allowed Origin. */
  publicUrl?: string;
  sessionMaxMs: number;
  /** Single sign-on (D69), when configured; `name` labels the button. */
  oidc?: { login: OidcLogin; name: string } | null;
  /** Sign-in by a trusted reverse proxy (D70), when configured. */
  trusted?: TrustedHeaderSettings | null;
  /** The connection's peer address; tests set it, since in-process requests have none. */
  peer?: (c: Context) => string;
}

/** How a user signs in, from their account's external ID. */
export function signedInBy(externalId: string | null): "password" | "sso" | "proxy" {
  return !externalId ? "password" : externalId.startsWith("header:") ? "proxy" : "sso";
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const credentialsSchema = z.object({
  username: z.string().trim().min(1).max(64).regex(/^[^\s\p{Cc}]+$/u, "no spaces or control characters"),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

const setupSchema = credentialsSchema.extend({
  password: z.string().min(MIN_PASSWORD_LENGTH, `at least ${MIN_PASSWORD_LENGTH} characters`).max(
    MAX_PASSWORD_LENGTH,
  ),
});

function clientIp(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown"; // no connection info (in-process requests in tests)
  }
}

/**
 * Login CSRF and cross-site POST defence: the Origin (or Referer) must be the
 * public URL's origin, or carry the same host the request was sent to.
 */
export function originAllowed(c: Context, publicUrl?: string): boolean {
  const src = c.req.header("origin") ?? c.req.header("referer");
  if (!src) return false;
  let origin: URL;
  try {
    origin = new URL(src);
  } catch {
    return false;
  }
  if (publicUrl && origin.origin === new URL(publicUrl).origin) return true;
  const host = c.req.header("host");
  return !!host && origin.host === host;
}

export function authRoutes(deps: AuthDeps) {
  const { db, sessions, throttle, logger } = deps;
  const secure = deps.publicUrl?.startsWith("https:") ?? false;

  const startSession = async (c: Context, userId: number) => {
    const s = await sessions.create(userId);
    setCookie(c, SESSION_COOKIE, s.id, {
      httpOnly: true,
      sameSite: "Lax",
      secure,
      path: "/",
      maxAge: Math.floor(deps.sessionMaxMs / 1000),
    });
    return s.csrfToken;
  };

  const app = new Hono<AuthEnv>();

  app.get("/session", async (c) => {
    // A trusted proxy's session is already set by trustedHeaderSession.
    const s = c.get("session") ?? await sessions.get(getCookie(c, SESSION_COOKIE));
    const refused = c.get("proxyRefused");
    const body: AuthState = {
      setupRequired: countUsers(db) === 0,
      user: s ? { username: s.username, isAdmin: s.isAdmin, signedInBy: signedInBy(s.externalId) } : null,
      csrfToken: s?.csrfToken ?? null,
      sso: deps.oidc ? { name: deps.oidc.name } : null,
      ...(refused && !s ? { proxyRefused: refused } : {}),
    };
    c.header("Cache-Control", "no-store");
    return c.json(body);
  });

  app.post("/setup", async (c) => {
    const parsed = setupSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
    if (countUsers(db) > 0) return c.json({ error: "setup is already complete" }, 409);
    const hash = await hashPassword(parsed.data.password);
    const user = createFirstAdmin(db, parsed.data.username, hash, Date.now());
    if (!user) return c.json({ error: "setup is already complete" }, 409);
    logger.info("first admin created", { user: user.username });
    const csrfToken = await startSession(c, user.id);
    const body: AuthState = {
      setupRequired: false,
      user: { username: user.username, isAdmin: true, signedInBy: "password" },
      csrfToken,
      sso: deps.oidc ? { name: deps.oidc.name } : null,
    };
    return c.json(body, 201);
  });

  app.post("/login", async (c) => {
    const parsed = credentialsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);
    const { username, password } = parsed.data;
    const keys = [`ip:${clientIp(c)}`, `user:${username.toLowerCase()}`];
    const wait = throttle.retryAfterMs(keys);
    if (wait > 0) {
      c.header("Retry-After", String(Math.ceil(wait / 1000)));
      return c.json({ error: "too many failed attempts; try again later" }, 429);
    }
    const user = findUserByName(db, username);
    const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyAgainstDummy(password);
    if (!user || !ok) {
      throttle.fail(keys);
      logger.warn("login failed", { user: username, ip: keys[0].slice(3) });
      return c.json({ error: "invalid username or password" }, 401);
    }
    throttle.succeed(keys);
    logger.info("login", { user: user.username });
    const csrfToken = await startSession(c, user.id);
    const body: AuthState = {
      setupRequired: false,
      user: { username: user.username, isAdmin: user.isAdmin, signedInBy: "password" },
      csrfToken,
      sso: deps.oidc ? { name: deps.oidc.name } : null,
    };
    return c.json(body);
  });

  // Single sign-on (D69). Both are top-level browser navigations (GET), so no CSRF token: state, nonce and
  // PKCE, bound to this browser by the cookie, protect the round trip instead.
  app.get("/oidc/start", async (c) => {
    if (!deps.oidc) return c.json({ error: "single sign-on is not configured" }, 404);
    try {
      const { key, url } = await deps.oidc.login.start();
      setCookie(c, OIDC_COOKIE, key, { httpOnly: true, sameSite: "Lax", secure, path: "/api/auth/oidc", maxAge: 600 });
      return c.redirect(url.href, 302);
    } catch (e) {
      logger.warn("single sign-on could not start", { error: (e as Error).message });
      return c.redirect("/?signin_error=provider", 302);
    }
  });

  app.get("/oidc/callback", async (c) => {
    if (!deps.oidc) return c.json({ error: "single sign-on is not configured" }, 404);
    const key = getCookie(c, OIDC_COOKIE);
    deleteCookie(c, OIDC_COOKIE, { path: "/api/auth/oidc", secure });
    // The address the provider sent the browser to, whatever the proxy in between forwarded.
    const here = new URL(c.req.url);
    const callback = new URL(`/api/auth/oidc/callback${here.search}`, deps.publicUrl ?? here.origin);
    try {
      const id = await deps.oidc.login.finish(key, callback);
      const user = findOrCreateExternalUser(db, id.externalId, id.name, Date.now());
      logger.info("login", { user: user.username, via: "single sign-on" });
      await startSession(c, user.id);
      return c.redirect("/", 302);
    } catch (e) {
      const code = e instanceof OidcError ? e.code : "provider";
      logger.warn("single sign-on refused", { reason: code, error: (e as Error).message });
      return c.redirect(`/?signin_error=${code}`, 302);
    }
  });

  // Behind requireSession + CSRF (mounted after them in app.ts).
  const signedIn = new Hono<AuthEnv>();
  signedIn.post("/logout", (c) => {
    sessions.destroy(c.get("session").idHash);
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure });
    return c.body(null, 204);
  });

  return { public: app, signedIn };
}

/** Origin check on every state-changing /api request, including login and setup. */
export function originGuard(publicUrl?: string): MiddlewareHandler {
  return async (c, next) => {
    if (UNSAFE.has(c.req.method) && !originAllowed(c, publicUrl)) {
      return c.json({ error: "cross-origin request refused" }, 403);
    }
    await next();
  };
}

/**
 * Sign-in by a trusted reverse proxy (D70). A request from one of the proxies, naming a member of the group,
 * gets a session for that person: the cookie's, when it is theirs, else a new one (a different person's is
 * ended). A non-member gets none, and the sign-in page says why. Requests not from a proxy are untouched.
 */
export function trustedHeaderSession(deps: AuthDeps): MiddlewareHandler<AuthEnv> {
  const secure = deps.publicUrl?.startsWith("https:") ?? false;
  return async (c, next) => {
    if (!deps.trusted) return await next();
    const who = trustedUser(deps.trusted, (deps.peer ?? clientIp)(c), (n) => c.req.header(n));
    if (who === "refused") {
      c.set("proxyRefused", c.req.header(deps.trusted.userHeader)!.trim());
      return await next();
    }
    if (!who) return await next();
    const externalId = `header:${who.name.toLowerCase()}`;
    const current = await deps.sessions.get(getCookie(c, SESSION_COOKIE));
    if (current?.externalId === externalId) {
      c.set("session", current);
      return await next();
    }
    if (current) deps.sessions.destroy(current.idHash);
    const user = findOrCreateExternalUser(deps.db, externalId, who.name, Date.now());
    const created = await deps.sessions.create(user.id);
    setCookie(c, SESSION_COOKIE, created.id, {
      httpOnly: true,
      sameSite: "Lax",
      secure,
      path: "/",
      maxAge: Math.floor(deps.sessionMaxMs / 1000),
    });
    c.set("session", (await deps.sessions.get(created.id))!);
    deps.logger.info("login", { user: user.username, via: "proxy" });
    await next();
  };
}

export function requireSession(sessions: SessionStore): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (c.get("session")) return await next();
    const s = await sessions.get(getCookie(c, SESSION_COOKIE));
    if (!s) return c.json({ error: "authentication required" }, 401);
    c.set("session", s);
    await next();
  };
}

export function requireCsrf(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (UNSAFE.has(c.req.method)) {
      const token = c.req.header(CSRF_HEADER);
      if (!token || !safeEqual(token, c.get("session").csrfToken)) {
        return c.json({ error: "missing or invalid CSRF token" }, 403);
      }
    }
    await next();
  };
}
