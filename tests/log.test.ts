import { assert, assertEquals } from "@std/assert";
import { createLogger, redact, REDACTED } from "../server/log.ts";

Deno.test("secret-looking fields, URL credentials and secret query parameters are redacted (§14.3)", () => {
  const lines: string[] = [];
  const log = createLogger("debug", (l) => lines.push(l));
  log.info("calling https://user:pa55@api.example/x?token=abc123&q=ok", {
    password: "hunter2",
    nested: { apiKey: "k-123", Authorization: "Bearer zzz", fine: "visible" },
    list: [{ session_id: "s-1" }],
    url: "https://api.discogs.com/database/search?q=x&secret=shh",
  });
  const out = lines[0];
  for (const s of ["hunter2", "k-123", "Bearer zzz", "s-1", "pa55", "abc123", "shh"]) assert(!out.includes(s), out);
  assert(out.includes("visible") && out.includes("q=ok"), out);
  assertEquals(redact({ csrfToken: "t" }), { csrfToken: REDACTED });
});

Deno.test("log level filters lower levels", () => {
  const lines: string[] = [];
  const log = createLogger("warn", (l) => lines.push(l));
  log.info("no");
  log.warn("yes");
  assertEquals(lines.length, 1);
});
