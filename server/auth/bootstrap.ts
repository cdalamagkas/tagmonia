/** Bootstrap admin from TAGMONY_ADMIN_PASSWORD_FILE (a Docker secret), §14.1. */
import type { Db } from "../db/db.ts";
import { countUsers, createFirstAdmin } from "../db/repo/users.ts";
import type { Logger } from "../log.ts";
import { hashPassword, MIN_PASSWORD_LENGTH } from "./password.ts";

export const BOOTSTRAP_USERNAME = "admin";

/** Creates user "admin" from the file only while no user exists; later changes to the file are ignored. */
export async function bootstrapAdmin(db: Db, passwordFile: string | undefined, logger: Logger): Promise<boolean> {
  if (!passwordFile || countUsers(db) > 0) return false;
  // Trailing newlines come from `echo pw > file`; other whitespace is part of the password.
  const password = (await Deno.readTextFile(passwordFile)).replace(/[\r\n]+$/, "");
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`TAGMONY_ADMIN_PASSWORD_FILE: password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const user = createFirstAdmin(db, BOOTSTRAP_USERNAME, await hashPassword(password), Date.now());
  if (user) logger.info("admin user created from TAGMONY_ADMIN_PASSWORD_FILE", { user: user.username });
  return !!user;
}
