/**
 * Password hashing with Argon2id (ARCHITECTURE.md §14.1, D20) via hash-wasm:
 * pure WebAssembly, so it runs on amd64 and arm64 without native add-ons.
 */
import { argon2id, argon2Verify } from "hash-wasm";

export interface Argon2Params {
  /** KiB */
  memorySize: number;
  iterations: number;
  parallelism: number;
}

/** OWASP Password Storage Cheat Sheet minimum for Argon2id (19 MiB, t=2, p=1). */
export const DEFAULT_ARGON2: Argon2Params = { memorySize: 19 * 1024, iterations: 2, parallelism: 1 };

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 1024;

export async function hashPassword(password: string, params: Argon2Params = DEFAULT_ARGON2): Promise<string> {
  return await argon2id({
    password,
    salt: crypto.getRandomValues(new Uint8Array(16)),
    hashLength: 32,
    ...params,
    outputType: "encoded",
  });
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash: encoded });
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;

/** Burns the same time as a real check, so unknown usernames are not revealed by timing. */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummy ??= hashPassword("tagmonia-dummy-password");
  await verifyPassword(password, await dummy);
  return false;
}
