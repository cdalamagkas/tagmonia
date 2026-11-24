/**
 * Credentials encrypted at rest (ARCHITECTURE.md §14.3, CLAUDE.md safety rule 7).
 * AES-256-GCM with a key derived (HKDF-SHA-256) from TAGMONIA_SECRET_KEY, or
 * from a random key file created on first start with mode 0600. Each value is
 * bound to its slot (provider and field) as additional data, so a stored
 * ciphertext cannot be moved to another field.
 */
import { join } from "node:path";

const VERSION = "v1";
const SALT = new TextEncoder().encode("tagmonia/credentials/v1");
const INFO = new TextEncoder().encode("aes-256-gcm");
export const KEY_FILE = "secret.key";

export class VaultError extends Error {
  override name = "VaultError";
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** The key file's bytes; created (0600) when missing, tightened to 0600 when readable by others. */
async function keyFileMaterial(configDir: string): Promise<Uint8Array<ArrayBuffer>> {
  const path = join(configDir, KEY_FILE);
  try {
    const st = await Deno.stat(path);
    if (st.mode !== null && (st.mode & 0o077) !== 0) await Deno.chmod(path, 0o600);
    const bytes = unb64((await Deno.readTextFile(path)).trim());
    if (bytes.length < 32) throw new VaultError(`${path} is too short to be a key`);
    return bytes;
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  // createNew: never overwrite a key another process just wrote, or its credentials become unreadable.
  await Deno.writeTextFile(path, b64(bytes) + "\n", { mode: 0o600, createNew: true });
  return bytes;
}

export class Vault {
  private constructor(private readonly key: CryptoKey) {}

  /** `secretKey` wins (TAGMONIA_SECRET_KEY); otherwise the key file in `configDir`. */
  static async open(opts: { secretKey?: string; configDir: string }): Promise<Vault> {
    const material = opts.secretKey ? new TextEncoder().encode(opts.secretKey) : await keyFileMaterial(opts.configDir);
    const ikm = await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: SALT, info: INFO },
      ikm,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    return new Vault(key);
  }

  async encrypt(plaintext: string, slot: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(slot) },
      this.key,
      new TextEncoder().encode(plaintext),
    );
    return `${VERSION}.${b64(iv)}.${b64(new Uint8Array(ct))}`;
  }

  /** Throws VaultError when the value was written under another key (e.g. TAGMONIA_SECRET_KEY changed). */
  async decrypt(blob: string, slot: string): Promise<string> {
    const [version, iv, ct] = blob.split(".");
    if (version !== VERSION || !iv || !ct) throw new VaultError("unknown credential format");
    try {
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: unb64(iv), additionalData: new TextEncoder().encode(slot) },
        this.key,
        unb64(ct),
      );
      return new TextDecoder().decode(pt);
    } catch {
      throw new VaultError("cannot decrypt a stored credential: was TAGMONIA_SECRET_KEY or secret.key changed?");
    }
  }
}
