/** Providers page API: credentials never leak, settings switches persist (§14.3, D46). */
import { assert, assertEquals } from "@std/assert";
import type { ProvidersResponse, SettingsUpdateResponse } from "../../shared/types.ts";
import { makeTestApp, signIn, type TestApp } from "../helpers/app.ts";

async function withApp(fn: (t: TestApp, s: { cookie: string; csrf: string }) => Promise<void>) {
  const t = await makeTestApp({ envCredentials: { jellyfin: { url: "http://jf.env:8096" } } });
  try {
    await fn(t, await signIn(t));
  } finally {
    await t.cleanup();
  }
}

Deno.test("saved secrets never appear in the providers listing", () =>
  withApp(async (t, { cookie, csrf }) => {
    const put = await t.request("/api/providers/discogs/credentials", {
      method: "PUT",
      cookie,
      csrf,
      body: JSON.stringify({ values: { consumerKey: "DISCOGS-KEY-1", consumerSecret: "DISCOGS-SECRET-2" } }),
    });
    assertEquals([put.status, await put.json()], [200, { restartRequired: true }]);
    const res = await t.request("/api/providers", { cookie });
    const text = await res.text();
    assert(!text.includes("DISCOGS-KEY-1") && !text.includes("DISCOGS-SECRET-2"), "secret leaked");
    const body: ProvidersResponse = JSON.parse(text);
    const discogs = body.providers.find((p) => p.id === "discogs")!;
    assertEquals([discogs.configured, discogs.enabled, discogs.restartRequired], [true, true, true]);
    assertEquals(discogs.fields.map((f) => [f.set, f.source, f.value]), [[true, "app", null], [true, "app", null]]);
    // An environment value is shown as managed there.
    const jf = body.providers.find((p) => p.id === "jellyfin")!;
    assertEquals(jf.fields[0], { ...jf.fields[0], source: "environment", value: "http://jf.env:8096" });
    assertEquals(jf.configured, false, "no API key yet");
  }));

Deno.test("credential errors are 400, unknown providers 404, and both need CSRF", () =>
  withApp(async (t, { cookie, csrf }) => {
    const put = (id: string, values: unknown, withCsrf = true) =>
      t.request(`/api/providers/${id}/credentials`, {
        method: "PUT",
        cookie,
        csrf: withCsrf ? csrf : undefined,
        body: JSON.stringify({ values }),
      });
    assertEquals((await put("discogs", { consumerKey: "x" }, false)).status, 403);
    assertEquals((await put("jellyfin", { url: "https://elsewhere" })).status, 400, "set by the environment");
    assertEquals((await put("discogs", { token: "x" })).status, 400);
    assertEquals((await put("nope", { a: "b" })).status, 404);
  }));

Deno.test("a health check is queued as a job; settings switches persist", () =>
  withApp(async (t, { cookie, csrf }) => {
    const res = await t.request("/api/providers/deezer/test", { method: "POST", cookie, csrf });
    assertEquals(res.status, 202);
    assertEquals(t.queue.get((await res.json()).id)!.payload, { provider: "deezer" });
    const patch = await t.request("/api/settings", {
      method: "PATCH",
      cookie,
      csrf,
      body: JSON.stringify({ providers: { deezer: { enabled: false } } }),
    });
    const body: SettingsUpdateResponse = await patch.json();
    assertEquals([patch.status, body.settings.providers.deezer.enabled, body.restartRequired], [200, false, []]);
    const listed: ProvidersResponse = await (await t.request("/api/providers", { cookie })).json();
    assertEquals(listed.providers.find((p) => p.id === "deezer")!.enabled, false);
    const bad = await t.request("/api/settings", { method: "PATCH", cookie, csrf, body: JSON.stringify({ x: 1 }) });
    assertEquals(bad.status, 400);
  }));
