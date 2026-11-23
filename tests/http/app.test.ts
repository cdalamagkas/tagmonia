import { assert, assertEquals, assertThrows } from "@std/assert";
import { loadConfig } from "../../server/config.ts";
import { createApp, SECURITY_HEADERS } from "../../server/http/app.ts";
import type { HealthResponse } from "../../shared/types.ts";

async function tempConfig() {
  const musicDir = await Deno.makeTempDir({ prefix: "tagmony-music-" });
  const configDir = await Deno.makeTempDir({ prefix: "tagmony-config-" });
  return loadConfig({ TAGMONY_MUSIC_DIR: musicDir, TAGMONY_CONFIG_DIR: configDir });
}

Deno.test("GET /api/health reports ok with mounted dirs and sets security headers", async () => {
  const app = createApp(await tempConfig());
  const res = await app.request("/api/health");
  assertEquals(res.status, 200);
  const body: HealthResponse = await res.json();
  assertEquals(body.status, "ok");
  assertEquals(body.checks, { musicRoot: true, configDir: true });
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) assertEquals(res.headers.get(k), v);
  assert(res.headers.get("content-security-policy")!.includes("frame-ancestors 'none'"));
});

Deno.test("GET /api/health is 503 and leaks no paths when the music root is missing", async () => {
  const cfg = await tempConfig();
  const app = createApp({ ...cfg, musicDir: "/nonexistent/tagmony-music" });
  const res = await app.request("/api/health");
  assertEquals(res.status, 503);
  const text = await res.text();
  assert(!text.includes("/nonexistent"), text);
  assertEquals((JSON.parse(text) as HealthResponse).checks.musicRoot, false);
});

Deno.test("unknown API routes return JSON 404", async () => {
  const res = await createApp(await tempConfig()).request("/api/nope");
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "not found" });
});

Deno.test("config defaults follow ARCHITECTURE.md §15.2", () => {
  const c = loadConfig({});
  assertEquals([c.musicDir, c.configDir, c.port, c.readOnly, c.logLevel], ["/music", "/config", 8080, false, "info"]);
});

Deno.test("invalid config names the variable but never echoes its value", () => {
  const secret = "short-secret-value";
  const err = assertThrows(() => loadConfig({ TAGMONY_SECRET_KEY: secret, TAGMONY_PORT: "99999" }));
  const msg = (err as Error).message;
  assert(msg.includes("TAGMONY_SECRET_KEY") && msg.includes("TAGMONY_PORT"), msg);
  assert(!msg.includes(secret), msg);
});
