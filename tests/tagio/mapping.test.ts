/**
 * Verifies server/tagio/mapping.ts against Picard's published tag mapping
 * (Phase 0: "Verify the Picard mapping rows in §11.2").
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIELD_MAPPINGS, MP4_FREEFORM, parseVorbisPerformer } from "../../server/tagio/mapping.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const rows = new Map<string, { id3: string; vorbis: string; mp4: string }>();
for (const line of (await Deno.readTextFile(join(here, "../fixtures/picard_tag_map.tsv"))).split("\n")) {
  if (!line.trim() || line.startsWith("#")) continue;
  const [name, id3, vorbis, mp4] = line.split("\t");
  rows.set(name.split(" ")[0], { id3, vorbis, mp4 });
}

/**
 * Where Picard's docs table disagrees with what Picard's code writes, the code
 * wins (D35): formats/mp4.py and mutagen use the iTunes atoms ©mvi and ©mvc.
 */
const PICARD_DOC_ERRATA: Record<string, { mp4: string }> = {
  movementnumber: { mp4: "©mvi" },
  movementtotal: { mp4: "©mvc" },
};

/** Picard cells look like "TDRC (ID3v2.4) TYER + TDAT (ID3v2.3)": the first token is the v2.4/default form. */
function primary(cell: string): string {
  return cell.split(/ \(|\s+(?=TXXX:|TIT1|GRP1)/)[0].trim();
}

Deno.test("every Picard-defined field matches Picard's ID3v2.4, Vorbis and MP4 keys", () => {
  for (const m of FIELD_MAPPINGS) {
    if (m.picard === null) continue;
    const row = rows.get(m.picard);
    assert(row, `Picard has no row for ${m.picard}`);
    if (m.kind === "performer") {
      assert(row.id3.startsWith(`${m.id3}:`), `${m.field} id3`);
      assert(row.vorbis.startsWith(`${m.vorbis[0]}=`), `${m.field} vorbis`);
      assertEquals(row.mp4, "n/a");
      assertEquals(m.mp4, null);
      continue;
    }
    assertEquals(m.id3, primary(row.id3), `${m.field} id3`);
    assertEquals(m.vorbis, row.vorbis.split(" and "), `${m.field} vorbis`);
    if (row.mp4 === "n/a") {
      // Picard writes unmapped tags as a freeform atom named after the internal name (D9).
      assertEquals(m.mp4, MP4_FREEFORM + m.picard, `${m.field} mp4`);
    } else {
      assertEquals(m.mp4, PICARD_DOC_ERRATA[m.picard]?.mp4 ?? primary(row.mp4), `${m.field} mp4`);
    }
  }
});

Deno.test("canonical field names equal Picard internal names where Picard defines them", () => {
  for (const m of FIELD_MAPPINGS) {
    if (m.picard && m.kind !== "performer") assertEquals(m.field, m.picard);
  }
});

Deno.test("Vorbis performer values parse as Picard writes them", () => {
  assertEquals(parseVorbisPerformer("Angus Young (guitar)"), { name: "Angus Young", role: "guitar" });
  assertEquals(parseVorbisPerformer("Art Garfunkel (Vocals)"), { name: "Art Garfunkel", role: "vocals" });
  assertEquals(parseVorbisPerformer("Bob (Live) (drums)"), { name: "Bob (Live)", role: "drums" });
  assertEquals(parseVorbisPerformer("No Role"), { name: "No Role", role: "" });
});
