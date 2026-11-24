/** Providers page (§9.2, §14.3, D46): credentials (never returned), switches, health checks; and settings (§15.2). */
import { Hono } from "hono";
import { z } from "zod";
import type { ProviderDto, ProvidersResponse, SettingsUpdateResponse } from "../../../shared/types.ts";
import type { Db } from "../../db/db.ts";
import { enqueueProviderTest, providerTestDedupeKey } from "../../jobs/provider_test.ts";
import type { JobQueue } from "../../jobs/queue.ts";
import { CredentialError, type CredentialStore, providerDef, PROVIDERS } from "../../providers/credentials.ts";
import { type Settings, SettingsError, updateSettings } from "../../settings.ts";
import type { AuthEnv } from "../auth.ts";
import { toJobDto } from "./library.ts";

export interface ProviderRouteDeps {
  db: Db;
  queue: JobQueue;
  creds: CredentialStore;
  settings: Settings;
  configDir: string;
  now?: () => number;
}

const credentialsBody = z.object({
  values: z.record(z.string().max(64), z.string().max(2000).nullable()),
}).strict();

export function providerRoutes(deps: ProviderRouteDeps) {
  const { db, queue, creds, settings } = deps;
  const now = deps.now ?? Date.now;
  return new Hono<AuthEnv>()
    .get("/providers", async (c) => {
      const providers: ProviderDto[] = [];
      for (const p of PROVIDERS) {
        const h = db.prepare("SELECT ok, message, checked_at FROM provider_status WHERE provider = ?").get(p.id) as
          | { ok: number; message: string; checked_at: number }
          | undefined;
        const test = queue.live(providerTestDedupeKey(p.id));
        const toggle = p.toggle ? (settings.providers as Record<string, { enabled?: boolean }>)[p.id]?.enabled : null;
        providers.push({
          id: p.id,
          name: p.name,
          tier: p.tier,
          help: p.help,
          restartRequired: !!p.restartRequired,
          enabled: toggle ?? null,
          configured: await creds.configured(p.id),
          fields: await creds.status(p.id),
          health: h ? { ok: h.ok === 1, message: h.message, checkedAt: h.checked_at } : null,
          test: test ? toJobDto(test) : null,
        });
      }
      const body: ProvidersResponse = { providers };
      return c.json(body);
    })
    .put("/providers/:id/credentials", async (c) => {
      const def = providerDef(c.req.param("id"));
      if (!def) return c.json({ error: "not found" }, 404);
      const body = credentialsBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "invalid credentials" }, 400);
      try {
        await creds.set(def.id, body.data.values, now());
      } catch (e) {
        if (e instanceof CredentialError) return c.json({ error: e.message }, 400);
        throw e;
      }
      // The last health check described the old credentials.
      db.prepare("DELETE FROM provider_status WHERE provider = ?").run(def.id);
      return c.json({ restartRequired: !!def.restartRequired });
    })
    .post("/providers/:id/test", (c) => {
      const def = providerDef(c.req.param("id"));
      if (!def) return c.json({ error: "not found" }, 404);
      return c.json(toJobDto(enqueueProviderTest(queue, def.id)), 202);
    })
    .get("/settings", (c) => c.json(settings))
    .patch("/settings", async (c) => {
      const patch = await c.req.json().catch(() => null);
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        return c.json({ error: "invalid settings" }, 400);
      }
      try {
        const restartRequired = await updateSettings(deps.configDir, settings, patch);
        const body: SettingsUpdateResponse = { settings, restartRequired };
        return c.json(body);
      } catch (e) {
        if (e instanceof SettingsError) return c.json({ error: e.message }, 400);
        throw e;
      }
    });
}
