import { assert, assertEquals, assertMatch } from "@std/assert";
import { bootstrapAdmin } from "../../server/auth/bootstrap.ts";
import { SessionStore } from "../../server/auth/sessions.ts";
import { PUBLIC_API, SESSION_COOKIE } from "../../server/http/auth.ts";
import { countUsers } from "../../server/db/repo/users.ts";
import { createLogger } from "../../server/log.ts";
import type { AuthState } from "../../shared/types.ts";
import { cookieFrom, makeTestApp, memoryDb, PASSWORD, signIn, type TestApp } from "../helpers/app.ts";

async function withApp(fn: (t: TestApp) => Promise<void>, opts?: Parameters<typeof makeTestApp>[0]) {
  const t = await makeTestApp(opts);
  try {
    await fn(t);
  } finally {
    await t.cleanup();
  }
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

Deno.test("every /api route except health and the public auth routes requires a session (safety rule 8)", () =>
  withApp(async (t) => {
    const routes = t.app.routes.filter((r) => r.path.startsWith("/api/") && r.method !== "ALL");
    assert(routes.length >= 8, `expected the API routes to be registered, got ${routes.length}`);
    const checked: string[] = [];
    for (const r of routes) {
      const key = `${r.method} ${r.path}`;
      if (r.path.startsWith("/api/health") || PUBLIC_API.has(key)) continue;
      const path = r.path.replace(/:\w+(\{[^}]+\})?/g, "1").replace(/\*/g, "x");
      const res = await t.request(path, { method: r.method, body: r.method === "GET" ? undefined : "{}" });
      assertEquals(res.status, 401, `${key} answered ${res.status} without a session`);
      checked.push(key);
    }
    for (const k of ["GET /api/library/summary", "POST /api/library/scan", "POST /api/auth/logout"]) {
      assert(checked.includes(k), `${k} was not checked; routes: ${checked.join(", ")}`);
    }
    // Every public route is a real route (no stale allowlist entries).
    for (const k of PUBLIC_API) assert(routes.some((r) => `${r.method} ${r.path}` === k), `${k} is not registered`);
  }));

