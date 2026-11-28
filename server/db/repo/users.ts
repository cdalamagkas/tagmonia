/** Data access for app_user and session (ARCHITECTURE.md §14.1). */
import type { Db } from "../db.ts";

export interface User {
  id: number;
  username: string;
  isAdmin: boolean;
}

export interface UserWithHash extends User {
  passwordHash: string;
}

export function countUsers(db: Db): number {
  return (db.prepare("SELECT count(*) n FROM app_user").get() as { n: number }).n;
}

export function findUserByName(db: Db, username: string): UserWithHash | undefined {
  const r = db.prepare("SELECT id, username, is_admin, password_hash FROM app_user WHERE username = ?").get(
    username,
  ) as { id: number; username: string; is_admin: number; password_hash: string } | undefined;
  return r && { id: r.id, username: r.username, isAdmin: r.is_admin === 1, passwordHash: r.password_hash };
}

/**
 * Creates the first admin only while no user exists, atomically, so two
 * concurrent setup requests cannot both succeed. Returns undefined if a user exists.
 */
export function createFirstAdmin(db: Db, username: string, passwordHash: string, now: number): User | undefined {
  const r = db.prepare(
    `INSERT INTO app_user (username, password_hash, is_admin, created_at)
     SELECT ?, ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM app_user) RETURNING id, username`,
  ).get(username, passwordHash, now) as { id: number; username: string } | undefined;
  return r && { id: r.id, username: r.username, isAdmin: true };
}

/**
 * The user an identity provider signed in (D69), created on first sign-in. Matched by `externalId` (issuer and
 * subject) only. The name is the provider's, made unique with "-2", "-3"… when a local user has it.
 * External users have no password: "!" is not a hash, so the password form never lets them in.
 */
export function findOrCreateExternalUser(db: Db, externalId: string, name: string, now: number): User {
  const found = db.prepare("SELECT id, username, is_admin FROM app_user WHERE external_id = ?").get(externalId) as
    | { id: number; username: string; is_admin: number }
    | undefined;
  if (found) return { id: found.id, username: found.username, isAdmin: found.is_admin === 1 };
  const base = name.trim().slice(0, 60) || "user";
  for (let n = 1; n < 1000; n++) {
    const username = n === 1 ? base : `${base}-${n}`;
    const r = db.prepare(
      `INSERT INTO app_user (username, password_hash, is_admin, created_at, external_id)
       VALUES (?, '!', 1, ?, ?) ON CONFLICT DO NOTHING RETURNING id, username`,
    ).get(username, now, externalId) as { id: number; username: string } | undefined;
    if (r) return { id: r.id, username: r.username, isAdmin: true };
  }
  throw new Error("cannot find a free username");
}

export interface SessionRow {
  userId: number;
  username: string;
  isAdmin: boolean;
  csrfToken: string;
  lastSeenAt: number;
  expiresAt: number;
}

export function insertSession(
  db: Db,
  s: { idHash: string; userId: number; csrfToken: string; now: number; expiresAt: number },
): void {
  db.prepare(
    "INSERT INTO session (id_hash, user_id, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(s.idHash, s.userId, s.csrfToken, s.now, s.now, s.expiresAt);
}

export function findSession(db: Db, idHash: string): SessionRow | undefined {
  const r = db.prepare(
    `SELECT s.user_id, u.username, u.is_admin, s.csrf_token, s.last_seen_at, s.expires_at
     FROM session s JOIN app_user u ON u.id = s.user_id WHERE s.id_hash = ?`,
  ).get(idHash) as
    | {
      user_id: number;
      username: string;
      is_admin: number;
      csrf_token: string;
      last_seen_at: number;
      expires_at: number;
    }
    | undefined;
  return r && {
    userId: r.user_id,
    username: r.username,
    isAdmin: r.is_admin === 1,
    csrfToken: r.csrf_token,
    lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at,
  };
}

export function touchSession(db: Db, idHash: string, now: number): void {
  db.prepare("UPDATE session SET last_seen_at = ? WHERE id_hash = ?").run(now, idHash);
}

export function deleteSession(db: Db, idHash: string): void {
  db.prepare("DELETE FROM session WHERE id_hash = ?").run(idHash);
}

export function deleteExpiredSessions(db: Db, now: number, idleMs: number): number {
  return Number(
    db.prepare("DELETE FROM session WHERE expires_at <= ? OR last_seen_at <= ?").run(now, now - idleMs).changes,
  );
}
