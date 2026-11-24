/** fpcalc wrapper on generated fixtures (scripts/gen_fixtures.sh). */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { fileURLToPath } from "node:url";
import { FingerprintError, fingerprintFile } from "../../server/tagio/mod.ts";

const audio = (name: string) => fileURLToPath(new URL(`../fixtures/audio/${name}`, import.meta.url));

Deno.test("fpcalc fingerprints the 15 s fixture, identically on every run", async () => {
  const a = await fingerprintFile(audio("fingerprint.flac"));
  const b = await fingerprintFile(audio("fingerprint.flac"));
  assertEquals(a.durationSec, 15);
  assert(a.fingerprint.length > 50, `short fingerprint: ${a.fingerprint}`);
  assertEquals(a.fingerprint, b.fingerprint);
});

Deno.test("audio too short or uniform for Chromaprint is a FingerprintError", async () => {
  // The 2 s sine fixtures give fpcalc's "Empty fingerprint".
  await assertRejects(() => fingerprintFile(audio("blank.flac")), FingerprintError, "fpcalc failed");
});

Deno.test("relative paths are refused before fpcalc runs", async () => {
  await assertRejects(() => fingerprintFile("-version"), FingerprintError, "absolute path");
});
