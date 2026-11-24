/**
 * Process configuration from environment variables (ARCHITECTURE.md §15.2),
 * validated at startup. UI-managed settings (/config/settings.json) arrive in Phase 1.
 */
import { z } from "zod";

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const envSchema = z.object({
  TAGMONIA_MUSIC_DIR: z.string().min(1).default("/music"),
  TAGMONIA_CONFIG_DIR: z.string().min(1).default("/config"),
  TAGMONIA_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  TAGMONIA_PUBLIC_URL: z.url({ protocol: /^https?$/ }).optional(),
  TAGMONIA_ADMIN_PASSWORD_FILE: z.string().min(1).optional(),
  TAGMONIA_SECRET_KEY: z.string().min(32).optional(),
  /** AcoustID application key (D37); the _FILE form reads it from a Docker secret. */
  TAGMONIA_ACOUSTID_KEY: z.string().min(1).optional(),
  TAGMONIA_ACOUSTID_KEY_FILE: z.string().min(1).optional(),
  TAGMONIA_READ_ONLY: bool.default(false),
  TAGMONIA_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** Directory of the built SPA; unset in dev, where Vite serves it. */
  TAGMONIA_WEB_DIR: z.string().min(1).optional(),
});

export interface Config {
  musicDir: string;
  configDir: string;
  port: number;
  publicUrl?: string;
  adminPasswordFile?: string;
  /** Never log or return this value (CLAUDE.md safety rule 7). */
  secretKey?: string;
  /** Never log or return these (CLAUDE.md safety rule 7). Resolve with `resolveAcoustidKey`. */
  acoustidKey?: string;
  acoustidKeyFile?: string;
  readOnly: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
  webDir?: string;
}

export function loadConfig(env: Record<string, string | undefined> = Deno.env.toObject()): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Report which variables are wrong without echoing their values (they may be secrets).
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid configuration in: ${fields}`);
  }
  const e = parsed.data;
  if (e.TAGMONIA_ACOUSTID_KEY && e.TAGMONIA_ACOUSTID_KEY_FILE) {
    throw new Error("Set only one of TAGMONIA_ACOUSTID_KEY and TAGMONIA_ACOUSTID_KEY_FILE");
  }
  return {
    musicDir: e.TAGMONIA_MUSIC_DIR,
    configDir: e.TAGMONIA_CONFIG_DIR,
    port: e.TAGMONIA_PORT,
    publicUrl: e.TAGMONIA_PUBLIC_URL,
    adminPasswordFile: e.TAGMONIA_ADMIN_PASSWORD_FILE,
    secretKey: e.TAGMONIA_SECRET_KEY,
    acoustidKey: e.TAGMONIA_ACOUSTID_KEY,
    acoustidKeyFile: e.TAGMONIA_ACOUSTID_KEY_FILE,
    readOnly: e.TAGMONIA_READ_ONLY,
    logLevel: e.TAGMONIA_LOG_LEVEL,
    webDir: e.TAGMONIA_WEB_DIR,
  };
}

/**
 * The AcoustID key, or undefined when fingerprinting is off. Read at startup,
 * so a changed key needs a restart (D37).
 */
export async function resolveAcoustidKey(config: Config): Promise<string | undefined> {
  if (config.acoustidKey) return config.acoustidKey.trim() || undefined;
  if (!config.acoustidKeyFile) return undefined;
  let text: string;
  try {
    text = await Deno.readTextFile(config.acoustidKeyFile);
  } catch {
    // The path is not secret; its contents are.
    throw new Error(`TAGMONIA_ACOUSTID_KEY_FILE: cannot read ${config.acoustidKeyFile}`);
  }
  const key = text.trim();
  if (!key) throw new Error("TAGMONIA_ACOUSTID_KEY_FILE is empty");
  return key;
}
