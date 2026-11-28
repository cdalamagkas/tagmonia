/**
 * `reset-password [username]` (D71): sets a local account's password from the container, for when nobody can
 * sign in. Asks twice, with the typing hidden; or takes the password as the first line of stdin, for scripts.
 * Ends that account's sessions. Works while Tagmonia runs: the database is in WAL mode.
 *
 *   docker exec -it tagmonia reset-password admin
 *   printf '%s\n' "$NEW_PASSWORD" | docker exec -i tagmonia reset-password admin
 */
import { join } from "node:path";
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../auth/password.ts";
import { type Db, openMigratedDb } from "../db/db.ts";
import { findLocalUser, setPassword } from "../db/repo/users.ts";

export class ResetError extends Error {
  override name = "ResetError";
}

/** The check and the change, apart from any terminal: what the tests drive. */
export async function resetPassword(db: Db, username: string, password: string): Promise<{ signedOut: number }> {
  const user = findLocalUser(db, username);
  if (!user) {
    throw new ResetError(`no account named "${username}" signs in with a password here`);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ResetError(`the password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) throw new ResetError("the password is too long");
  return { signedOut: setPassword(db, user.id, await hashPassword(password)) };
}

/** Reads one line from the terminal without showing it. */
async function readHidden(question: string): Promise<string> {
  const enc = new TextEncoder();
  await Deno.stdout.write(enc.encode(question));
  Deno.stdin.setRaw(true);
  const chars: string[] = [];
  const buf = new Uint8Array(64);
  try {
    outer: while (true) {
      const n = await Deno.stdin.read(buf);
      if (n === null) break;
      for (const ch of new TextDecoder().decode(buf.subarray(0, n))) {
        if (ch === "\r" || ch === "\n") break outer;
        if (ch === "\u0003") throw new ResetError("cancelled"); // Ctrl-C
        if (ch === "\u007f" || ch === "\b") chars.pop();
        else if (ch >= " ") chars.push(ch);
      }
    }
  } finally {
    Deno.stdin.setRaw(false);
    await Deno.stdout.write(enc.encode("\n"));
  }
  return chars.join("");
}

async function main(): Promise<number> {
  const username = Deno.args[0] ?? "admin";
  const path = join(Deno.env.get("TAGMONIA_CONFIG_DIR") ?? "/config", "tagmonia.db");
  try {
    await Deno.stat(path);
  } catch {
    console.error(`No Tagmonia database at ${path}: is this the right container, and has Tagmonia started once?`);
    return 1;
  }
  let password: string;
  if (Deno.stdin.isTerminal()) {
    password = await readHidden(`New password for ${username}: `);
    if (password !== await readHidden("Again: ")) {
      console.error("The two passwords differ; nothing changed.");
      return 1;
    }
  } else {
    password = (await new Response(Deno.stdin.readable).text()).split(/\r?\n/)[0];
  }
  const db = await openMigratedDb(path);
  try {
    const { signedOut } = await resetPassword(db, username, password);
    console.log(
      `Password changed for ${username}.${signedOut ? ` ${signedOut} session(s) signed out.` : ""}`,
    );
    return 0;
  } catch (e) {
    console.error(e instanceof ResetError ? `Nothing changed: ${e.message}.` : (e as Error).message);
    return 1;
  } finally {
    db.close();
  }
}

if (import.meta.main) Deno.exit(await main());
