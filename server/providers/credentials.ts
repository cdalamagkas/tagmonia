/**
 * Provider credentials (§14.3, D46): what each provider needs, where it comes
 * from, and the encrypted store behind the providers page. An environment
 * variable wins over a value saved in the app, so a deployment stays in charge.
 * Secret values are never returned: the API reports only "set" and the source.
 */
import { z } from "zod";
import type { Db } from "../db/db.ts";
import { type Vault, VaultError } from "../secrets/vault.ts";

export type ProviderId = "musicbrainz" | "acoustid" | "deezer" | "itunes" | "discogs" | "jellyfin";

export interface CredentialField {
  key: string;
  label: string;
  /** Never returned once saved; the UI shows "set". */
  secret: boolean;
  kind: "text" | "url";
  /** The environment variable that overrides it, if any. */
  env?: string;
  optional?: boolean;
}

export interface ProviderDef {
  id: ProviderId;
  name: string;
  /** §9.2 tiers; Jellyfin is the music server (§13). */
  tier: "core" | "enrichment" | "music_server";
  fields: CredentialField[];
  /** Harmony reads its credentials once when its modules load (D12). */
  restartRequired?: boolean;
  /** Has an on/off switch in settings (providers.<id>.enabled). */
  toggle?: boolean;
  help: string;
}

export const PROVIDERS: readonly ProviderDef[] = [
  {
    id: "musicbrainz",
    name: "MusicBrainz",
    tier: "core",
    fields: [],
    help: "Identification and tags. No account needed; requests are limited to 1 per second.",
  },
  {
    id: "acoustid",
    name: "AcoustID",
    tier: "core",
    fields: [{ key: "apiKey", label: "Application API key", secret: true, kind: "text", env: "TAGMONIA_ACOUSTID_KEY" }],
    help: "Fingerprint identification. A free application key from acoustid.org/new-application.",
  },
  {
    id: "deezer",
    name: "Deezer",
    tier: "enrichment",
    fields: [],
    toggle: true,
    help: "Release dates, ISRCs and covers. No account needed.",
  },
  {
    id: "itunes",
    name: "iTunes",
    tier: "enrichment",
    fields: [],
    toggle: true,
    help: "Release dates and large covers. No account needed.",
  },
  {
    id: "discogs",
    name: "Discogs",
    tier: "enrichment",
    fields: [
      { key: "consumerKey", label: "Consumer key", secret: true, kind: "text" },
      { key: "consumerSecret", label: "Consumer secret", secret: true, kind: "text" },
    ],
    toggle: true,
    restartRequired: true,
    help: "Labels, catalog numbers and pressings. Create an application at discogs.com → Settings → Developers.",
  },
  {
    id: "jellyfin",
    name: "Jellyfin",
    tier: "music_server",
    fields: [
      { key: "url", label: "Server URL", secret: false, kind: "url", env: "TAGMONIA_JELLYFIN_URL" },
      { key: "apiKey", label: "API key", secret: true, kind: "text", env: "TAGMONIA_JELLYFIN_KEY" },
      {
        key: "library",
        label: "Library (optional)",
        secret: false,
        kind: "text",
        env: "TAGMONIA_JELLYFIN_LIBRARY",
        optional: true,
      },
    ],
    help: "Re-reads the albums Tagmonia wrote. An API key from Jellyfin → Dashboard → API Keys.",
  },
];

