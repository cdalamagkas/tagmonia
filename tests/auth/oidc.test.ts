/** Single sign-on (D69): the flow, the group rule, and what is refused. */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { inGroup, OidcError, OidcLogin } from "../../server/auth/oidc.ts";
import { fakeIdp, ISSUER } from "../helpers/fake_idp.ts";

const REDIRECT = "https://tagmonia.test/api/auth/oidc/callback";

function setup(now = () => Date.now()) {
  const idp = fakeIdp();
  const login = new OidcLogin({
    issuer: ISSUER,
    clientId: "tagmonia",
    clientSecret: "s3cret",
    group: "tagmonia",
    groupsClaim: "groups",
    scopes: "openid profile email groups",
    redirectUri: REDIRECT,
  }, { fetch: idp.fetch, now });
  /** Starts, then plays the provider: the callback URL it would send the browser to. */
  const round = async (code = "good-code") => {
    const { key, url } = await login.start();
    idp.state.nonce = url.searchParams.get("nonce")!;
    const back = new URL(REDIRECT);
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state")!);
    return { key, url, back };
  };
  return { idp, login, round };
}

Deno.test("the authorization request carries PKCE (S256), state, nonce, the scopes and the callback", async () => {
  const { round } = setup();
  const { url } = await round();
  assertEquals(url.origin + url.pathname, "https://idp.test/authorize");
  const q = url.searchParams;
  assertEquals([q.get("client_id"), q.get("redirect_uri"), q.get("response_type"), q.get("code_challenge_method")], [
    "tagmonia",
    REDIRECT,
    "code",
    "S256",
  ]);
  assertEquals(q.get("scope"), "openid profile email groups");
  assert(q.get("state") && q.get("nonce") && q.get("code_challenge"));
  assert(!url.href.includes("s3cret"), "the secret never goes to the browser");
});

Deno.test("a member of the group gets in, named by preferred_username, identified by issuer and subject", async () => {
  const { login, round } = setup();
  const { key, back } = await round();
  assertEquals(await login.finish(key, back), { externalId: `oidc:${ISSUER}#u1`, name: "alice" });
});

Deno.test("groups only in the user info are read from there", async () => {
  const { idp, login, round } = setup();
  idp.state.user = { sub: "u2", preferred_username: "bob", groups: ["/tagmonia"], inUserInfo: true };
  const { key, back } = await round();
  assertEquals((await login.finish(key, back)).name, "bob");
  assert(idp.state.seen.includes("GET /userinfo"));
});

Deno.test("refused: not in the group, a replayed or foreign callback, a late one, a bad code", async () => {
  const fail = async (p: Promise<unknown>, code: string) => {
    const e = await assertRejects(() => p, OidcError);
    assertEquals(e.code, code);
  };
  {
    const { idp, login, round } = setup();
    idp.state.user = { sub: "u3", preferred_username: "eve", groups: ["family"] };
    const { key, back } = await round();
    await fail(login.finish(key, back), "group");
  }
  {
    const { login, round } = setup();
    const { key, back } = await round();
    await login.finish(key, back);
    await fail(login.finish(key, back), "expired");
    await fail(login.finish(undefined, back), "expired");
  }
  {
    let t = 1_000_000;
    const { login, round } = setup(() => t);
    const { key, back } = await round();
    t += 11 * 60_000;
    await fail(login.finish(key, back), "expired");
  }
  {
    const { login, round } = setup();
    const { key, back } = await round("bad-code");
    await fail(login.finish(key, back), "provider");
  }
  {
    const { login, round } = setup();
    const { key, back } = await round();
    back.searchParams.set("state", "forged");
    await fail(login.finish(key, back), "provider");
  }
});

Deno.test("group names: a list or one value, any case, Keycloak's leading slash", () => {
  assertEquals(inGroup(["users", "Tagmonia"], "tagmonia"), true);
  assertEquals(inGroup("/tagmonia", "tagmonia"), true);
  assertEquals(inGroup(["tagmonia-admins"], "tagmonia"), false);
  assertEquals(inGroup(undefined, "tagmonia"), false);
  assertEquals(inGroup([1, null], "tagmonia"), false);
});
