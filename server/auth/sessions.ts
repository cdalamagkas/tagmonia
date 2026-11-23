/**
 * Server-side sessions (ARCHITECTURE.md §14.1): a random 256-bit id in an
 * HttpOnly cookie; the database stores only its SHA-256, so a leaked database
 * does not yield live sessions. Each session carries its own CSRF token.
 */
import type { Db } from "../db/db.ts";
import {
  deleteExpiredSessions,
  deleteSession,
  findSession,
  insertSession,
  type SessionRow,
  touchSession,
} from "../db/repo/users.ts";

export interface SessionPolicy {
  idleMs: number;
  maxMs: number;
}

export interface ActiveSession extends SessionRow {
  idHash: string;
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function hashSessionId(id: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  return b64url(new Uint8Array(d));
}

/** Constant-time string comparison for tokens. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export class SessionStore {
  constructor(private db: Db, private policy: SessionPolicy, private now: () => number = Date.now) {}

  /** Returns the cookie value; only its hash is stored. */
  async create(userId: number): Promise<{ id: string; csrfToken: string; expiresAt: number }> {
    const id = randomToken(32);
    const csrfToken = randomToken(32);
    const now = this.now();
    const expiresAt = now + this.policy.maxMs;
    insertSession(this.db, { idHash: await hashSessionId(id), userId, csrfToken, now, expiresAt });
    return { id, csrfToken, expiresAt };
  }

  async get(id: string | undefined): Promise<ActiveSession | undefined> {
    if (!id || id.length > 128) return undefined;
    const idHash = await hashSessionId(id);
    const s = findSession(this.db, idHash);
    if (!s) return undefined;
    const now = this.now();
    if (now >= s.expiresAt || now - s.lastSeenAt >= this.policy.idleMs) {
      deleteSession(this.db, idHash);
      return undefined;
    }
    // Avoid a write per request; idle resolution of a minute is plenty.
    if (now - s.lastSeenAt > 60_000) touchSession(this.db, idHash, now);
    return { ...s, idHash };
  }

  destroy(idHash: string): void {
    deleteSession(this.db, idHash);
  }

  purgeExpired(): number {
    return deleteExpiredSessions(this.db, this.now(), this.policy.idleMs);
  }
}
