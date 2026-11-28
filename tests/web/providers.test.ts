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
