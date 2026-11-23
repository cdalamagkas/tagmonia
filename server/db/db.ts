/**
 * SQLite access (ARCHITECTURE.md §4, D19): Deno's built-in `node:sqlite`, so
 * there is no native add-on or FFI download. WAL mode; one writer is enough.
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Db = DatabaseSync;

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") {
    // Holds password hashes and session hashes: owner-only (SQLite gives -wal/-shm the same mode).
    Deno.chmodSync(path, 0o600);
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const out: Migration[] = [];
  for await (const e of Deno.readDir(dir)) {
    const m = /^(\d{4})_([\w-]+)\.sql$/.exec(e.name);
    if (!e.isFile || !m) continue;
    out.push({ version: Number(m[1]), name: m[2], sql: await Deno.readTextFile(join(dir, e.name)) });
  }
  out.sort((a, b) => a.version - b.version);
  out.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migration numbering gap at ${m.version}_${m.name}`);
  });
  return out;
}

/** Applies pending migrations, each in its own transaction. Returns the versions applied. */
export function migrate(db: Db, migrations: Migration[]): number[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  );
  const done = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version),
  );
  const newest = Math.max(0, ...done);
  if (migrations.length < newest) {
    // Refuse to run an older Tagmony on a database a newer one has migrated.
    throw new Error(`database schema v${newest} is newer than this version of Tagmony supports`);
  }
  const applied: number[] = [];
  for (const m of migrations) {
    if (done.has(m.version)) continue;
    transaction(db, () => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        Date.now(),
      );
    });
    applied.push(m.version);
  }
  return applied;
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export async function openMigratedDb(path: string): Promise<Db> {
  const db = openDb(path);
  migrate(db, await loadMigrations());
  return db;
}
