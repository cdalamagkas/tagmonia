/** Magic-byte check (ARCHITECTURE.md §7 step 2). Lives in tagio: only this module touches audio bytes. */
import type { AudioFormat } from "./types.ts";

/** Checks the file's magic bytes agree with its extension (§7 step 2). */
export async function sniffFormat(abs: string, format: AudioFormat): Promise<boolean> {
  const buf = new Uint8Array(12);
  let n = 0;
  using f = await Deno.open(abs, { read: true });
  while (n < buf.length) {
    const r = await f.read(buf.subarray(n));
    if (r === null) break;
    n += r;
  }
  const head = buf.subarray(0, n);
  const ascii = (from: number, s: string) =>
    head.length >= from + s.length && [...s].every((ch, i) => head[from + i] === ch.charCodeAt(0));
  switch (format) {
    case "flac":
      return ascii(0, "fLaC") || ascii(0, "ID3"); // some taggers prepend ID3 to FLAC
    case "ogg":
    case "opus":
      return ascii(0, "OggS");
    case "mp3":
      return ascii(0, "ID3") || (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
    case "m4a":
      return ascii(4, "ftyp");
  }
}
