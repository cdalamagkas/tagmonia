/**
 * Snapshot cache for provider responses (ARCHITECTURE.md §9.4). Every provider
 * call checks here first; a new fetch adds a row instead of replacing one, so
 * proposals can cite the exact response they were built from.
 */
import { dirname, join } from "node:path";
import type { Db } from "../db/db.ts";

export interface Snapshot {
  id: number;
  provider: string;
  requestKey: string;
  status: number;
  fetchedAt: number;
  body: string;
}

interface SnapshotRow {
  id: number;
  provider: string;
  request_key: string;
  status: number;
  fetched_at: number;
  body_path: string;
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class SnapshotCache {
  constructor(
    private readonly db: Db,
    /** e.g. /config/snaps; created on first write. */
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Newest snapshot younger than `maxAgeMs`, or null. A missing body file counts as a miss. */
  async get(provider: string, requestKey: string, maxAgeMs: number): Promise<Snapshot | null> {
    const row = this.db.prepare(
      `SELECT id, provider, request_key, status, fetched_at, body_path FROM snapshot
       WHERE provider = ? AND request_key = ? AND fetched_at >= ?
       ORDER BY fetched_at DESC, id DESC LIMIT 1`,
    ).get(provider, requestKey, this.now() - maxAgeMs) as SnapshotRow | undefined;
    if (!row) return null;
    try {
      return this.#toSnapshot(row, await Deno.readTextFile(join(this.dir, row.body_path)));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return null;
      throw e;
    }
  }

  async put(provider: string, requestKey: string, status: number, body: string): Promise<Snapshot> {
    if (!/^[a-z0-9_-]+$/.test(provider)) throw new Error(`invalid provider id ${provider}`);
    const fetchedAt = this.now();
    // Hashing keeps arbitrary query strings out of file names; the timestamp keeps old versions.
    const hash = await sha256Hex(requestKey);
    const rel = join(provider, hash.slice(0, 2), `${hash}-${fetchedAt}.json`);
    const abs = join(this.dir, rel);
    await Deno.mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp`;
    await Deno.writeTextFile(tmp, body);
    await Deno.rename(tmp, abs);
    const { id } = this.db.prepare(
      `INSERT INTO snapshot (provider, request_key, status, fetched_at, body_path, size)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    ).get(provider, requestKey, status, fetchedAt, rel, new TextEncoder().encode(body).length) as { id: number };
    return { id, provider, requestKey, status, fetchedAt, body };
  }

  async byId(id: number): Promise<Snapshot | null> {
    const row = this.db.prepare(
      "SELECT id, provider, request_key, status, fetched_at, body_path FROM snapshot WHERE id = ?",
    ).get(id) as SnapshotRow | undefined;
    if (!row) return null;
    return this.#toSnapshot(row, await Deno.readTextFile(join(this.dir, row.body_path)));
  }

  #toSnapshot(row: SnapshotRow, body: string): Snapshot {
    return {
      id: row.id,
      provider: row.provider,
      requestKey: row.request_key,
      status: row.status,
      fetchedAt: row.fetched_at,
      body,
    };
  }
}
