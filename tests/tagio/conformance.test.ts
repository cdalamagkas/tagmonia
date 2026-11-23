/**
 * TagIO conformance suite (ARCHITECTURE.md §11.5). Must pass on all five
 * formats for the production implementation. Do not weaken or skip a case to
 * make a change pass (CLAUDE.md); fix the implementation or record a decision.
 *
 * Run against another implementation with TAGMONY_TAGIO_IMPL=taglib-wasm.
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { FIELD_MAPPINGS, MP4_FREEFORM } from "../../server/tagio/mapping.ts";
import { storableTags, verifyChange } from "../../server/tagio/verify.ts";
import { MutagenTagIO } from "../../server/tagio/impl/mutagen.ts";
import type { AudioFormat, CanonicalTags, TagIO } from "../../server/tagio/types.ts";
import {
  copyFixture,
  FIXTURE_TAGS,
  fixturePictures,
  fixturesPresent,
  FORMATS,
  IMPL,
  listDir,
  newTagIO,
  type RawDump,
  type RawId3,
  rawInspect,
  type RawMp4,
  type RawVorbis,
  sha256,
  VORBIS_FORMATS,
} from "./helpers.ts";

if (!(await fixturesPresent())) {
  throw new Error("Audio fixtures missing: run `scripts/dk scripts/gen_fixtures.sh` (see README).");
}

function asList(kind: string, v: unknown): string[] {
  return kind === "multi" ? (v as string[]) : [String(v)];
}

/** Asserts that each canonical field sits under exactly the native key(s) mapping.ts prescribes. */
function assertPicardLayout(format: AudioFormat, raw: RawDump, tags: CanonicalTags) {
  const t = tags as Record<string, unknown>;
  for (const m of FIELD_MAPPINGS) {
    const v = t[m.field];
    if (v === undefined) continue;
    const where = `${format} ${m.field}`;
    if (raw.kind === "vorbis") {
      const get = (k: string) => raw.comments.filter(([key]) => key.toUpperCase() === k).map(([, val]) => val);
      if (m.kind === "performer") {
        const expected = Object.entries(v as Record<string, string[]>).flatMap(([role, names]) =>
          names.map((n) => `${n} (${role})`)
        );
        assertEquals(get("PERFORMER").sort(), expected.sort(), where);
        continue;
      }
      for (const key of m.vorbis) assertEquals(get(key), asList(m.kind, v), `${where} -> ${key}`);
    } else if (raw.kind === "id3") {
      if (m.pair) {
        const frame = raw.frames.filter((f) => f.id === m.id3);
        assertEquals(frame.length, 1, where);
        const parts = frame[0].text![0].split("/");
        assertEquals(Number(parts[m.pair.index]), v, where);
        continue;
      }
      if (m.kind === "performer") {
        const tmcl = raw.frames.filter((f) => f.id === "TMCL");
        assertEquals(tmcl.length, 1, where);
        const expected = Object.entries(v as Record<string, string[]>).flatMap(([role, names]) =>
          names.map((n) => [role, n])
        );
        assertEquals(tmcl[0].people, expected, where);
        continue;
      }
      if (m.id3.startsWith("UFID:")) {
        const f = raw.frames.filter((f) => f.hash === m.id3);
        assertEquals(f.map((x) => x.data), [String(v)], where);
        continue;
      }
      // Exact hash match, i.e. exact TXXX description casing as Picard writes it.
      const frames = raw.frames.filter((f) => f.hash === m.id3);
      assertEquals(frames.length, 1, `${where}: expected one ${m.id3} frame, got ${frames.length}`);
      assertEquals(frames[0].text, asList(m.kind, v), where);
      if (m.id3.startsWith("TXXX:")) {
        const sameDesc = raw.frames.filter((f) =>
          f.id === "TXXX" && f.desc?.toLowerCase() === m.id3.slice(5).toLowerCase()
        );
        assertEquals(sameDesc.length, 1, `${where}: duplicate TXXX with different case`);
      }
    } else {
      if (m.mp4 === null) continue;
      if (m.pair) {
        const items = raw.items.filter((i) => i.key === m.mp4);
        assertEquals(items.length, 1, where);
        assertEquals((items[0].values[0] as number[])[m.pair.index], v, where);
        continue;
      }
      const items = raw.items.filter((i) => i.key === m.mp4);
      assertEquals(items.length, 1, `${where}: expected exactly one ${m.mp4} atom, got ${items.length}`);
      assertEquals(items[0].values, asList(m.kind, v), where);
      if (m.mp4.startsWith(MP4_FREEFORM)) {
        const ci = raw.items.filter((i) => i.key.toLowerCase() === m.mp4!.toLowerCase());
        assertEquals(ci.length, 1, `${where}: duplicate freeform atom with different case`);
      }
    }
  }
}