export function providerDef(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Values the deployment set through the environment (or _FILE secrets), resolved at startup. */
export type EnvCredentials = Partial<Record<ProviderId, Record<string, string | undefined>>>;

export interface FieldStatus {
  key: string;
  label: string;
  secret: boolean;
  kind: "text" | "url";
  optional: boolean;
  set: boolean;
  source: "environment" | "app" | null;
  /** Only for non-secret fields. */
  value: string | null;
  /** A saved value that cannot be decrypted (the secret key changed). */
  error: string | null;
}

export class CredentialError extends Error {
  override name = "CredentialError";
}

const slot = (provider: string, name: string) => `${provider}:${name}`;

export class CredentialStore {
  constructor(private readonly db: Db, private readonly vault: Vault, private readonly env: EnvCredentials = {}) {}

  #stored(provider: string, name: string): string | null {
    const r = this.db.prepare("SELECT value FROM credential WHERE provider = ? AND name = ?").get(provider, name) as
      | { value: string }
      | undefined;
    return r?.value ?? null;
  }

  /** Current values: environment first, then the app's store. Fields that cannot be decrypted are left out. */
  async get(provider: ProviderId): Promise<Record<string, string>> {
    const def = providerDef(provider);
    const out: Record<string, string> = {};
    for (const f of def?.fields ?? []) {
      const fromEnv = this.env[provider]?.[f.key];
      if (fromEnv) {
        out[f.key] = fromEnv;
        continue;
      }
      const blob = this.#stored(provider, f.key);
      if (!blob) continue;
      try {
        out[f.key] = await this.vault.decrypt(blob, slot(provider, f.key));
      } catch (e) {
        if (!(e instanceof VaultError)) throw e;
      }
    }
    return out;
  }

  async status(provider: ProviderId): Promise<FieldStatus[]> {
    const def = providerDef(provider)!;
    const out: FieldStatus[] = [];
    for (const f of def.fields) {
      const base = { key: f.key, label: f.label, secret: f.secret, kind: f.kind, optional: !!f.optional };
      const fromEnv = this.env[provider]?.[f.key];
      if (fromEnv) {
        out.push({ ...base, set: true, source: "environment", value: f.secret ? null : fromEnv, error: null });
        continue;
      }
      const blob = this.#stored(provider, f.key);
      if (!blob) {
        out.push({ ...base, set: false, source: null, value: null, error: null });
        continue;
      }
      try {
        const v = await this.vault.decrypt(blob, slot(provider, f.key));
        out.push({ ...base, set: true, source: "app", value: f.secret ? null : v, error: null });
      } catch (e) {
        if (!(e instanceof VaultError)) throw e;
        out.push({ ...base, set: true, source: "app", value: null, error: e.message });
      }
    }
    return out;
  }

  /** Saves (string) or removes (null) fields. A field set by the environment cannot be changed here. */
  async set(provider: ProviderId, values: Record<string, string | null>, now: number): Promise<void> {
    const def = providerDef(provider);
    if (!def) throw new CredentialError(`unknown provider ${provider}`);
    for (const [key, value] of Object.entries(values)) {
      const f = def.fields.find((x) => x.key === key);
      if (!f) throw new CredentialError(`${def.name} has no field "${key}"`);
      if (this.env[provider]?.[key]) throw new CredentialError(`${f.label} is set by ${f.env}; change it there`);
      if (value === null || value.trim() === "") {
        this.db.prepare("DELETE FROM credential WHERE provider = ? AND name = ?").run(provider, key);
        continue;
      }
      const v = value.trim();
      if (v.length > 2000) throw new CredentialError(`${f.label} is too long`);
      if (f.kind === "url" && !z.url({ protocol: /^https?$/ }).safeParse(v).success) {
        throw new CredentialError(`${f.label} must be an http(s) URL`);
      }
      if (f.kind === "url" && /\/\/[^/]*@/.test(v)) {
        throw new CredentialError(`${f.label} must not contain credentials`);
      }
      this.db.prepare(
        `INSERT INTO credential (provider, name, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(provider, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(provider, key, await this.vault.encrypt(v, slot(provider, key)), now);
    }
  }

  /** Every field that is not optional has a value (from either source). */
  async configured(provider: ProviderId): Promise<boolean> {
    const def = providerDef(provider);
    if (!def) return false;
    const values = await this.get(provider);
    return def.fields.every((f) => f.optional || !!values[f.key]);
  }
}
