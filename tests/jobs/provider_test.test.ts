/** Provider health checks on scripted responses; never a live provider in the default run. */
import { assert, assertEquals } from "@std/assert";
import { type ProviderTestDeps, testProvider } from "../../server/jobs/provider_test.ts";
import { CredentialStore } from "../../server/providers/credentials.ts";
import type { MusicBrainzClient } from "../../server/providers/musicbrainz/client.ts";
import { Vault } from "../../server/secrets/vault.ts";
import { memoryDb } from "../helpers/app.ts";

async function deps(responses: Response[], creds: Record<string, Record<string, string>> = {}) {
  const db = await memoryDb();
  const store = new CredentialStore(db, await Vault.open({ secretKey: "k".repeat(40), configDir: "/x" }), creds);
  const seen: { url: string; auth: string | null; body: string }[] = [];
  const d: ProviderTestDeps = {
    db,
    creds: store,
    mb: { lookupRelease: () => Promise.resolve({ value: {}, snapshotId: 1 }) } as unknown as MusicBrainzClient,
    userAgent: "Tagmonia/test",
    version: "test",
    fetch: (input, init) => {
      seen.push({
        url: String(input),
        auth: new Headers(init?.headers).get("authorization"),
        body: String(init?.body ?? ""),
      });
      return Promise.resolve(responses.shift() ?? new Response(null, { status: 500 }));
    },
  };
  return { d, seen, db };
}

const err = (code: number) => Response.json({ status: "error", error: { code, message: "x" } }, { status: 400 });

Deno.test("AcoustID: an invalid-fingerprint error means the key works; code 4 means it does not", async () => {
  let s = await deps([err(3)], { acoustid: { apiKey: "AK" } });
  assertEquals(await testProvider("acoustid", s.d), { ok: true, message: "API key accepted" });
  assert(s.seen[0].body.includes("client=AK") && !s.seen[0].url.includes("AK"), "key in the body only");
  s = await deps([err(4)], { acoustid: { apiKey: "AK" } });
  assertEquals((await testProvider("acoustid", s.d)).ok, false);
  s = await deps([]);
  assertEquals(await testProvider("acoustid", s.d), { ok: false, message: "no API key" });
});

Deno.test("Discogs: key and secret in the Authorization header; 401 reported as rejected", async () => {
  let s = await deps([Response.json({ results: [] })], { discogs: { consumerKey: "CK", consumerSecret: "CS" } });
  assertEquals((await testProvider("discogs", s.d)).ok, true);
  assertEquals(s.seen[0].auth, "Discogs key=CK, secret=CS");
  s = await deps([new Response(null, { status: 401 })], { discogs: { consumerKey: "CK", consumerSecret: "CS" } });
  const r = await testProvider("discogs", s.d);
  assertEquals(r.ok, false);
  assert(!r.message.includes("CK") && !r.message.includes("CS"), "no credential in the message");
});

Deno.test("Jellyfin: the configured library must exist", async () => {
  const folders = Response.json([{ Name: "Music", ItemId: "a", Locations: [] }]);
  const s = await deps([folders], { jellyfin: { url: "http://jf:8096", apiKey: "JK", library: "MusicTest" } });
  assertEquals(await testProvider("jellyfin", s.d), { ok: false, message: 'no library named "MusicTest"' });
});

Deno.test("Deezer and iTunes need no credentials", async () => {
  const s = await deps([Response.json({ id: 302127 }), new Response("{}")]);
  assertEquals((await testProvider("deezer", s.d)).ok, true);
  assertEquals((await testProvider("itunes", s.d)).ok, true);
  assertEquals(s.seen.map((x) => new URL(x.url).host), ["api.deezer.com", "itunes.apple.com"]);
});
