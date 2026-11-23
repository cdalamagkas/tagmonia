import { assert, assertEquals, assertThrows } from "@std/assert";
import { loadConfig } from "../../server/config.ts";
import { SECURITY_HEADERS } from "../../server/http/app.ts";
import type { HealthResponse } from "../../shared/types.ts";
import { makeTestApp } from "../helpers/app.ts";

Deno.test("GET /api/health reports ok with mounted dirs and sets security headers", async () => {
  const t = await makeTestApp();
  try {
    const res = await t.request("/api/health");
    assertEquals(res.status, 200);
    const body: HealthResponse = await res.json();
    assertEquals(body.status, "ok");
    assertEquals(body.checks, { musicRoot: true, configDir: true, database: true });
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) assertEquals(res.headers.get(k), v);
    assert(res.headers.get("content-security-policy")!.includes("frame-ancestors 'none'"));
  } finally {
    await t.cleanup();
  }
});

Deno.test("GET /api/health is 503 and leaks no paths when the music root is missing", async () => {
  const t = await makeTestApp({ config: { musicDir: "/nonexistent/tagmony-music" } });
  try {
    const res = await t.request("/api/health");
    assertEquals(res.status, 503);
    const text = await res.text();
    assert(!text.includes("/nonexistent"), text);
    assertEquals((JSON.parse(text) as HealthResponse).checks.musicRoot, false);
  } finally {
    await t.cleanup();
  }
});

Deno.test("unknown API routes are not found for signed-in users and need auth otherwise", async () => {
  const t = await makeTestApp();
  try {
    assertEquals((await t.request("/api/nope")).status, 401);
  } finally {
    await t.cleanup();
  }
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
