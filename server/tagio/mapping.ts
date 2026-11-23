/**
 * Canonical field -> per-format native keys (ARCHITECTURE.md §11.2).
 *
 * Authority: Picard's tag mapping table
 * (https://picard-docs.musicbrainz.org/en/appendices/tag_mapping.html), an
 * extract of which is committed at tests/fixtures/picard_tag_map.tsv and
 * checked against this table by tests/tagio/mapping.test.ts. Rows with
 * `picard: null` are Tagmonia additions; see the Decision log (D8-D10).
 */
import type { CanonicalField } from "./types.ts";

export const MP4_FREEFORM = "----:com.apple.iTunes:";
const ff = (name: string) => MP4_FREEFORM + name;

export type FieldKind =
  /** single string */
  | "text"
  /** string list */
  | "multi"
  /** integer; for ID3/MP4 packed into a pair frame/atom (TRCK, TPOS, trkn, disk) */
  | "int"
  /** role -> names map */
  | "performer";

export interface FieldMapping {
  field: CanonicalField;
  kind: FieldKind;
  /** Picard internal name, or null when Picard does not define the tag. */
  picard: string | null;
  /** Frame id, `TXXX:<desc>` or `UFID:<owner>`. */
  id3: string;
  /** First key is canonical for reading; every key is written (Picard writes both TRACKTOTAL and TOTALTRACKS). */
  vorbis: string[];
  /** Atom name or freeform `----:mean:name`; null = not stored in MP4. */
  mp4: string | null;
  /** For pair-packed ints: which half of `n/total`. */
  pair?: { group: "track" | "disc"; index: 0 | 1 };
}

