import { assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import { DEFAULT_SETTINGS, loadSettings } from "../server/settings.ts";

async function load(json: unknown) {
  const dir = await Deno.makeTempDir({ prefix: "tagmonia-settings-" });
  try {
    await Deno.writeTextFile(join(dir, "settings.json"), JSON.stringify(json));
    return await loadSettings(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("MusicBrainz defaults to the public server at 1 request per second", () => {
  assertEquals(DEFAULT_SETTINGS.providers.musicbrainz, {
    baseUrl: "https://musicbrainz.org/ws/2/",
    requestsPerSecond: 1,
  });
});

Deno.test("musicbrainz.org cannot be configured above 1 request per second", async () => {
  await assertRejects(
    () => load({ providers: { musicbrainz: { requestsPerSecond: 5 } } }),
    Error,
    "providers.musicbrainz.requestsPerSecond",
  );
  await assertRejects(() =>
    load({ providers: { musicbrainz: { baseUrl: "https://beta.musicbrainz.org/ws/2/", requestsPerSecond: 2 } } })
  );
});

Deno.test("a local mirror may go faster", async () => {
  const s = await load({ providers: { musicbrainz: { baseUrl: "http://mb.lan:5000/ws/2/", requestsPerSecond: 20 } } });
  assertEquals(s.providers.musicbrainz.requestsPerSecond, 20);
});
