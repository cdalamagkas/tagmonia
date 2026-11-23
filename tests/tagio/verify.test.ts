import { assertEquals } from "@std/assert";
import { storableTags, supportsField, verifyChange } from "../../server/tagio/verify.ts";

Deno.test("MP4 cannot store performer; other formats can", () => {
  assertEquals(supportsField("m4a", "performer"), false);
  assertEquals(supportsField("flac", "performer"), true);
  assertEquals(storableTags("m4a", { title: "x", performer: { guitar: ["a"] } }), { title: "x" });
});

Deno.test("verifyChange reports exact mismatches without normalising", () => {
  const after = { title: "Café", artists: ["A", "B"], performer: { vocals: ["X"] } };
  assertEquals(verifyChange("flac", { set: { title: "Café" }, remove: [] }, after).map((m) => m.field), ["title"]);
  assertEquals(verifyChange("flac", { set: { artists: ["A", "B"] }, remove: [] }, after), []);
  assertEquals(verifyChange("flac", { set: { performer: { vocals: ["X"] } }, remove: [] }, after), []);
  assertEquals(verifyChange("flac", { set: {}, remove: ["artists"] }, after).map((m) => m.field), ["artists"]);
  assertEquals(verifyChange("m4a", { set: { performer: { vocals: ["Y"] } }, remove: [] }, after), []);
});
