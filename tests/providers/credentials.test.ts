import { assert, assertEquals, assertRejects } from "@std/assert";
import { CredentialError, CredentialStore } from "../../server/providers/credentials.ts";
import { Vault } from "../../server/secrets/vault.ts";
import { memoryDb } from "../helpers/app.ts";

async function setup(env = {}) {
  const db = await memoryDb();
  const vault = await Vault.open({ secretKey: "k".repeat(40), configDir: "/nonexistent" });
  return { db, store: new CredentialStore(db, vault, env), vault };
}

Deno.test("saved secrets are encrypted in the database and never reported back", async () => {
  const { db, store } = await setup();
  await store.set("discogs", { consumerKey: "KEY-123", consumerSecret: "SECRET-456" }, 1);
  const raw = JSON.stringify(db.prepare("SELECT * FROM credential").all());
  assert(!raw.includes("KEY-123") && !raw.includes("SECRET-456"), "no plaintext in the database");
  assertEquals(await store.get("discogs"), { consumerKey: "KEY-123", consumerSecret: "SECRET-456" });
  const status = await store.status("discogs");
  assertEquals(status.map((f) => [f.key, f.set, f.source, f.value]), [
    ["consumerKey", true, "app", null],
    ["consumerSecret", true, "app", null],
  ]);
  assert(!JSON.stringify(status).includes("KEY-123"));
  assertEquals(await store.configured("discogs"), true);
});

Deno.test("non-secret fields are shown; removing a field with null or an empty string", async () => {
  const { store } = await setup();
  await store.set("jellyfin", { url: "http://jf:8096", apiKey: "jf-key", library: "Music" }, 1);
  const s = await store.status("jellyfin");
  assertEquals(s.map((f) => f.value), ["http://jf:8096", null, "Music"]);
  await store.set("jellyfin", { library: "" }, 2);
  assertEquals((await store.get("jellyfin")).library, undefined);
  assertEquals(await store.configured("jellyfin"), true, "the library is optional");
});

Deno.test("environment values win, are reported as such, and cannot be changed in the app", async () => {
  const { store } = await setup({ acoustid: { apiKey: "from-env" } });
  assertEquals(await store.get("acoustid"), { apiKey: "from-env" });
  assertEquals((await store.status("acoustid"))[0].source, "environment");
  assertEquals((await store.status("acoustid"))[0].value, null, "still secret");
  await assertRejects(() => store.set("acoustid", { apiKey: "x" }, 1), CredentialError, "TAGMONIA_ACOUSTID_KEY");
});

Deno.test("values are validated: URLs, unknown fields and providers", async () => {
  const { store } = await setup();
  await assertRejects(() => store.set("jellyfin", { url: "ftp://jf" }, 1), CredentialError, "http(s)");
  await assertRejects(() => store.set("jellyfin", { url: "https://u:p@jf" }, 1), CredentialError, "credentials");
  await assertRejects(() => store.set("discogs", { token: "x" }, 1), CredentialError, "no field");
  // deno-lint-ignore no-explicit-any
  await assertRejects(() => store.set("nope" as any, { a: "b" }, 1), CredentialError);
});

Deno.test("a value saved under another secret key is reported unreadable, not fatal", async () => {
  const { db, store } = await setup();
  await store.set("acoustid", { apiKey: "k1" }, 1);
  const other = new CredentialStore(db, await Vault.open({ secretKey: "z".repeat(40), configDir: "/x" }), {});
  assertEquals(await other.get("acoustid"), {});
  const [f] = await other.status("acoustid");
  assert(f.set && f.error?.includes("TAGMONIA_SECRET_KEY"));
  assertEquals(await other.configured("acoustid"), false);
});
