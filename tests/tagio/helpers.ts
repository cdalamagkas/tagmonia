import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTagIO, type TagIO, type TagIOImpl } from "../../server/tagio/mod.ts";
import type { AudioFormat, CanonicalTags, Picture } from "../../server/tagio/types.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
export const AUDIO_DIR = join(here, "../fixtures/audio");
export const FORMATS: AudioFormat[] = ["flac", "ogg", "opus", "mp3", "m4a"];
export const VORBIS_FORMATS: AudioFormat[] = ["flac", "ogg", "opus"];

export const FIXTURE_TAGS: CanonicalTags = JSON.parse(
  await Deno.readTextFile(join(here, "../fixtures/fixture_tags.json")),
);

export const IMPL = (Deno.env.get("TAGMONIA_TAGIO_IMPL") ?? "mutagen") as TagIOImpl;

export function newTagIO(): Promise<TagIO> {
  return createTagIO(IMPL);
}

export async function fixturesPresent(): Promise<boolean> {
  try {
    await Deno.stat(join(AUDIO_DIR, "tagged.flac"));
    return true;
  } catch {
    return false;
  }
}

/** Tests only ever touch copies in a fresh temp dir (CLAUDE.md safety rule 1). */
export async function copyFixture(name: string): Promise<{ path: string; dir: string }> {
  const dir = await Deno.makeTempDir({ prefix: "tagmonia-tagio-" });
  const path = join(dir, name);
  await Deno.copyFile(join(AUDIO_DIR, name), path);
  return { path, dir };
}

export async function sha256(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function fixturePictures(): Promise<Picture[]> {
  return [
    {
      type: "front",
      mime: "image/png",
      data: await Deno.readFile(join(AUDIO_DIR, "cover-front.png")),
      description: "front",
    },
    {
      type: "back",
      mime: "image/jpeg",
      data: await Deno.readFile(join(AUDIO_DIR, "cover-back.jpg")),
      description: "back",
    },
  ];
}

// ---- independent raw inspection (tests/tagio/raw_inspect.py, mutagen + byte-level MP4 walk)

export interface RawPicture {
  via: string;
  type: number;
  mime: string;
  desc: string;
  size: number;
  sha: string;
}
export interface RawVorbis {
  kind: "vorbis";
  comments: [string, string][];
  pictures: RawPicture[];
}
export interface RawId3Frame {
  id: string;
  hash: string;
  desc?: string;
  text?: string[];
  owner?: string;
  data?: string;
  people?: [string, string][];
  type?: number;
  mime?: string;
  size?: number;
}
export interface RawId3 {
  kind: "id3";
  version: number[];
  frames: RawId3Frame[];
}
export interface RawMp4 {
  kind: "mp4";
  items: { key: string; values: unknown[] }[];
}
export type RawDump = RawVorbis | RawId3 | RawMp4;

export async function rawInspect(path: string): Promise<RawDump> {
  const out = await new Deno.Command("python3", {
    args: ["-I", join(here, "raw_inspect.py"), path],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) throw new Error(`raw_inspect failed: ${new TextDecoder().decode(out.stderr)}`);
  return JSON.parse(new TextDecoder().decode(out.stdout));
}

export async function listDir(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) names.push(e.name);
  return names.sort();
}
