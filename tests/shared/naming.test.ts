/** File naming templates (D57): validation, rendering and safe names. */
import { assertEquals, assertThrows } from "@std/assert";
import {
  activeTemplate,
  DEFAULT_TEMPLATE,
  PRESET_TEMPLATES,
  renderPath,
  sanitizeName,
  validateNamingSettings,
  validateTemplate,
} from "../../shared/naming.ts";

const LUKAS = {
  album: "Lukas Sternath plays Franz Schubert and Franz Liszt",
  artist: "Franz Schubert & Franz Liszt",
  title: "Der Wanderer S 558/11 (after D 489)",
  date: "2026-10-23",
  tracknumber: 1,
  discnumber: 1,
  totaldiscs: 2,
};

Deno.test("the default template names albums like the maintainer's test folder", () => {
  assertEquals(
    renderPath(DEFAULT_TEMPLATE, LUKAS, "FLAC"),
    "Lukas Sternath plays Franz Schubert and Franz Liszt (2026)/1-01 Franz Schubert & Franz Liszt - Der Wanderer S 558_11 (after D 489).flac",
  );
  // One disc: no disc prefix.
  assertEquals(
    renderPath(DEFAULT_TEMPLATE, { ...LUKAS, totaldiscs: 1 }, "flac").split("/")[1].slice(0, 3),
    "01 ",
  );
  // No disc total, but disc 2: still several discs.
  assertEquals(
    renderPath("{disc-}{tracknumber:02} {title}", { ...LUKAS, totaldiscs: undefined, discnumber: 2 }, "flac"),
    "2-01 Der Wanderer S 558_11 (after D 489).flac",
  );
});

Deno.test("alternatives, truncation, padding, lists and missing values", () => {
  const t = (tpl: string, tags: Record<string, unknown>) => renderPath(tpl, tags, "mp3");
  assertEquals(t("{albumartist|artist}/{title}", { artist: "A", title: "T" }), "A/T.mp3");
  assertEquals(t("{albumartist|artist}/{title}", { albumartist: "AA", artist: "A", title: "T" }), "AA/T.mp3");
  assertEquals(
    t("{date:4}/{tracknumber:03} {title}", { date: "1978-05", tracknumber: 7, title: "T" }),
    "1978/007 T.mp3",
  );
  assertEquals(t("{label}/{title}", { label: ["DG", "Polydor"], title: "T" }), "DG, Polydor/T.mp3");
  assertEquals(t("{album}/{title}", { title: "T" }), "[unknown album]/T.mp3");
});

Deno.test("names are safe on NAS, SMB and Windows file systems", () => {
  assertEquals(sanitizeName('a/b\\c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j");
  assertEquals(sanitizeName("  Vol.   2...  "), "Vol. 2");
  assertEquals(sanitizeName(".hidden"), "_hidden");
  assertEquals(sanitizeName("Cafe\u0301"), "Café", "NFC");
  // A title that is only dots never makes "." or "..".
  assertEquals(renderPath("{album}/{title}", { album: "..", title: "T" }, "flac"), "_/T.flac");
  const long = "é".repeat(300);
  const name = renderPath("{album}/{title}", { album: long, title: long }, "flac").split("/");
  assertEquals(new TextEncoder().encode(name[0]).length <= 255, true);
  assertEquals(new TextEncoder().encode(name[1]).length <= 255 && name[1].endsWith(".flac"), true);
});

Deno.test("templates that cannot work are refused, with the reason", () => {
  assertEquals(validateTemplate(DEFAULT_TEMPLATE), null);
  const bad: [string, RegExp][] = [
    ["", /empty/],
    ["/music/{title}", /absolute/],
    ["C:/x/{title}", /absolute/],
    ["{album}\\{title}", /Use \//],
    ["{album}//{title}", /empty folder/],
    ["{album}/../{title}", /not allowed/],
    ["{album}/{titel}", /unknown field "titel"/],
    ["{album}/{title", /without its "\}"/],
    ["{album}/title}", /without its "\{"/],
    ["{album}/{tracknumber:xx}", /use a number/],
    ["{album}/{performer} {title}", /unknown field/],
    ["{album}/{artist}", /needs \{title\} or \{tracknumber\}/],
  ];
  for (const [tpl, why] of bad) {
    const e = validateTemplate(tpl);
    assertEquals(e !== null && why.test(e), true, `${tpl}: ${e}`);
  }
  assertThrows(() => renderPath("{nope}/{title}", {}, "flac"));
});

Deno.test("built-in templates are valid; saved ones need a unique name, a valid template and an id", () => {
  for (const t of PRESET_TEMPLATES) assertEquals(validateTemplate(t.template), null, t.name);
  assertEquals(PRESET_TEMPLATES[0].template, DEFAULT_TEMPLATE);
  const ok = { id: "custom-1", name: "Mine", template: "{album}/{title}" };
  assertEquals(validateNamingSettings({ active: "custom-1", templates: [ok] }), []);
  const why = (files: Parameters<typeof validateNamingSettings>[0]) =>
    validateNamingSettings(files).map((i) => `${i.path.join(".")}: ${i.message}`);
  assertEquals(why({ active: "album-year", templates: [{ ...ok, name: "album (YEAR)" }] }), [
    'templates.0.name: A template is already called "album (YEAR)"',
  ]);
  assertEquals(why({ active: "album-year", templates: [ok, { ...ok, name: "Other" }] }), [
    "templates.1.id: Invalid template id",
  ]);
  assertEquals(why({ active: "album-year", templates: [{ ...ok, id: "../x" }] }), [
    "templates.0.id: Invalid template id",
  ]);
  assertEquals(why({ active: "nope", templates: [] }), ["active: The chosen template does not exist"]);
  // A deleted template that is still chosen falls back to the default when used.
  assertEquals(activeTemplate({ active: "custom-gone", templates: [] }).id, "album-year");
});