/** Raw entries minus the native keys of the given fields, normalised for order-insensitive comparison. */
function rawWithout(raw: RawDump, nativeKeys: string[]): string[] {
  const skip = new Set(nativeKeys.map((k) => k.toUpperCase()));
  if (raw.kind === "vorbis") {
    return [
      ...raw.comments.filter(([k]) => !skip.has(k.toUpperCase())).map(([k, v]) => `${k.toUpperCase()}=${v}`),
      ...raw.pictures.map((p) => `pic:${p.via}:${p.type}:${p.mime}:${p.sha}`),
    ].sort();
  }
  if (raw.kind === "id3") {
    return raw.frames.filter((f) => !skip.has(f.hash.toUpperCase())).map((f) => JSON.stringify(f)).sort();
  }
  return raw.items.filter((i) => !skip.has(i.key.toUpperCase())).map((i) => JSON.stringify(i)).sort();
}

function nativeKeysOf(format: AudioFormat, field: keyof CanonicalTags): string[] {
  const m = FIELD_MAPPINGS.find((x) => x.field === field)!;
  if (VORBIS_FORMATS.includes(format)) return m.vorbis;
  if (format === "mp3") return [m.id3];
  return m.mp4 ? [m.mp4] : [];
}

let tagio: TagIO;

Deno.test({
  name: `TagIO conformance [${IMPL}]`,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    tagio = await newTagIO();
    const pictures = await fixturePictures();
    const frontSha = await sha256(pictures[0].data);
    const backSha = await sha256(pictures[1].data);

    try {
      for (const format of FORMATS) {
        const expected = storableTags(format, FIXTURE_TAGS);

        await t.step(`${format}: reads Picard-style reference tags`, async () => {
          const { path } = await copyFixture(`tagged.${format}`);
          const r = await tagio.read(path);
          assertEquals(r.tags, expected);
          assertEquals(r.audio.format, format);
          assert(Math.abs(r.audio.durationMs - 2000) < 100, `duration ${r.audio.durationMs}`);
          const shas = await Promise.all(r.pictures.map((p) => sha256(p.data)));
          assertEquals(shas, [frontSha, backSha]);
          assertEquals(r.pictures[0].type, "front");
          // MP4 covr has no picture type field (D10).
          if (format !== "m4a") assertEquals(r.pictures[1].type, "back");
        });

        await t.step(`${format}: round-trips every canonical field (case 1, 6)`, async () => {
          const { path } = await copyFixture(`blank.${format}`);
          await tagio.write(path, { set: FIXTURE_TAGS, remove: [], pictures });
          const r = await tagio.read(path);
          assertEquals(verifyChange(format, { set: FIXTURE_TAGS, remove: [] }, r.tags), []);
          assertEquals(r.tags, expected);
          // Unicode is stored as given: no NFC normalisation of "Zoë".
          assertEquals(r.tags.artists?.[2], "Zoë Keating");
          assertNotEquals(r.tags.artists?.[2], "Zoë Keating".normalize("NFC"));
        });

        await t.step(`${format}: writes Picard's native layout (§11.2)`, async () => {
          const { path } = await copyFixture(`blank.${format}`);
          await tagio.write(path, { set: FIXTURE_TAGS, remove: [], pictures });
          assertPicardLayout(format, await rawInspect(path), expected);
        });

        await t.step(`${format}: multi-value artists with '&' and '/' kept as 3 values (case 2, 3)`, async () => {
          const { path } = await copyFixture(`blank.${format}`);
          const artists = ["AC/DC", "Simon & Garfunkel", "Zoë Keating"];
          await tagio.write(path, { set: { artists }, remove: [] });
          assertEquals((await tagio.read(path)).tags.artists, artists);
          const raw = await rawInspect(path);
          if (raw.kind === "vorbis") {
            assertEquals(raw.comments.filter(([k]) => k.toUpperCase() === "ARTISTS").map(([, v]) => v), artists);
          } else if (raw.kind === "id3") {
            const frames = (raw as RawId3).frames.filter((f) => f.hash === "TXXX:ARTISTS");
            assertEquals(frames.length, 1);
            assertEquals(frames[0].text, artists);
            assertEquals((raw as RawId3).version[1], 4);
          } else {
            const atoms = (raw as RawMp4).items.filter((i) => i.key === `${MP4_FREEFORM}ARTISTS`);
            assertEquals(atoms.length, 1, "MP4 multi-value must live in a single atom");
            assertEquals(atoms[0].values, artists);
          }
        });

        await t.step(`${format}: front cover written in the format's picture slot (case 4)`, async () => {
          const { path } = await copyFixture(`blank.${format}`);
          await tagio.write(path, { set: {}, remove: [], pictures: [pictures[0]] });
          const r = await tagio.read(path);
          assertEquals(r.pictures.length, 1);
          assertEquals(r.pictures[0].type, "front");
          assertEquals(r.pictures[0].mime, "image/png");
          assertEquals(await sha256(r.pictures[0].data), frontSha);
          const raw = await rawInspect(path);
          if (raw.kind === "vorbis") {
            const via = format === "flac" ? "PICTURE" : "METADATA_BLOCK_PICTURE";
            assertEquals((raw as RawVorbis).pictures.map((p) => [p.via, p.type, p.sha]), [[via, 3, frontSha]]);
          } else if (raw.kind === "id3") {
            assertEquals((raw as RawId3).frames.filter((f) => f.id === "APIC").map((f) => f.type), [3]);
          } else {
            assertEquals((raw as RawMp4).items.filter((i) => i.key === "covr").length, 1);
          }
        });

        await t.step(`${format}: unknown/custom tags preserved, nothing else changes (case 5)`, async () => {
          const { path } = await copyFixture(`tagged.${format}`);
          const before = await rawInspect(path);
          await tagio.write(path, { set: { title: "Changed" }, remove: [] });
          const after = await rawInspect(path);
          const titleKeys = nativeKeysOf(format, "title");
          assertEquals(rawWithout(after, titleKeys), rawWithout(before, titleKeys));
          assertEquals((await tagio.read(path)).tags.title, "Changed");
        });

        await t.step(`${format}: removes fields`, async () => {
          const { path } = await copyFixture(`tagged.${format}`);
          await tagio.write(path, { set: {}, remove: ["artists", "musicbrainz_albumid", "totaltracks"] });
          const r = await tagio.read(path);
          assertEquals(r.tags.artists, undefined);
          assertEquals(r.tags.musicbrainz_albumid, undefined);
          assertEquals(r.tags.totaltracks, undefined);
          assertEquals(r.tags.tracknumber, 3);
          const rest = { ...expected } as Record<string, unknown>;
          delete rest.artists, delete rest.musicbrainz_albumid, delete rest.totaltracks;
          assertEquals(r.tags, rest);
        });

        await t.step(`${format}: setting tracknumber keeps totaltracks`, async () => {
          const { path } = await copyFixture(`tagged.${format}`);
          await tagio.write(path, { set: { tracknumber: 5 }, remove: [] });
          const r = await tagio.read(path);
          assertEquals([r.tags.tracknumber, r.tags.totaltracks], [5, 12]);
        });

        await t.step(`${format}: write keeps file mode`, async () => {
          const { path } = await copyFixture(`tagged.${format}`);
          await Deno.chmod(path, 0o640);
          await tagio.write(path, { set: { title: "x" }, remove: [] });
          assertEquals((await Deno.stat(path)).mode! & 0o777, 0o640);
        });
      }

      await t.step("mp3: reads ID3v2.3 without splitting multi-values", async () => {
        const { path } = await copyFixture("tagged-v23.mp3");
        const r = await tagio.read(path);
        assertEquals(r.tags.title, FIXTURE_TAGS.title);
        assertEquals(r.tags.musicbrainz_albumid, FIXTURE_TAGS.musicbrainz_albumid);
        assertEquals(r.tags.date, FIXTURE_TAGS.date);
        assertEquals([r.tags.tracknumber, r.tags.totaltracks], [3, 12]);
        // v2.3 joined the values with '/'; never split on read (§11.2) since "AC/DC" would break.
        assertEquals(r.tags.artists, ["AC/DC/Simon & Garfunkel/Zoë Keating"]);
      });
    } finally {
      await tagio.close?.();
    }
  },
});

Deno.test({
  name: "TagIO atomicity: sidecar crash mid-write leaves original intact (case 7)",
  ignore: IMPL !== "mutagen",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const io = new MutagenTagIO({ fault: "crash-mid-write" });
    try {
      for (const format of FORMATS) {
        const { path, dir } = await copyFixture(`tagged.${format}`);
        const before = await sha256(await Deno.readFile(path));
        await assertRejects(() => io.write(path, { set: { title: "never" }, remove: [] }));
        assertEquals(await sha256(await Deno.readFile(path)), before, format);
        assertEquals(await listDir(dir), [`tagged.${format}`], `${format}: temp file left behind`);
      }
    } finally {
      await io.close();
    }
  },
});
