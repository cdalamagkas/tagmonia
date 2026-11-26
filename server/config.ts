/**
 * Process configuration from environment variables (ARCHITECTURE.md §15.2),
 * validated at startup. UI-managed settings (/config/settings.json) arrive in Phase 1.
 */
import { z } from "zod";

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const envSchema = z.object({
  TAGMONIA_MUSIC_DIR: z.string().min(1).default("/music"),
  /** New albums land here and move into the library when written (D57); no inbox when unset. */
  TAGMONIA_INBOX_DIR: z.string().min(1).optional(),
  TAGMONIA_CONFIG_DIR: z.string().min(1).default("/config"),
  TAGMONIA_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  TAGMONIA_PUBLIC_URL: z.url({ protocol: /^https?$/ }).optional(),
  TAGMONIA_ADMIN_PASSWORD_FILE: z.string().min(1).optional(),
  TAGMONIA_SECRET_KEY: z.string().min(32).optional(),
  /** AcoustID application key (D37); the _FILE form reads it from a Docker secret. */
  TAGMONIA_ACOUSTID_KEY: z.string().min(1).optional(),
  TAGMONIA_ACOUSTID_KEY_FILE: z.string().min(1).optional(),
  /** Jellyfin rescan after writes (§13, D44). */
  TAGMONIA_JELLYFIN_URL: z.url({ protocol: /^https?$/ }).optional(),
  TAGMONIA_JELLYFIN_KEY: z.string().min(1).optional(),
  TAGMONIA_JELLYFIN_KEY_FILE: z.string().min(1).optional(),
  /** Refresh only this library; all libraries when unset. */
  TAGMONIA_JELLYFIN_LIBRARY: z.string().min(1).max(200).optional(),
  TAGMONIA_READ_ONLY: bool.default(false),
  TAGMONIA_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** Directory of the built SPA; unset in dev, where Vite serves it. */
  TAGMONIA_WEB_DIR: z.string().min(1).optional(),
});

export interface Config {
  musicDir: string;
  /** The inbox folder (D57), or undefined. Never inside the library, nor the library inside it. */
  inboxDir?: string;
  configDir: string;
  port: number;
  publicUrl?: string;
  adminPasswordFile?: string;
  /** Never log or return this value (CLAUDE.md safety rule 7). */
  secretKey?: string;
  /** Never log or return these (CLAUDE.md safety rule 7). Resolve with `resolveAcoustidKey`. */
  acoustidKey?: string;
  acoustidKeyFile?: string;
  jellyfinUrl?: string;
  /** Never log or return (CLAUDE.md safety rule 7). Resolve with `resolveJellyfinKey`. */
  jellyfinKey?: string;
  jellyfinKeyFile?: string;
  jellyfinLibrary?: string;
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
  for (const name of ["ACOUSTID", "JELLYFIN"] as const) {
    if (e[`TAGMONIA_${name}_KEY`] && e[`TAGMONIA_${name}_KEY_FILE`]) {
      throw new Error(`Set only one of TAGMONIA_${name}_KEY and TAGMONIA_${name}_KEY_FILE`);
    }
  }
  if ((e.TAGMONIA_JELLYFIN_KEY || e.TAGMONIA_JELLYFIN_KEY_FILE) && !e.TAGMONIA_JELLYFIN_URL) {
    throw new Error("TAGMONIA_JELLYFIN_URL is required with a Jellyfin key");
  }
  return {
    musicDir: e.TAGMONIA_MUSIC_DIR,
    inboxDir: e.TAGMONIA_INBOX_DIR,
    configDir: e.TAGMONIA_CONFIG_DIR,
    port: e.TAGMONIA_PORT,
    publicUrl: e.TAGMONIA_PUBLIC_URL,
    adminPasswordFile: e.TAGMONIA_ADMIN_PASSWORD_FILE,
    secretKey: e.TAGMONIA_SECRET_KEY,
    acoustidKey: e.TAGMONIA_ACOUSTID_KEY,
    acoustidKeyFile: e.TAGMONIA_ACOUSTID_KEY_FILE,
    jellyfinUrl: e.TAGMONIA_JELLYFIN_URL,
    jellyfinKey: e.TAGMONIA_JELLYFIN_KEY,
    jellyfinKeyFile: e.TAGMONIA_JELLYFIN_KEY_FILE,
    jellyfinLibrary: e.TAGMONIA_JELLYFIN_LIBRARY,
    readOnly: e.TAGMONIA_READ_ONLY,
    logLevel: e.TAGMONIA_LOG_LEVEL,
    webDir: e.TAGMONIA_WEB_DIR,
  };
}

/**
 * The AcoustID key, or undefined when fingerprinting is off. Read at startup,
 * so a changed key needs a restart (D37).
 */
/** A secret from its variable or from a file (a Docker secret). The path is not secret; the contents are. */
async function resolveSecret(value: string | undefined, file: string | undefined, name: string) {
  if (value) return value.trim() || undefined;
  if (!file) return undefined;
  let text: string;
  try {
    text = await Deno.readTextFile(file);
  } catch {
    throw new Error(`${name}_FILE: cannot read ${file}`);
  }
  const key = text.trim();
  if (!key) throw new Error(`${name}_FILE is empty`);
  return key;
}

export function resolveAcoustidKey(config: Config): Promise<string | undefined> {
  return resolveSecret(config.acoustidKey, config.acoustidKeyFile, "TAGMONIA_ACOUSTID_KEY");
}

/** The Jellyfin API key (§13, D44); read at startup like the AcoustID key. */
export function resolveJellyfinKey(config: Config): Promise<string | undefined> {
  return resolveSecret(config.jellyfinKey, config.jellyfinKeyFile, "TAGMONIA_JELLYFIN_KEY");
}

/**
 * The inbox must be a separate tree: inside the library its albums would be scanned twice, and with the
 * library inside it, moving an album "into the library" would move it within the inbox. Checked on the
 * real paths, at startup.
 */
export async function checkInbox(config: Config): Promise<void> {
  if (!config.inboxDir) return;
  const [lib, inbox] = await Promise.all([Deno.realPath(config.musicDir), Deno.realPath(config.inboxDir)]);
  const within = (a: string, b: string) => a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`);
  if (within(inbox, lib) || within(lib, inbox)) {
    throw new Error("TAGMONIA_INBOX_DIR must not be the music folder, inside it, or contain it");
  }
}
