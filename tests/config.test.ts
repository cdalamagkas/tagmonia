import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "node:path";
import { loadConfig, resolveAcoustidKey, resolveJellyfinKey } from "../server/config.ts";

const SECRET = "s3cret-acoustid-key";

Deno.test("the AcoustID key comes from the environment or a secret file, and is optional", async () => {
  assertEquals(await resolveAcoustidKey(loadConfig({})), undefined);
  assertEquals(await resolveAcoustidKey(loadConfig({ TAGMONIA_ACOUSTID_KEY: SECRET })), SECRET);

  const dir = await Deno.makeTempDir({ prefix: "tagmonia-cfg-" });
  try {
    const file = join(dir, "acoustid");
    await Deno.writeTextFile(file, `${SECRET}\n`);
    assertEquals(await resolveAcoustidKey(loadConfig({ TAGMONIA_ACOUSTID_KEY_FILE: file })), SECRET);
    await Deno.writeTextFile(file, "  \n");
    await assertRejects(() => resolveAcoustidKey(loadConfig({ TAGMONIA_ACOUSTID_KEY_FILE: file })), Error, "empty");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("setting both AcoustID key variables is a startup error that does not echo the key", () => {
  const e = assertThrows(() =>
    loadConfig({ TAGMONIA_ACOUSTID_KEY: SECRET, TAGMONIA_ACOUSTID_KEY_FILE: "/run/secrets/acoustid" })
  );
  assertEquals((e as Error).message.includes(SECRET), false);
});

Deno.test("an unreadable key file names the path, never contents", async () => {
  await assertRejects(
    () => resolveAcoustidKey(loadConfig({ TAGMONIA_ACOUSTID_KEY_FILE: "/nonexistent/acoustid" })),
    Error,
    "/nonexistent/acoustid",
  );
});

Deno.test("a Jellyfin key needs a Jellyfin URL; the key comes from a variable or a file", async () => {
  assertThrows(() => loadConfig({ TAGMONIA_JELLYFIN_KEY: SECRET }), Error, "TAGMONIA_JELLYFIN_URL");
  const c = loadConfig({ TAGMONIA_JELLYFIN_URL: "http://jellyfin:8096", TAGMONIA_JELLYFIN_KEY: SECRET });
  assertEquals(await resolveJellyfinKey(c), SECRET);
  assertEquals(await resolveJellyfinKey(loadConfig({})), undefined);
});

Deno.test("single sign-on: all four settings or none, an https issuer, and the public URL (D69)", () => {
  const base = { TAGMONIA_PUBLIC_URL: "https://tagmonia.example" };
  const sso = {
    TAGMONIA_OIDC_ISSUER: "https://auth.example/application/o/tagmonia/",
    TAGMONIA_OIDC_CLIENT_ID: "tagmonia",
    TAGMONIA_OIDC_CLIENT_SECRET: "s",
    TAGMONIA_OIDC_GROUP: "tagmonia",
  };
  const c = loadConfig({ ...base, ...sso });
  assertEquals(
    [c.oidc?.issuer, c.oidc?.group, c.oidc?.groupsClaim, c.oidc?.name],
    [sso.TAGMONIA_OIDC_ISSUER, "tagmonia", "groups", "auth.example"],
  );
  assertEquals(loadConfig(base).oidc, undefined);
  assertThrows(() => loadConfig({ ...base, TAGMONIA_OIDC_ISSUER: sso.TAGMONIA_OIDC_ISSUER }), Error, "needs all of");
  const { TAGMONIA_OIDC_GROUP: _g, ...noGroup } = sso;
  assertThrows(() => loadConfig({ ...base, ...noGroup }), Error, "TAGMONIA_OIDC_GROUP");
  assertThrows(() => loadConfig({ ...sso }), Error, "TAGMONIA_PUBLIC_URL");
  assertThrows(() => loadConfig({ ...base, ...sso, TAGMONIA_OIDC_ISSUER: "http://auth.example/" }), Error);
  const secretMessage = (() => {
    try {
      loadConfig({ ...base, ...sso, TAGMONIA_OIDC_ISSUER: "http://auth.example/" });
    } catch (e) {
      return (e as Error).message;
    }
  })();
  assertEquals(secretMessage?.includes("s3cret") || secretMessage?.includes('"s"'), false, "no value echoed");
});

Deno.test("sign-in by a proxy: header, proxies and group together, the proxies parsed at startup (D70)", () => {
  const all = {
    TAGMONIA_TRUSTED_HEADER: "Remote-User",
    TAGMONIA_TRUSTED_PROXIES: "172.18.0.0/16, 10.0.0.5",
    TAGMONIA_TRUSTED_GROUP: "tagmonia",
  };
  const c = loadConfig(all);
  assertEquals([c.trustedHeader?.userHeader, c.trustedHeader?.groupsHeader, c.trustedHeader?.proxies.length], [
    "Remote-User",
    "Remote-Groups",
    2,
  ]);
  assertEquals(loadConfig({}).trustedHeader, undefined);
  assertThrows(() => loadConfig({ TAGMONIA_TRUSTED_HEADER: "Remote-User" }), Error, "needs all of");
  assertThrows(() => loadConfig({ ...all, TAGMONIA_TRUSTED_PROXIES: "everyone" }), Error, "TAGMONIA_TRUSTED_PROXIES");
  assertThrows(() => loadConfig({ ...all, TAGMONIA_TRUSTED_HEADER: "Remote User" }), Error);
});
