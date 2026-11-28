/**
 * Process configuration from environment variables (ARCHITECTURE.md §15.2),
 * validated at startup. UI-managed settings (/config/settings.json) arrive in Phase 1.
 */
import { parseProxies, type TrustedHeaderSettings } from "./auth/trusted_header.ts";
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
  // Single sign-on with OpenID Connect (D69): all of issuer, client ID, secret and group, or none.
  TAGMONIA_OIDC_ISSUER: z.url({ protocol: /^https$/ }).optional(),
  TAGMONIA_OIDC_CLIENT_ID: z.string().min(1).max(500).optional(),
  TAGMONIA_OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  TAGMONIA_OIDC_CLIENT_SECRET_FILE: z.string().min(1).optional(),
  /** Only members of this group get in (D69). */
  TAGMONIA_OIDC_GROUP: z.string().min(1).max(200).optional(),
  TAGMONIA_OIDC_GROUPS_CLAIM: z.string().min(1).max(100).default("groups"),
  TAGMONIA_OIDC_SCOPES: z.string().min(1).max(500).default("openid profile email groups"),
  /** The sign-in button's label: "Sign in with <name>". */
  TAGMONIA_OIDC_NAME: z.string().min(1).max(60).optional(),
  // Sign-in by a trusted reverse proxy (D70): the user header, the proxies' addresses, the group, or none.
  TAGMONIA_TRUSTED_HEADER: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
  TAGMONIA_TRUSTED_GROUPS_HEADER: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).default("Remote-Groups"),
  TAGMONIA_TRUSTED_PROXIES: z.string().min(1).max(2000).optional(),
  TAGMONIA_TRUSTED_GROUP: z.string().min(1).max(200).optional(),
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
  /** Single sign-on (D69); the secret is never logged or returned: resolve it with `resolveOidcSecret`. */
  oidc?: {
    issuer: string;
    clientId: string;
    clientSecret?: string;
    clientSecretFile?: string;
    group: string;
    groupsClaim: string;
    scopes: string;
    name: string;
  };
  /** Sign-in by a trusted reverse proxy (D70). */
  trustedHeader?: TrustedHeaderSettings;
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
  const oidcSet = [
    e.TAGMONIA_OIDC_ISSUER,
    e.TAGMONIA_OIDC_CLIENT_ID,
    e.TAGMONIA_OIDC_CLIENT_SECRET ?? e.TAGMONIA_OIDC_CLIENT_SECRET_FILE,
    e.TAGMONIA_OIDC_GROUP,
  ];
  if (oidcSet.some(Boolean) && !oidcSet.every(Boolean)) {
    throw new Error(
      "Single sign-on needs all of TAGMONIA_OIDC_ISSUER, TAGMONIA_OIDC_CLIENT_ID, TAGMONIA_OIDC_CLIENT_SECRET (or _FILE) and TAGMONIA_OIDC_GROUP",
    );
  }
  if (e.TAGMONIA_OIDC_CLIENT_SECRET && e.TAGMONIA_OIDC_CLIENT_SECRET_FILE) {
    throw new Error("Set only one of TAGMONIA_OIDC_CLIENT_SECRET and TAGMONIA_OIDC_CLIENT_SECRET_FILE");
  }
  const trustedSet = [e.TAGMONIA_TRUSTED_HEADER, e.TAGMONIA_TRUSTED_PROXIES, e.TAGMONIA_TRUSTED_GROUP];
  if (trustedSet.some(Boolean) && !trustedSet.every(Boolean)) {
    throw new Error(
      "Sign-in by a proxy needs all of TAGMONIA_TRUSTED_HEADER, TAGMONIA_TRUSTED_PROXIES and TAGMONIA_TRUSTED_GROUP",
    );
  }
  let trustedHeader: TrustedHeaderSettings | undefined;
  if (e.TAGMONIA_TRUSTED_HEADER) {
    let proxies;
    try {
      proxies = parseProxies(e.TAGMONIA_TRUSTED_PROXIES!);
    } catch (err) {
      throw new Error(`TAGMONIA_TRUSTED_PROXIES: ${(err as Error).message}`);
    }
    if (proxies.length === 0) throw new Error("TAGMONIA_TRUSTED_PROXIES is empty");
    trustedHeader = {
      userHeader: e.TAGMONIA_TRUSTED_HEADER,
      groupsHeader: e.TAGMONIA_TRUSTED_GROUPS_HEADER,
      group: e.TAGMONIA_TRUSTED_GROUP!,
      proxies,
    };
  }
  if (e.TAGMONIA_OIDC_ISSUER && !e.TAGMONIA_PUBLIC_URL) {
    throw new Error("Single sign-on needs TAGMONIA_PUBLIC_URL: the identity provider sends the browser back to it");
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
    oidc: e.TAGMONIA_OIDC_ISSUER
      ? {
        issuer: e.TAGMONIA_OIDC_ISSUER,
        clientId: e.TAGMONIA_OIDC_CLIENT_ID!,
        clientSecret: e.TAGMONIA_OIDC_CLIENT_SECRET,
        clientSecretFile: e.TAGMONIA_OIDC_CLIENT_SECRET_FILE,
        group: e.TAGMONIA_OIDC_GROUP!,
        groupsClaim: e.TAGMONIA_OIDC_GROUPS_CLAIM,
        scopes: e.TAGMONIA_OIDC_SCOPES,
        name: e.TAGMONIA_OIDC_NAME ?? new URL(e.TAGMONIA_OIDC_ISSUER).hostname,
      }
      : undefined,
    trustedHeader,
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

/** The OIDC client secret (D69); read at startup. */
export function resolveOidcSecret(config: Config): Promise<string | undefined> {
  return resolveSecret(config.oidc?.clientSecret, config.oidc?.clientSecretFile, "TAGMONIA_OIDC_CLIENT_SECRET");
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
