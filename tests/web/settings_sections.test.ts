/** Settings' sections each have an address (D75). */
import { assertEquals } from "@std/assert";
import { parseRoute } from "../../web/src/router.ts";
import { SETTINGS_SECTIONS } from "../../web/src/settings/sections.ts";

Deno.test("each section has its address; /settings opens Account; an unknown one is not found", () => {
  assertEquals(parseRoute("/settings"), { page: "settings", section: "account" });
  assertEquals(parseRoute("/settings/"), { page: "settings", section: "account" });
  for (const s of SETTINGS_SECTIONS) {
    assertEquals(parseRoute(`/settings/${s.id}`), { page: "settings", section: s.id });
    assertEquals(parseRoute(`/settings/${s.id}/`), { page: "settings", section: s.id });
  }
  assertEquals(parseRoute("/settings/nope"), { page: "notFound" });
  assertEquals(parseRoute("/settings/providers/youtube"), { page: "notFound" });
});
