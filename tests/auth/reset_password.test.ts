/** `reset-password` (D71): a local account's password set from the container, its sessions ended. */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { hashPassword, verifyPassword } from "../../server/auth/password.ts";
import { SessionStore } from "../../server/auth/sessions.ts";
import { ResetError, resetPassword } from "../../server/cli/reset_password.ts";
import { createFirstAdmin, findOrCreateExternalUser, findUserByName } from "../../server/db/repo/users.ts";
import { memoryDb } from "../helpers/app.ts";

Deno.test("a local account gets the new password and is signed out everywhere", async () => {
  const db = await memoryDb();
  const admin = createFirstAdmin(db, "admin", await hashPassword("old-password-1"), 1)!;
  const sessions = new SessionStore(db, { idleMs: 3_600_000, maxMs: 86_400_000 });
  const a = await sessions.create(admin.id);
  await sessions.create(admin.id);
  assertEquals(await resetPassword(db, "admin", "brand-new-password"), { signedOut: 2 });
  const u = findUserByName(db, "admin")!;
  assert(await verifyPassword("brand-new-password", u.passwordHash));
  assert(!(await verifyPassword("old-password-1", u.passwordHash)));
  assertEquals(await sessions.get(a.id), undefined);
  db.close();
});

Deno.test("refused: an unknown name, an account without a password, a short password", async () => {
  const db = await memoryDb();
  createFirstAdmin(db, "admin", await hashPassword("old-password-1"), 1);
  findOrCreateExternalUser(db, "oidc:https://idp/#u1", "alice", 1);
  await assertRejects(() => resetPassword(db, "nobody", "brand-new-password"), ResetError, "no account");
  await assertRejects(() => resetPassword(db, "alice", "brand-new-password"), ResetError, "no account");
  await assertRejects(() => resetPassword(db, "admin", "short"), ResetError, "at least 10");
  assert(await verifyPassword("old-password-1", findUserByName(db, "admin")!.passwordHash), "unchanged");
  db.close();
});
