import { assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import { DEFAULT_SETTINGS, loadSettings, SettingsError, updateSettings } from "../server/settings.ts";

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

Deno.test("updating settings validates, writes the file, applies in place and reports restart-only changes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tagmonia-settings-" });
  try {
    const s = await loadSettings(dir);
    const restart = await updateSettings(dir, s, {
      providers: { discogs: { enabled: false }, musicbrainz: { requestsPerSecond: 0.5 } },
    });
    assertEquals(s.providers.discogs.enabled, false, "applied to the same object");
    assertEquals(restart, ["providers.musicbrainz.requestsPerSecond"]);
    assertEquals((await loadSettings(dir)).providers.discogs.enabled, false, "persisted");
    assertEquals(DEFAULT_SETTINGS.providers.discogs.enabled, true, "the defaults are untouched");
    await assertRejects(() => updateSettings(dir, s, { providers: { discogs: { enabled: "yes" } } }), SettingsError);
    await assertRejects(() => updateSettings(dir, s, { nonsense: 1 }), SettingsError);
    assertEquals(s.providers.discogs.enabled, false, "a rejected change leaves settings as they were");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("covers are embedded at full size by default; the mode changes without a restart (D46, D49)", async () => {
  assertEquals(DEFAULT_SETTINGS.covers.mode, "embed_full");
  const dir = await Deno.makeTempDir({ prefix: "tagmonia-settings-" });
  try {
    const s = await loadSettings(dir);
    assertEquals(await updateSettings(dir, s, { covers: { mode: "both" } }), []);
    assertEquals((await loadSettings(dir)).covers.mode, "both");
    await assertRejects(() => updateSettings(dir, s, { covers: { mode: "huge" } }), SettingsError);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("naming templates: built-in ones to choose from, saved ones checked on save with the reason (D57)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tagmonia-settings-" });
  const s = await loadSettings(dir);
  assertEquals(s.files, { active: "album-year", templates: [] });
  await assertRejects(
    () =>
      updateSettings(dir, s, {
        files: { templates: [{ id: "custom-a", name: "Mine", template: "{album}/{titel}" }] },
      }),
    SettingsError,
    'files.templates.0.template: "Mine": The template has unknown field "titel"',
  );
  await assertRejects(
    () => updateSettings(dir, s, { files: { active: "custom-gone" } }),
    SettingsError,
    "does not exist",
  );
  assertEquals(s.files, DEFAULT_SETTINGS.files, "nothing was changed");

  const mine = { id: "custom-a", name: "Mine", template: "{albumartist}/{album}/{tracknumber:02} {title}" };
  await updateSettings(dir, s, { files: { active: "custom-a", templates: [mine] } });
  assertEquals((await loadSettings(dir)).files, { active: "custom-a", templates: [mine] });
  // Choosing a built-in one keeps the saved ones.
  await updateSettings(dir, s, { files: { active: "picard" } });
  assertEquals((await loadSettings(dir)).files, { active: "picard", templates: [mine] });
});
