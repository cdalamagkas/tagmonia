import { Hono } from "hono";
import type { HealthResponse } from "../../../shared/types.ts";
import type { Config } from "../../config.ts";
import { VERSION } from "../../version.ts";

async function isReadableDir(path: string): Promise<boolean> {
  try {
    if (!(await Deno.stat(path)).isDirectory) return false;
    for await (const _ of Deno.readDir(path)) break;
    return true;
  } catch {
    return false;
  }
}

async function isWritableDir(path: string): Promise<boolean> {
  try {
    const probe = await Deno.makeTempFile({ dir: path, prefix: ".tagmony-health-" });
    await Deno.remove(probe);
    return true;
  } catch {
    return false;
  }
}

/** Unauthenticated by design (CLAUDE.md safety rule 8): reports booleans only, never paths or config. */
export function healthRoutes(config: Config): Hono {
  return new Hono().get("/", async (c) => {
    const checks = {
      musicRoot: await isReadableDir(config.musicDir),
      configDir: await isWritableDir(config.configDir),
    };
    const ok = checks.musicRoot && checks.configDir;
    const body: HealthResponse = { status: ok ? "ok" : "degraded", version: VERSION, checks };
    return c.json(body, ok ? 200 : 503);
  });
}
