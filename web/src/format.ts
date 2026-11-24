import type { CandidateStatus, CanonicalTags, MatchMethod, SignalName } from "../../shared/types.ts";

export function duration(ms: number | null): string {
  if (ms === null) return "–";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function when(ms: number | null): string {
  return ms === null ? "–" : new Date(ms).toLocaleString();
}

/** Display form of a canonical tag value. */
export function tagValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.join("; ");
  if (typeof v === "object") {
    return Object.entries(v as Record<string, string[]>).map(([role, names]) => `${names.join(", ")} (${role})`).join(
      "; ",
    );
  }
  return String(v);
}

/** Label and badge style per release status (§8). */
export const STATUS: Record<CandidateStatus, { label: string; tone: "" | "ok" | "warn" | "error" }> = {
  new: { label: "not identified", tone: "" },
  changed: { label: "changed", tone: "" },
  identifying: { label: "identifying…", tone: "" },
  matched: { label: "matched", tone: "ok" },
  needs_review: { label: "needs review", tone: "warn" },
  no_match: { label: "no match", tone: "error" },
  error: { label: "error", tone: "error" },
};

export function statusOf(s: string): { label: string; tone: "" | "ok" | "warn" | "error" } {
  return STATUS[s as CandidateStatus] ?? { label: s, tone: "" };
}

export const SIGNAL_LABELS: Record<SignalName, string> = {
  trackCount: "Track count",
  durations: "Durations",
  titles: "Track titles",
  album: "Album title",
  artist: "Artist",
  fingerprint: "Fingerprints",
};

export const METHOD_LABELS: Record<MatchMethod, string> = {
  existing_mbid: "MusicBrainz ID in the tags",
  barcode: "barcode",
  catno: "catalog number",
  text: "text search",
  fingerprint: "AcoustID fingerprints",
  manual: "manual",
};

export function percent(v: number | null): string {
  return v === null ? "–" : `${Math.round(v * 100)}%`;
}

/** Release-level canonical fields (ARCHITECTURE.md §6.2): written to every track, so they should agree. */
export const RELEASE_FIELDS: (keyof CanonicalTags)[] = [
  "album",
  "albumartist",
  "albumartists",
  "albumartistsort",
  "date",
  "originaldate",
  "label",
  "catalognumber",
  "barcode",
  "media",
  "releasecountry",
  "releasestatus",
  "releasetype",
  "script",
  "language",
  "genre",
  "musicbrainz_albumid",
  "musicbrainz_releasegroupid",
  "musicbrainz_albumartistid",
  "discogs_release_id",
  "deezer_album_id",
];
