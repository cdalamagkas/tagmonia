import { Hono } from "hono";
import type { HealthResponse } from "../../../shared/types.ts";
import type { Config } from "../../config.ts";
import type { Db } from "../../db/db.ts";
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
    const probe = await Deno.makeTempFile({ dir: path, prefix: ".tagmonia-health-" });
    await Deno.remove(probe);
    return true;
  } catch {
    return false;
  }
}

function dbAnswers(db: Db): boolean {
  try {
    return (db.prepare("SELECT 1 AS one").get() as { one: number }).one === 1;
  } catch {
    return false;
  }
}

/** Unauthenticated by design (CLAUDE.md safety rule 8): reports booleans only, never paths or config. */
export function healthRoutes(config: Config, db: Db): Hono {
  return new Hono().get("/", async (c) => {
    const checks = {
      musicRoot: await isReadableDir(config.musicDir),
      configDir: await isWritableDir(config.configDir),
      database: dbAnswers(db),
    };
    const ok = checks.musicRoot && checks.configDir && checks.database;
    const body: HealthResponse = { status: ok ? "ok" : "degraded", version: VERSION, checks };
    return c.json(body, ok ? 200 : 503);
  });
}
