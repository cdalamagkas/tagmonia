/**
 * Text normalisation and similarity for matching (ARCHITECTURE.md §8.1).
 * Pure functions only; they are tuned on the labelled fixtures in tests/identify/.
 */

/** Edition and version noise that differs between a file's tags and MusicBrainz. */
const NOISE =
  /[([](?:[^)\]]*\b(?:remaster(?:ed)?|deluxe|expanded|edition|bonus|anniversary|version|mono|stereo)\b[^)\]]*)[)\]]/gi;

/**
 * Lowercase, strip diacritics and punctuation, unify "&"/"and", collapse spaces.
 * Non-Latin scripts are kept: "Μίκης" and "坂本龍一" must still compare equal to themselves.
 */
export function normalizeText(s: string, opts: { dropNoise?: boolean } = {}): string {
  let t = s.normalize("NFKD").replace(/\p{M}/gu, "");
  if (opts.dropNoise) t = t.replace(NOISE, " ");
  return t
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/&|\+/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function levenshtein(a: string[], b: string[]): number {
  if (a.length < b.length) [a, b] = [b, a];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 1 - edit distance / longer length, on code points (so CJK counts per character). */
export function editRatio(a: string, b: string): number {
  const x = [...a], y = [...b];
  const n = Math.max(x.length, y.length);
  return n === 0 ? 1 : 1 - levenshtein(x, y) / n;
}

/** Share of the shorter title's words found in the longer one: tolerant of extra subtitles. */
function tokenContainment(a: string, b: string): number {
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let hit = 0;
  for (const t of small) if (big.has(t)) hit++;
  // Damp containment so "Live" vs "Live at Wembley" is not a perfect match.
  return (hit / small.size) * (0.6 + 0.4 * (small.size / big.size));
}

/** Similarity in [0, 1] after normalisation; edition noise in brackets is ignored. */
export function similarity(a: string | undefined | null, b: string | undefined | null): number {
  if (!a || !b) return 0;
  const x = normalizeText(a, { dropNoise: true }) || normalizeText(a);
  const y = normalizeText(b, { dropNoise: true }) || normalizeText(b);
  if (x === y) return 1;
  return Math.max(editRatio(x, y), tokenContainment(x, y));
}

/**
 * A title guess from a file name such as "03 - Song Name.flac" or "1-03 Song.mp3",
 * for untagged files. Returns undefined when nothing title-like remains.
 */
export function titleFromPath(path: string): string | undefined {
  const base = path.split("/").pop()!.replace(/\.[^.]+$/, "");
  const t = base.replace(/^\s*(?:\d+\s*[-._]\s*)?\d+\s*[-._)\]]*\s*/, "").replace(/_/g, " ").trim();
  return /\p{L}/u.test(t) ? t : undefined;
}

/** Leading track number in a file name ("03 - x", "1-03 x"), for untagged files. */
export function positionFromPath(path: string): { disc?: number; track?: number } {
  const base = path.split("/").pop()!;
  const two = /^\s*(\d{1,2})\s*[-.]\s*(\d{1,3})\b/.exec(base);
  if (two) return { disc: Number(two[1]), track: Number(two[2]) };
  const one = /^\s*(\d{1,3})\b/.exec(base);
  return one ? { track: Number(one[1]) } : {};
}
