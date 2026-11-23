import { assert, assertEquals, assertThrows } from "@std/assert";
import { loadMigrations, migrate, openDb } from "../../server/db/db.ts";

Deno.test("migrations apply once, in order, and are recorded", async () => {
  const db = openDb(":memory:");
  const all = await loadMigrations();
  assertEquals(all[0].version, 1);
  assertEquals(migrate(db, all), all.map((m) => m.version));
  assertEquals(migrate(db, all), [], "second run is a no-op");
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
    .map((r) => r.name);
  for (const t of ["app_user", "session", "candidate", "library_file", "job", "schema_migrations"]) {
    assert(tables.includes(t), `missing table ${t}`);
  }
  assertEquals((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
  db.close();
});

Deno.test("a failing migration rolls back completely", () => {
  const db = openDb(":memory:");
  assertThrows(() =>
    migrate(db, [{ version: 1, name: "bad", sql: "CREATE TABLE half (x INTEGER); THIS IS NOT SQL;" }])
  );
  const t = db.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'half'").get() as { n: number };
  assertEquals(t.n, 0);
  assertEquals((db.prepare("SELECT count(*) n FROM schema_migrations").get() as { n: number }).n, 0);
  db.close();
});

Deno.test("refuses a database migrated by a newer Tagmonia", async () => {
  const db = openDb(":memory:");
  const all = await loadMigrations();
  migrate(db, [...all, { version: all.length + 1, name: "future", sql: "SELECT 1" }]);
  assertThrows(() => migrate(db, all), Error, "newer than this version");
  db.close();
});

Deno.test("file databases use WAL and are readable by the owner only", async () => {
  const dir = await Deno.makeTempDir();
  const db = openDb(`${dir}/t.db`);
  assertEquals((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  assertEquals((await Deno.stat(`${dir}/t.db`)).mode! & 0o777, 0o600);
  db.close();
  await Deno.remove(dir, { recursive: true });
});
