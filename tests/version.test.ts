/** The running version (D74): a release's from its tag, else the development version. */
import { assertEquals, assertMatch } from "@std/assert";
import { parseVersion, USER_AGENT, VERSION } from "../server/version.ts";

Deno.test("release versions as tags write them; anything else is ignored", () => {
  assertEquals(parseVersion("1.2.0\n"), "1.2.0");
  assertEquals(parseVersion("v1.2.0"), "1.2.0");
  assertEquals(parseVersion("1.2.0-rc.1"), "1.2.0-rc.1");
  for (const bad of ["", "dev", "1.2", "1.2.0 extra", "../etc/passwd", null, undefined]) {
    assertEquals(parseVersion(bad), null, String(bad));
  }
});

Deno.test("without a release file, the development version, in the MusicBrainz User-Agent", () => {
  assertEquals(VERSION, "0.1.0-dev");
  assertMatch(USER_AGENT, /^Tagmonia\/0\.1\.0-dev \( https:\/\/github\.com\/cdalamagkas\/tagmonia \)$/);
});
