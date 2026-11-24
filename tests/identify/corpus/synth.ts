/**
 * Synthesises a library folder from a recorded MusicBrainz release, with one
 * kind of realistic damage (D33). Deterministic: the same case always yields
 * the same files, so the recorder and the accuracy test send identical queries.
 */
import type { StoredFile } from "../../../server/db/repo/library.ts";
import { creditString } from "../../../server/identify/release.ts";
import type { MbRelease } from "../../../server/providers/musicbrainz/schema.ts";
import type { CanonicalTags } from "../../../server/tagio/types.ts";

export const DAMAGE = [
  /** Full tags, durations within ±1.5 s (a clean rip). */
  "clean",
  /** Album title typo, artist without a leading "The". */
  "typo",
  /** No album artist or artist tags. */
  "no_artist",
  /** Files in random order, no track or disc numbers. */
  "shuffled",
  /** Last track missing (a rip without the bonus track). */
  "missing_last",
  /** An extra file not on the release (hidden track). */
  "extra_file",
  /** No tags; folder "Artist - Album (Year)", files "NN.flac". */
  "untagged_folder",
  /** No tags; folder "Album", files "NN - Title.flac". */
  "untagged_filenames",
  /** Durations off by up to ±4 s (lossy rips, different gaps). */
  "noisy_durations",
  /** Clean tags plus the release MBID (a previously tagged album). */
  "existing_mbid",
  /** Clean tags plus the barcode. */
  "barcode",
  /** No tags, folder "Unknown", files "trackNN.flac": unidentifiable without fingerprints (D34). */
  "unidentifiable",
] as const;

export type Damage = typeof DAMAGE[number];

export interface SynthCase {
  slug: string;
  damage: Damage;
}

export interface SynthFolder {
  folder: string;
  files: StoredFile[];
}

/** mulberry32, seeded from the slug: small, fast and reproducible. */
export function rng(seed: string): () => number {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.codePointAt(0)!, 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function typo(s: string, rand: () => number): string {
  const chars = [...s];
  const letters = chars.map((c, i) => (/\p{L}/u.test(c) ? i : -1)).filter((i) => i > 0);
  if (letters.length < 4) return s;
  // Swap two adjacent letters: the most common real-world misspelling.
  const i = letters[Math.floor(rand() * (letters.length - 1))];
  if (i + 1 < chars.length && /\p{L}/u.test(chars[i + 1])) [chars[i], chars[i + 1]] = [chars[i + 1], chars[i]];
  return chars.join("");
}

function safeName(s: string): string {
  return s.replace(/[/\\:*?"<>|]/g, "_").trim();
}

export function synthesize(release: MbRelease, c: SynthCase): SynthFolder {
  const rand = rng(c.slug);
  const jitter = (max: number) => Math.round((rand() * 2 - 1) * max);
  const albumArtist = creditString(release["artist-credit"]);
  const year = release.date?.slice(0, 4);
  const multiDisc = release.media.length > 1;
  const untagged = c.damage === "untagged_folder" || c.damage === "untagged_filenames" ||
    c.damage === "unidentifiable";

  const folder = c.damage === "untagged_folder"
    ? safeName(`${albumArtist} - ${release.title}${year ? ` (${year})` : ""} [FLAC]`)
    : c.damage === "unidentifiable"
    ? "Unknown"
    : safeName(release.title);

  let files: StoredFile[] = [];
  let id = 1;
  for (const m of release.media) {
    for (const t of m.tracks ?? []) {
      const n = String(t.position).padStart(2, "0");
      const disc = multiDisc ? `${m.position}-` : "";
      const name = c.damage === "untagged_filenames"
        ? `${disc}${n} - ${safeName(t.title)}.flac`
        : c.damage === "unidentifiable"
        ? `track${String(id).padStart(2, "0")}.flac`
        : `${disc}${n}.flac`;
      const length = t.length ?? t.recording.length ?? 180_000;
      const durationMs = Math.max(1000, length + jitter(c.damage === "noisy_durations" ? 4000 : 1500));
      const tags: CanonicalTags = untagged ? {} : {
        title: t.title,
        artist: creditString(t["artist-credit"] ?? release["artist-credit"]),
        album: release.title,
        albumartist: albumArtist,
        tracknumber: t.position,
        totaltracks: m["track-count"],
        discnumber: m.position,
        totaldiscs: release.media.length,
      };
      if (c.damage === "typo") {
        tags.album = typo(release.title, rand);
        tags.albumartist = albumArtist.replace(/^The /, "");
      }
      if (c.damage === "no_artist") delete tags.albumartist, delete tags.artist;
      if (c.damage === "shuffled") delete tags.tracknumber, delete tags.discnumber;
      if (c.damage === "existing_mbid") tags.musicbrainz_albumid = release.id;
      if (c.damage === "barcode" && release.barcode) tags.barcode = release.barcode;
      files.push(storedFile(id++, `${folder}/${name}`, folder, durationMs, tags));
    }
  }

  if (c.damage === "missing_last") files = files.slice(0, -1);
  if (c.damage === "extra_file") {
    files.push(
      storedFile(id++, `${folder}/99.flac`, folder, 60_000 + Math.round(rand() * 120_000), {
        title: "Hidden Track",
        album: release.title,
        albumartist: albumArtist,
        tracknumber: 99,
      }),
    );
  }
  if (c.damage === "shuffled") {
    for (let i = files.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [files[i], files[j]] = [files[j], files[i]];
    }
  }
  return { folder, files };
}

function storedFile(id: number, path: string, folder: string, durationMs: number, tags: CanonicalTags): StoredFile {
  return {
    id,
    path,
    folder,
    size: 1,
    mtimeMs: 1,
    format: "flac",
    durationMs,
    sampleRate: 44100,
    channels: 2,
    bitrateKbps: 900,
    tags,
    pictures: [],
    readError: null,
    scannedAt: 1,
    candidateId: 1,
  };
}
