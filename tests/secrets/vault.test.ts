import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import { KEY_FILE, Vault, VaultError } from "../../server/secrets/vault.ts";

async function tempDir() {
  return await Deno.makeTempDir({ prefix: "tagmonia-vault-" });
}

Deno.test("values round-trip, and each encryption differs (random IV)", async () => {
  const v = await Vault.open({ secretKey: "x".repeat(40), configDir: "/nonexistent" });
  const a = await v.encrypt("s3cret", "discogs:consumerKey");
  const b = await v.encrypt("s3cret", "discogs:consumerKey");
  assertNotEquals(a, b);
  assert(!a.includes("s3cret"));
  assertEquals(await v.decrypt(a, "discogs:consumerKey"), "s3cret");
});

Deno.test("a ciphertext is bound to its slot: it cannot be moved to another field", async () => {
  const v = await Vault.open({ secretKey: "x".repeat(40), configDir: "/nonexistent" });
  const blob = await v.encrypt("s3cret", "discogs:consumerKey");
  await assertRejects(() => v.decrypt(blob, "jellyfin:apiKey"), VaultError);
});

Deno.test("another secret key cannot read it", async () => {
  const a = await Vault.open({ secretKey: "a".repeat(40), configDir: "/nonexistent" });
  const b = await Vault.open({ secretKey: "b".repeat(40), configDir: "/nonexistent" });
  const blob = await a.encrypt("v", "p:k");
  await assertRejects(() => b.decrypt(blob, "p:k"), VaultError, "TAGMONIA_SECRET_KEY");
});

Deno.test("without TAGMONIA_SECRET_KEY a key file is created 0600 and reused", async () => {
  const dir = await tempDir();
  try {
    const blob = await (await Vault.open({ configDir: dir })).encrypt("v", "p:k");
    const st = await Deno.stat(join(dir, KEY_FILE));
    assertEquals(st.mode! & 0o777, 0o600);
    assertEquals(await (await Vault.open({ configDir: dir })).decrypt(blob, "p:k"), "v");
    // A key file readable by others is tightened.
    await Deno.chmod(join(dir, KEY_FILE), 0o644);
    await Vault.open({ configDir: dir });
    assertEquals((await Deno.stat(join(dir, KEY_FILE))).mode! & 0o777, 0o600);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
