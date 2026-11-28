/** Single sign-on through the HTTP routes (D69): the round trip, accounts, and refusals. */
import { assert, assertEquals } from "@std/assert";
import { OidcLogin } from "../../server/auth/oidc.ts";
import type { AuthState } from "../../shared/types.ts";
import { cookieFrom, makeTestApp, ORIGIN, PASSWORD, signIn, type TestApp } from "../helpers/app.ts";
import { fakeIdp, ISSUER } from "../helpers/fake_idp.ts";

async function app() {
  const idp = fakeIdp();
  const login = new OidcLogin({
    issuer: ISSUER,
    clientId: "tagmonia",
    clientSecret: "s3cret",
    group: "tagmonia",
    groupsClaim: "groups",
    scopes: "openid profile email groups",
    redirectUri: `${ORIGIN}/api/auth/oidc/callback`,
  }, { fetch: idp.fetch });
  const t = await makeTestApp({ oidc: { login, name: "Authentik" }, config: { publicUrl: ORIGIN } });
  return { t, idp };
}

/** Start, play the provider, come back: the callback's response. */
async function roundTrip(t: TestApp, idp: ReturnType<typeof fakeIdp>) {
  const start = await t.request("/api/auth/oidc/start");
  assertEquals(start.status, 302);
  const to = new URL(start.headers.get("location")!);
  idp.state.nonce = to.searchParams.get("nonce")!;
  const back = await t.request(
    `/api/auth/oidc/callback?code=good-code&state=${encodeURIComponent(to.searchParams.get("state")!)}`,
    { cookie: cookieFrom(start) },
  );
  return { start, back };
}

/** The session cookie of a response that also clears the pending sign-in's. */
const sessionCookie = (res: Response) =>
  res.headers.getSetCookie().find((c) => c.startsWith("tagmonia_session="))!.split(";")[0];

const session = async (t: TestApp, cookie: string) =>
  (await (await t.request("/api/auth/session", { cookie })).json()) as AuthState;

Deno.test("signed in through the provider: a session, the provider's name, the same account next time", async () => {
  const { t, idp } = await app();
  try {
    await signIn(t); // the local admin, the fallback
    const anon = (await (await t.request("/api/auth/session")).json()) as AuthState;
    assertEquals(anon.sso, { name: "Authentik" });
    const { start, back } = await roundTrip(t, idp);
    assert(start.headers.get("set-cookie")!.includes("HttpOnly"), "the pending sign-in's cookie");
    assertEquals([back.status, back.headers.get("location")], [302, "/"]);
    const s = await session(t, sessionCookie(back));
    assertEquals(s.user, { username: "alice", isAdmin: true });
    // The same subject again: the same account, not a new one.
    const again = await roundTrip(t, idp);
    assertEquals((await session(t, sessionCookie(again.back))).user?.username, "alice");
    const n = (t.db.prepare("SELECT count(*) n FROM app_user").get() as { n: number }).n;
    assertEquals(n, 2, "the local admin and alice");
  } finally {
    await t.cleanup();
  }
});

Deno.test("a provider account named like a local user never becomes it, and has no password", async () => {
  const { t, idp } = await app();
  try {
    await signIn(t, "admin");
    idp.state.user = { sub: "u9", preferred_username: "admin", groups: ["tagmonia"] };
    const { back } = await roundTrip(t, idp);
    assertEquals((await session(t, sessionCookie(back))).user?.username, "admin-2");
    const login = (username: string) =>
      t.request("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password: PASSWORD }) });
    assertEquals((await login("admin")).status, 200, "the local admin still signs in");
    assertEquals((await login("admin-2")).status, 401, "the provider's account has no password");
  } finally {
    await t.cleanup();
  }
});

Deno.test("refused sign-ins come back to the sign-in page with a reason, and no session", async () => {
  const { t, idp } = await app();
  try {
    await signIn(t);
    idp.state.user = { sub: "u3", preferred_username: "eve", groups: ["family"] };
    const { back } = await roundTrip(t, idp);
    assertEquals(back.headers.get("location"), "/?signin_error=group");
    assert(!(back.headers.get("set-cookie") ?? "").includes("tagmonia_session="));
    // A callback without the start's cookie (another browser, a forged link).
    const stray = await t.request("/api/auth/oidc/callback?code=good-code&state=x");
    assertEquals(stray.headers.get("location"), "/?signin_error=expired");
  } finally {
    await t.cleanup();
  }
});

Deno.test("without single sign-on configured, its routes do not exist", async () => {
  const t = await makeTestApp();
  try {
    assertEquals((await t.request("/api/auth/oidc/start")).status, 404);
    assertEquals(((await (await t.request("/api/auth/session")).json()) as AuthState).sso, null);
  } finally {
    await t.cleanup();
  }
});
