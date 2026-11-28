/** The providers page's switch shows whether a provider is used (D67). */
import { assertEquals } from "@std/assert";
import { switchState } from "../../web/src/providers.ts";

const secret = { optional: false };

Deno.test("a provider that needs credentials is shown off, and locked, until they are saved", () => {
  assertEquals(switchState({ enabled: true, configured: false, fields: [secret] }), {
    checked: false,
    disabled: true,
    hint: "Save its credentials first",
  });
  assertEquals(switchState({ enabled: true, configured: true, fields: [secret] }), {
    checked: true,
    disabled: false,
    hint: null,
  });
  assertEquals(switchState({ enabled: false, configured: true, fields: [secret] })?.checked, false);
  // Deezer: nothing to set up, the saved choice as it is; MusicBrainz: always on, no switch.
  assertEquals(switchState({ enabled: true, configured: true, fields: [] })?.checked, true);
  assertEquals(switchState({ enabled: null, configured: true, fields: [] }), null);
});

Deno.test("the providers list says, in one word, the most telling thing about each (D75)", async () => {
  const { providerStatus } = await import("../../web/src/providers.ts");
  const ok = { ok: true, message: "", checkedAt: 1 };
  const base = { enabled: true, configured: true, fields: [secret], health: ok, test: null };
  assertEquals(providerStatus({ ...base, configured: false }).label, "not set up", "before off: it cannot be used");
  assertEquals(providerStatus({ ...base, configured: false, enabled: false }).label, "not set up");
  assertEquals(providerStatus({ ...base, enabled: false }).label, "off");
  assertEquals(providerStatus({ ...base, test: {} }).label, "checking…");
  assertEquals(providerStatus({ ...base, health: null }).label, "not checked");
  assertEquals(providerStatus(base), { label: "working", tone: "ok" });
  assertEquals(providerStatus({ ...base, health: { ...ok, ok: false } }), { label: "problem", tone: "error" });
  // MusicBrainz: always on, nothing to set up.
  assertEquals(providerStatus({ ...base, enabled: null, fields: [] }).label, "working");
});
