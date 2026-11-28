/** Sign-in by a trusted reverse proxy through the HTTP routes (D70). */
import { assert, assertEquals } from "@std/assert";
import type { Context } from "hono";
import type { AuthState } from "../../shared/types.ts";
import { parseProxies } from "../../server/auth/trusted_header.ts";
import { makeTestApp, PASSWORD, signIn, type TestApp } from "../helpers/app.ts";

const PROXY = "172.18.0.2";

async function app() {
  // The peer address comes from a request header the test sets: in-process requests have no connection.
  const t = await makeTestApp({
    config: {
      trustedHeader: {
        userHeader: "Remote-User",
        groupsHeader: "Remote-Groups",
        group: "tagmonia",
        proxies: parseProxies("172.18.0.0/16"),
      },
    },
    peer: (c: Context) => c.req.header("x-test-peer") ?? "unknown",
  });
  await signIn(t); // the local admin, the fallback
  return t;
}

const via = (peer: string, user?: string, groups = "tagmonia", extra: Record<string, string> = {}) => ({
  "x-test-peer": peer,
  ...(user ? { "Remote-User": user, "Remote-Groups": groups } : {}),
  ...extra,
});

async function probe(t: TestApp, headers: Record<string, string>, cookie?: string) {
  const res = await t.request("/api/auth/session", { headers, cookie });
  const set = res.headers.getSetCookie().find((c) => c.startsWith("tagmonia_session="));
  return { state: (await res.json()) as AuthState, cookie: set?.split(";")[0] ?? cookie };
}

Deno.test("the proxy's user gets a session at once, marked as signed in by the proxy, and can work", async () => {
  const t = await app();
  try {
    const { state, cookie } = await probe(t, via(PROXY, "alice"));
    assertEquals(state.user, { username: "alice", isAdmin: true, signedInBy: "proxy" });
    // The same person next time: the same session, no new one.
    const again = await probe(t, via(PROXY, "alice"), cookie);
    assertEquals([again.state.csrfToken, again.cookie], [state.csrfToken, cookie]);
    const res = await t.request("/api/library/scan", {
      method: "POST",
      headers: via(PROXY, "alice"),
      cookie,
      csrf: state.csrfToken!,
    });
    assertEquals(res.status, 202, "a state-changing request with the session's CSRF token");
  } finally {
    await t.cleanup();
  }
});

Deno.test("headers from anywhere else mean nothing, X-Forwarded-For included", async () => {
  const t = await app();
  try {
    const direct = await probe(t, via("192.168.1.50", "alice"));
    assertEquals(direct.state.user, null);
    const forged = await probe(t, via("192.168.1.50", "alice", "tagmonia", { "X-Forwarded-For": PROXY }));
    assertEquals(forged.state.user, null);
    assertEquals((await t.request("/api/library/summary", { headers: via("192.168.1.50", "alice") })).status, 401);
  } finally {
    await t.cleanup();
  }
});

Deno.test("another person through the proxy ends the previous session; a non-member gets none", async () => {
  const t = await app();
  try {
    const alice = await probe(t, via(PROXY, "alice"));
    const bob = await probe(t, via(PROXY, "bob"), alice.cookie);
    assertEquals(bob.state.user?.username, "bob");
    assert(bob.cookie !== alice.cookie);
    // Alice's cookie is no longer a session, even without the proxy.
    assertEquals((await probe(t, via("192.168.1.50"), alice.cookie)).state.user, null);
    const eve = await probe(t, via(PROXY, "eve", "family"));
    assertEquals([eve.state.user, eve.state.proxyRefused], [null, "eve"]);
  } finally {
    await t.cleanup();
  }
});

Deno.test("the local password still works, and a proxy account named like a local user stays separate", async () => {
  const t = await app();
  try {
    const login = await t.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: PASSWORD }),
      headers: via("192.168.1.50"),
    });
    assertEquals(login.status, 200);
    const proxyAdmin = await probe(t, via(PROXY, "admin"));
    assertEquals(proxyAdmin.state.user, { username: "admin-2", isAdmin: true, signedInBy: "proxy" });
  } finally {
    await t.cleanup();
  }
});

Deno.test("without proxy sign-in configured, the headers are ignored", async () => {
  const t = await makeTestApp({ peer: () => PROXY });
  try {
    await signIn(t);
    assertEquals((await probe(t, via(PROXY, "alice"))).state.user, null);
  } finally {
    await t.cleanup();
  }
});