Deno.test("first-run setup creates the admin once, signs in, and sets a hardened cookie", () =>
  withApp(async (t) => {
    let state: AuthState = await (await t.request("/api/auth/session")).json();
    assertEquals(state, { setupRequired: true, user: null, csrfToken: null });

    assertEquals((await t.request("/api/auth/setup", json({ username: "admin", password: "short" }))).status, 400);

    const res = await t.request("/api/auth/setup", json({ username: "admin", password: PASSWORD }));
    assertEquals(res.status, 201);
    const setCookie = res.headers.get("set-cookie")!;
    assertMatch(setCookie, new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43};`));
    assertMatch(setCookie, /HttpOnly/);
    assertMatch(setCookie, /SameSite=Lax/);
    assert(!/Secure/.test(setCookie), "no Secure flag without an https public URL");

    state = await (await t.request("/api/auth/session", { cookie: cookieFrom(res) })).json();
    assertEquals(state.setupRequired, false);
    assertEquals(state.user, { username: "admin", isAdmin: true });
    assert(state.csrfToken && state.csrfToken.length >= 43);

    const again = await t.request("/api/auth/setup", json({ username: "mallory", password: PASSWORD }));
    assertEquals(again.status, 409);
    assertEquals(countUsers(t.db), 1);
  }));

Deno.test("concurrent setup requests create exactly one admin", () =>
  withApp(async (t) => {
    const results = await Promise.all(
      ["a", "b", "c", "d"].map((u) => t.request("/api/auth/setup", json({ username: u, password: PASSWORD }))),
    );
    assertEquals(results.filter((r) => r.status === 201).length, 1);
    assertEquals(countUsers(t.db), 1);
  }));

Deno.test("the session cookie is Secure when TAGMONIA_PUBLIC_URL is https", () =>
  withApp(async (t) => {
    const res = await t.request("/api/auth/setup", {
      ...json({ username: "admin", password: PASSWORD }),
      origin: "https://tagmonia.example",
    });
    assertEquals(res.status, 201);
    assertMatch(res.headers.get("set-cookie")!, /Secure/);
  }, { env: { TAGMONIA_PUBLIC_URL: "https://tagmonia.example" } }));

Deno.test("login: wrong password and unknown user give the same answer; then throttled with Retry-After", () =>
  withApp(async (t) => {
    await signIn(t);
    const wrong = await t.request("/api/auth/login", json({ username: "admin", password: "nope" }));
    const unknown = await t.request("/api/auth/login", json({ username: "ghost", password: "nope" }));
    assertEquals([wrong.status, unknown.status], [401, 401]);
    assertEquals(await wrong.json(), await unknown.json());

    for (let i = 0; i < 4; i++) await t.request("/api/auth/login", json({ username: "admin", password: "nope" }));
    const blocked = await t.request("/api/auth/login", json({ username: "admin", password: PASSWORD }));
    assertEquals(blocked.status, 429, "even the right password waits while throttled");
    assert(Number(blocked.headers.get("retry-after")) >= 1);
  }));

Deno.test("login succeeds with the right password and logout ends the session", () =>
  withApp(async (t) => {
    await signIn(t);
    const res = await t.request("/api/auth/login", json({ username: "ADMIN", password: PASSWORD }));
    assertEquals(res.status, 200, "usernames are case-insensitive");
    const cookie = cookieFrom(res);
    const { csrfToken } = await res.json() as AuthState;
    assertEquals((await t.request("/api/library/summary", { cookie })).status, 200);

    assertEquals((await t.request("/api/auth/logout", { method: "POST", cookie })).status, 403, "CSRF required");
    assertEquals((await t.request("/api/auth/logout", { method: "POST", cookie, csrf: csrfToken! })).status, 204);
    assertEquals((await t.request("/api/library/summary", { cookie })).status, 401);
  }));

Deno.test("state-changing requests need the session's CSRF token", () =>
  withApp(async (t) => {
    const { cookie, csrf } = await signIn(t);
    assertEquals((await t.request("/api/library/scan", { method: "POST", cookie })).status, 403);
    assertEquals((await t.request("/api/library/scan", { method: "POST", cookie, csrf: "x".repeat(43) })).status, 403);
    assertEquals((await t.request("/api/library/scan", { method: "POST", cookie, csrf })).status, 202);
  }));

Deno.test("cross-origin or origin-less POSTs are refused, including login (login CSRF)", () =>
  withApp(async (t) => {
    const { cookie, csrf } = await signIn(t);
    const body = JSON.stringify({ username: "admin", password: PASSWORD });
    assertEquals((await t.request("/api/auth/login", { method: "POST", body, origin: null })).status, 403);
    assertEquals(
      (await t.request("/api/auth/login", { method: "POST", body, origin: "https://evil.example" })).status,
      403,
    );
    assertEquals(
      (await t.request("/api/library/scan", { method: "POST", cookie, csrf, origin: "https://evil.example" })).status,
      403,
    );
    // A Referer from the same host is accepted when a browser omits Origin.
    const viaReferer = await t.request("/api/auth/login", {
      method: "POST",
      body,
      origin: null,
      headers: { referer: "http://tagmonia.test/login" },
    });
    assertEquals(viaReferer.status, 200);
  }));

Deno.test("signed-in requests to unknown API routes get a JSON 404", () =>
  withApp(async (t) => {
    const { cookie } = await signIn(t);
    const res = await t.request("/api/nope", { cookie });
    assertEquals(res.status, 404);
    assertEquals(await res.json(), { error: "not found" });
  }));

Deno.test("sessions expire after the idle timeout and the absolute lifetime", async () => {
  const db = await memoryDb();
  let now = 1_000_000;
  const store = new SessionStore(db, { idleMs: 60 * 60_000, maxMs: 3 * 60 * 60_000 }, () => now);
  db.prepare("INSERT INTO app_user (username, password_hash, created_at) VALUES ('u', 'x', 0)").run();

  const idle = await store.create(1);
  now += 59 * 60_000;
  assert(await store.get(idle.id), "still alive within the idle window");
  now += 61 * 60_000;
  assertEquals(await store.get(idle.id), undefined, "idle timeout");

  const active = await store.create(1);
  for (const minute of [50, 100, 150]) {
    now += 50 * 60_000;
    assert(await store.get(active.id), `a request at +${minute} min keeps it alive`);
  }
  now += 50 * 60_000; // +200 min, past the 3 h lifetime
  assertEquals(await store.get(active.id), undefined, "absolute lifetime ends even an active session");

  const stored = db.prepare("SELECT id_hash FROM session").all() as { id_hash: string }[];
  assert(stored.every((r) => r.id_hash !== active.id && r.id_hash !== idle.id), "only hashes are stored");
  db.close();
});

Deno.test("TAGMONIA_ADMIN_PASSWORD_FILE creates 'admin' once and is ignored afterwards", async () => {
  const db = await memoryDb();
  const dir = await Deno.makeTempDir();
  try {
    const file = `${dir}/pw`;
    await Deno.writeTextFile(file, `${PASSWORD}\n`);
    assertEquals(await bootstrapAdmin(db, file, createLogger("error")), true);
    assertEquals(await bootstrapAdmin(db, file, createLogger("error")), false);
    assertEquals(countUsers(db), 1);
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("login logs never contain the password or session cookie (§14.3)", async () => {
  const lines: string[] = [];
  const logger = createLogger("debug", (l) => lines.push(l));
  await withApp(async (t) => {
    const { cookie } = await signIn(t);
    await t.request("/api/auth/login", json({ username: "admin", password: "hunter2-wrong" }));
    await t.request("/api/auth/login", json({ username: "admin", password: PASSWORD }));
    const all = lines.join("\n");
    assert(lines.length >= 2, "login events are logged");
    assert(!all.includes("hunter2-wrong") && !all.includes(PASSWORD), all);
    assert(!all.includes(cookie.split("=")[1]), all);
  }, { logger });
});
