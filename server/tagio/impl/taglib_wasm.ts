/**
 * TagIO spike implementation on taglib-wasm (§11.4 option A).
 *
 * NOT the default. Kept so the conformance suite can be re-run against it
 * (`TAGMONY_TAGIO_IMPL=taglib-wasm deno task test:tagio`) when taglib-wasm
 * changes; see Decision log D7 for the failures that ruled it out.
 */
import { PROPERTIES, TagLib } from "taglib-wasm";
import { atomicModify } from "../atomic.ts";
import { FIELD_MAPPINGS, formatVorbisPerformer, parseVorbisPerformer } from "../mapping.ts";
import type { AudioFormat, CanonicalTags, Picture, ReadResult, TagChange, TagIO } from "../types.ts";

type PropMap = Record<string, string[]>;

const CAMEL_TO_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(PROPERTIES).map(([camel, meta]) => [camel, (meta as { key: string }).key]),
);

const FORMAT: Record<string, AudioFormat> = {
  FLAC: "flac",
  OGG: "ogg",
  OPUS: "opus",
  MP3: "mp3",
  MP4: "m4a",
  M4A: "m4a",
};

const PIC_IN: Record<string, Picture["type"]> = { FrontCover: "front", BackCover: "back" };
const PIC_OUT: Record<Picture["type"], string> = { front: "FrontCover", back: "BackCover", other: "Other" };

function normalise(props: Record<string, string[] | undefined>): PropMap {
  const out: PropMap = {};
  for (const [k, v] of Object.entries(props)) if (v) out[CAMEL_TO_KEY[k] ?? k.toUpperCase()] = v;
  return out;
}

function splitPair(v: string | undefined): [number | undefined, number | undefined] {
  if (!v) return [undefined, undefined];
  const [a, b] = v.split("/");
  const n = parseInt(a, 10);
  const t = b === undefined ? NaN : parseInt(b, 10);
  return [isNaN(n) ? undefined : n, isNaN(t) ? undefined : t];
}

function toCanonical(p: PropMap, fmt: AudioFormat): CanonicalTags {
  const out: Record<string, unknown> = {};
  const vorbis = fmt === "flac" || fmt === "ogg" || fmt === "opus";
  for (const m of FIELD_MAPPINGS) {
    if (m.kind === "performer") {
      const perf: Record<string, string[]> = {};
      if (vorbis) {
        for (const v of p.PERFORMER ?? []) {
          const { name, role } = parseVorbisPerformer(v);
          (perf[role] ??= []).push(name);
        }
      } else {
        for (const [k, v] of Object.entries(p)) {
          if (k.startsWith("PERFORMER:")) perf[k.slice(10).toLowerCase()] = v;
        }
      }
      if (Object.keys(perf).length) out[m.field] = perf;
      continue;
    }
    if (m.pair) {
      const numKey = m.pair.group === "track" ? "TRACKNUMBER" : "DISCNUMBER";
      const totKey = m.pair.group === "track" ? "TRACKTOTAL" : "DISCTOTAL";
      const [n, t] = splitPair(p[numKey]?.[0]);
      const v = m.pair.index === 0 ? n : (p[totKey] ? parseInt(p[totKey][0], 10) : t);
      if (v !== undefined && !isNaN(v)) out[m.field] = v;
      continue;
    }
    const vals = p[m.vorbis[0]];
    if (!vals?.length) continue;
    out[m.field] = m.kind === "multi" ? vals : m.kind === "int" ? parseInt(vals[0], 10) : vals[0];
  }
  return out as CanonicalTags;
}

export class TaglibWasmTagIO implements TagIO {
  #tl?: Promise<TagLib>;

  #lib(): Promise<TagLib> {
    return this.#tl ??= TagLib.initialize();
  }

  async read(path: string): Promise<ReadResult> {
    const tl = await this.#lib();
    using f = await tl.open(await Deno.readFile(path));
    const format = FORMAT[f.getFormat()] ?? "flac";
    const props = normalise(f.properties());
    const ap = f.audioProperties();
    return {
      tags: toCanonical(props, format),
      pictures: f.getPictures().map((pic) => ({
        type: PIC_IN[String(pic.type)] ?? "other",
        mime: pic.mimeType,
        data: pic.data,
        description: pic.description ?? "",
      })),
      audio: {
        format,
        durationMs: Math.round((ap?.duration ?? 0) * 1000),
        sampleRate: ap?.sampleRate,
        channels: ap?.channels,
        bitrateKbps: ap?.bitrate,
      },
      raw: props,
    };
  }

  async write(path: string, change: TagChange): Promise<void> {
    const tl = await this.#lib();
    await atomicModify(path, async (tmp) => {
      using f = await tl.open(await Deno.readFile(tmp));
      const format = FORMAT[f.getFormat()] ?? "flac";
      const vorbis = format === "flac" || format === "ogg" || format === "opus";
      const props = normalise(f.properties());
      const current = toCanonical(props, format);
      const merged: Record<string, unknown> = { ...current, ...change.set };
      for (const r of change.remove) delete merged[r];
      for (const m of FIELD_MAPPINGS) {
        if (!(m.field in change.set) && !change.remove.includes(m.field)) continue;
        const v = merged[m.field];
        if (m.kind === "performer") {
          for (const k of Object.keys(props)) if (k === "PERFORMER" || k.startsWith("PERFORMER:")) delete props[k];
          if (format === "m4a" || !v) continue;
          for (const [role, names] of Object.entries(v as Record<string, string[]>)) {
            if (vorbis) (props.PERFORMER ??= []).push(...names.map((n) => formatVorbisPerformer(n, role)));
            else props[`PERFORMER:${role.toUpperCase()}`] = names;
          }
          continue;
        }
        if (m.pair) continue;
        if (v === undefined) delete props[m.vorbis[0]];
        else props[m.vorbis[0]] = Array.isArray(v) ? v.map(String) : [String(v)];
      }
      for (const group of ["track", "disc"] as const) {
        const [nf, tf] = group === "track" ? ["tracknumber", "totaltracks"] : ["discnumber", "totaldiscs"];
        const touched = [nf, tf].some((f) => f in change.set || change.remove.includes(f as never));
        if (!touched) continue;
        const [nk, tk] = group === "track" ? ["TRACKNUMBER", "TRACKTOTAL"] : ["DISCNUMBER", "DISCTOTAL"];
        const n = merged[nf] as number | undefined;
        const t = merged[tf] as number | undefined;
        const alias = group === "track" ? "TOTALTRACKS" : "TOTALDISCS";
        delete props[nk];
        delete props[tk];
        delete props[alias];
        if (vorbis) {
          if (n !== undefined) props[nk] = [String(n)];
          if (t !== undefined) props[tk] = props[alias] = [String(t)];
        } else if (n !== undefined) {
          props[nk] = [t !== undefined ? `${n}/${t}` : String(n)];
        }
      }
      f.setProperties(props);
      if (change.pictures) {
        f.setPictures(change.pictures.map((pic) => ({
          mimeType: pic.mime,
          data: pic.data,
          type: PIC_OUT[pic.type],
          description: pic.description,
        })) as never);
      }
      if (!f.save()) throw new Error("taglib save failed");
      await Deno.writeFile(tmp, f.getFileBuffer());
    });
  }
}