export const FIELD_MAPPINGS: readonly FieldMapping[] = [
  { field: "title", kind: "text", picard: "title", id3: "TIT2", vorbis: ["TITLE"], mp4: "©nam" },
  { field: "artist", kind: "text", picard: "artist", id3: "TPE1", vorbis: ["ARTIST"], mp4: "©ART" },
  { field: "artists", kind: "multi", picard: "artists", id3: "TXXX:ARTISTS", vorbis: ["ARTISTS"], mp4: ff("ARTISTS") },
  { field: "artistsort", kind: "text", picard: "artistsort", id3: "TSOP", vorbis: ["ARTISTSORT"], mp4: "soar" },
  {
    field: "tracknumber",
    kind: "int",
    picard: "tracknumber",
    id3: "TRCK",
    vorbis: ["TRACKNUMBER"],
    mp4: "trkn",
    pair: { group: "track", index: 0 },
  },
  {
    field: "totaltracks",
    kind: "int",
    picard: "totaltracks",
    id3: "TRCK",
    vorbis: ["TRACKTOTAL", "TOTALTRACKS"],
    mp4: "trkn",
    pair: { group: "track", index: 1 },
  },
  {
    field: "discnumber",
    kind: "int",
    picard: "discnumber",
    id3: "TPOS",
    vorbis: ["DISCNUMBER"],
    mp4: "disk",
    pair: { group: "disc", index: 0 },
  },
  {
    field: "totaldiscs",
    kind: "int",
    picard: "totaldiscs",
    id3: "TPOS",
    vorbis: ["DISCTOTAL", "TOTALDISCS"],
    mp4: "disk",
    pair: { group: "disc", index: 1 },
  },
  { field: "isrc", kind: "multi", picard: "isrc", id3: "TSRC", vorbis: ["ISRC"], mp4: ff("ISRC") },
  { field: "composer", kind: "multi", picard: "composer", id3: "TCOM", vorbis: ["COMPOSER"], mp4: "©wrt" },
  { field: "lyricist", kind: "multi", picard: "lyricist", id3: "TEXT", vorbis: ["LYRICIST"], mp4: ff("LYRICIST") },
  { field: "conductor", kind: "multi", picard: "conductor", id3: "TPE3", vorbis: ["CONDUCTOR"], mp4: ff("CONDUCTOR") },
  // Picard: ID3v2.4 TMCL:<instrument>, Vorbis "PERFORMER=<name> (<instrument>)", not written to MP4.
  {
    field: "performer",
    kind: "performer",
    picard: "performer:instrument",
    id3: "TMCL",
    vorbis: ["PERFORMER"],
    mp4: null,
  },
  // Picard writes TXXX:WORK unless its iTunes-compatibility option is on.
  { field: "work", kind: "text", picard: "work", id3: "TXXX:WORK", vorbis: ["WORK"], mp4: "©wrk" },
  {
    field: "musicbrainz_recordingid",
    kind: "text",
    picard: "musicbrainz_recordingid",
    id3: "UFID:http://musicbrainz.org",
    vorbis: ["MUSICBRAINZ_TRACKID"],
    mp4: ff("MusicBrainz Track Id"),
  },
  {
    field: "musicbrainz_trackid",
    kind: "text",
    picard: "musicbrainz_trackid",
    id3: "TXXX:MusicBrainz Release Track Id",
    vorbis: ["MUSICBRAINZ_RELEASETRACKID"],
    mp4: ff("MusicBrainz Release Track Id"),
  },
  {
    field: "musicbrainz_artistid",
    kind: "multi",
    picard: "musicbrainz_artistid",
    id3: "TXXX:MusicBrainz Artist Id",
    vorbis: ["MUSICBRAINZ_ARTISTID"],
    mp4: ff("MusicBrainz Artist Id"),
  },
  {
    field: "musicbrainz_workid",
    kind: "multi",
    picard: "musicbrainz_workid",
    id3: "TXXX:MusicBrainz Work Id",
    vorbis: ["MUSICBRAINZ_WORKID"],
    mp4: ff("MusicBrainz Work Id"),
  },
  {
    field: "acoustid_id",
    kind: "text",
    picard: "acoustid_id",
    id3: "TXXX:Acoustid Id",
    vorbis: ["ACOUSTID_ID"],
    mp4: ff("Acoustid Id"),
  },
  { field: "album", kind: "text", picard: "album", id3: "TALB", vorbis: ["ALBUM"], mp4: "©alb" },
  { field: "albumartist", kind: "text", picard: "albumartist", id3: "TPE2", vorbis: ["ALBUMARTIST"], mp4: "aART" },
  // Not in Picard's table; same convention as ARTISTS, which Navidrome and Jellyfin read (D8).
  {
    field: "albumartists",
    kind: "multi",
    picard: null,
    id3: "TXXX:ALBUMARTISTS",
    vorbis: ["ALBUMARTISTS"],
    mp4: ff("ALBUMARTISTS"),
  },
  {
    field: "albumartistsort",
    kind: "text",
    picard: "albumartistsort",
    id3: "TSO2",
    vorbis: ["ALBUMARTISTSORT"],
    mp4: "soaa",
  },
  { field: "date", kind: "text", picard: "date", id3: "TDRC", vorbis: ["DATE"], mp4: "©day" },
  // Picard's table says n/a for MP4, but Picard writes unmapped tags as a
  // freeform atom named after the internal name (formats/mp4.py), so we do too (D9).
  {
    field: "originaldate",
    kind: "text",
    picard: "originaldate",
    id3: "TDOR",
    vorbis: ["ORIGINALDATE"],
    mp4: ff("originaldate"),
  },
  { field: "label", kind: "multi", picard: "label", id3: "TPUB", vorbis: ["LABEL"], mp4: ff("LABEL") },
  {
    field: "catalognumber",
    kind: "multi",
    picard: "catalognumber",
    id3: "TXXX:CATALOGNUMBER",
    vorbis: ["CATALOGNUMBER"],
    mp4: ff("CATALOGNUMBER"),
  },
  { field: "barcode", kind: "text", picard: "barcode", id3: "TXXX:BARCODE", vorbis: ["BARCODE"], mp4: ff("BARCODE") },
  { field: "media", kind: "text", picard: "media", id3: "TMED", vorbis: ["MEDIA"], mp4: ff("MEDIA") },
  {
    field: "releasecountry",
    kind: "text",
    picard: "releasecountry",
    id3: "TXXX:MusicBrainz Album Release Country",
    vorbis: ["RELEASECOUNTRY"],
    mp4: ff("MusicBrainz Album Release Country"),
  },
  {
    field: "releasestatus",
    kind: "text",
    picard: "releasestatus",
    id3: "TXXX:MusicBrainz Album Status",
    vorbis: ["RELEASESTATUS"],
    mp4: ff("MusicBrainz Album Status"),
  },
  {
    field: "releasetype",
    kind: "multi",
    picard: "releasetype",
    id3: "TXXX:MusicBrainz Album Type",
    vorbis: ["RELEASETYPE"],
    mp4: ff("MusicBrainz Album Type"),
  },
  { field: "script", kind: "text", picard: "script", id3: "TXXX:SCRIPT", vorbis: ["SCRIPT"], mp4: ff("SCRIPT") },
  { field: "language", kind: "text", picard: "language", id3: "TLAN", vorbis: ["LANGUAGE"], mp4: ff("LANGUAGE") },
  { field: "genre", kind: "multi", picard: "genre", id3: "TCON", vorbis: ["GENRE"], mp4: "©gen" },
  {
    field: "musicbrainz_albumid",
    kind: "text",
    picard: "musicbrainz_albumid",
    id3: "TXXX:MusicBrainz Album Id",
    vorbis: ["MUSICBRAINZ_ALBUMID"],
    mp4: ff("MusicBrainz Album Id"),
  },
  {
    field: "musicbrainz_releasegroupid",
    kind: "text",
    picard: "musicbrainz_releasegroupid",
    id3: "TXXX:MusicBrainz Release Group Id",
    vorbis: ["MUSICBRAINZ_RELEASEGROUPID"],
    mp4: ff("MusicBrainz Release Group Id"),
  },
  {
    field: "musicbrainz_albumartistid",
    kind: "multi",
    picard: "musicbrainz_albumartistid",
    id3: "TXXX:MusicBrainz Album Artist Id",
    vorbis: ["MUSICBRAINZ_ALBUMARTISTID"],
    mp4: ff("MusicBrainz Album Artist Id"),
  },
  // Provider IDs: Tagmonia custom tags (§11.2).
  {
    field: "discogs_release_id",
    kind: "text",
    picard: null,
    id3: "TXXX:DISCOGS_RELEASE_ID",
    vorbis: ["DISCOGS_RELEASE_ID"],
    mp4: ff("DISCOGS_RELEASE_ID"),
  },
  {
    field: "deezer_album_id",
    kind: "text",
    picard: null,
    id3: "TXXX:DEEZER_ALBUM_ID",
    vorbis: ["DEEZER_ALBUM_ID"],
    mp4: ff("DEEZER_ALBUM_ID"),
  },
];

export const MAPPING_BY_FIELD: ReadonlyMap<CanonicalField, FieldMapping> = new Map(
  FIELD_MAPPINGS.map((m) => [m.field, m]),
);

/** Picard's Vorbis performer value format: "Name (role)". */
export function formatVorbisPerformer(name: string, role: string): string {
  return `${name} (${role})`;
}

export function parseVorbisPerformer(value: string): { name: string; role: string } {
  const m = /^(.*\S)\s+\(([^()]+)\)$/.exec(value.trim());
  return m ? { name: m[1], role: m[2].toLowerCase() } : { name: value.trim(), role: "" };
}
