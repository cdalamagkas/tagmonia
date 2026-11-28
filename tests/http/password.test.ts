/** Changing your own password in Settings (D71). */
import { assertEquals } from "@std/assert";
import { findOrCreateExternalUser } from "../../server/db/repo/users.ts";
import type { AuthState } from "../../shared/types.ts";
import { cookieFrom, makeTestApp, PASSWORD, signIn } from "../helpers/app.ts";

Deno.test("the current password first; the new one then signs in, other sessions end, this one stays", async () => {
  const t = await makeTestApp();
  try {
    const { cookie, csrf } = await signIn(t);
    const login = (password: string) =>
      t.request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password }) });
    const other = cookieFrom(await login(PASSWORD));
    const change = (body: unknown, auth = { cookie, csrf }) =>
      t.request("/api/auth/password", { method: "POST", ...auth, body: JSON.stringify(body) });

    assertEquals((await change({ current: "wrong-password", next: "brand-new-password" })).status, 403);
    const short = await change({ current: PASSWORD, next: "short" });
    assertEquals([short.status, (await short.json()).error], [400, "at least 10 characters"]);
    assertEquals((await change({ current: PASSWORD, next: "brand-new-password" }, { cookie, csrf: "" })).status, 403);
    assertEquals((await change({ current: PASSWORD, next: "brand-new-password" })).status, 204);

    const me = async (c: string) =>
      ((await (await t.request("/api/auth/session", { cookie: c })).json()) as AuthState).user;
    assertEquals((await me(cookie))?.username, "admin", "the session that changed it stays");
    assertEquals(await me(other), null, "the other session ended");
    assertEquals((await login(PASSWORD)).status, 401);
    assertEquals((await login("brand-new-password")).status, 200);
  } finally {
    await t.cleanup();
  }
});

Deno.test("wrong current passwords are throttled; accounts without a password cannot use it", async () => {
  const t = await makeTestApp();
  try {
    const { cookie, csrf } = await signIn(t);
    let last = 0;
    for (let i = 0; i < 12 && last !== 429; i++) {
      last = (await t.request("/api/auth/password", {
        method: "POST",
        cookie,
        csrf,
        body: JSON.stringify({ current: `wrong-${i}`, next: "brand-new-password" }),
      })).status;
    }
    assertEquals(last, 429);
    // An account from single sign-on: signed in directly through the store, as the callback would.
    const alice = findOrCreateExternalUser(t.db, "oidc:https://idp/#u1", "alice", 1);
    const s = await t.ctx.sessions.create(alice.id);
    const r = await t.request("/api/auth/password", {
      method: "POST",
      cookie: `tagmonia_session=${s.id}`,
      csrf: s.csrfToken,
      body: JSON.stringify({ current: "x", next: "brand-new-password" }),
    });
    assertEquals(r.status, 409);
  } finally {
    await t.cleanup();
  }
});
