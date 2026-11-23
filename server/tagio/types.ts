/**
 * TagIO: the only boundary through which Tagmonia reads or writes audio tags
 * (ARCHITECTURE.md §6.2, §11.1). Field names follow Picard's internal tag names.
 */

/** Multi-valued fields are always arrays, never joined strings. */
export type Multi = string[];

export interface CanonicalTags {
  // track-level
  title?: string;
  /** Display credit, e.g. "Alice feat. Bob". */
  artist?: string;
  /** Individual artist names. */
  artists?: Multi;
  artistsort?: string;
  tracknumber?: number;
  totaltracks?: number;
  discnumber?: number;
  totaldiscs?: number;
  isrc?: Multi;
  composer?: Multi;
  lyricist?: Multi;
  conductor?: Multi;
  /** Role (lowercase) -> names. Not stored in MP4, as in Picard (D9). */
  performer?: Record<string, Multi>;
  work?: string;
  musicbrainz_recordingid?: string;
  /** Release-track MBID (Picard's naming; Vorbis MUSICBRAINZ_RELEASETRACKID). */
  musicbrainz_trackid?: string;
  musicbrainz_artistid?: Multi;
  musicbrainz_workid?: Multi;
  acoustid_id?: string;

  // release-level (written to every track of the release)
  album?: string;
  albumartist?: string;
  albumartists?: Multi;
  albumartistsort?: string;
  /** YYYY, YYYY-MM or YYYY-MM-DD */
  date?: string;
  originaldate?: string;
  label?: Multi;
  catalognumber?: Multi;
  barcode?: string;
  media?: string;
  releasecountry?: string;
  releasestatus?: string;
  releasetype?: Multi;
  script?: string;
  language?: string;
  genre?: Multi;
  musicbrainz_albumid?: string;
  musicbrainz_releasegroupid?: string;
  musicbrainz_albumartistid?: Multi;

  // provider IDs (custom tags, §11.2)
  discogs_release_id?: string;
  deezer_album_id?: string;
}

export type CanonicalField = keyof CanonicalTags;

export type PictureType = "front" | "back" | "other";

export interface Picture {
  type: PictureType;
  /**
   * Usually image/jpeg or image/png. Other image types found in files are kept
   * so backups restore them exactly; new pictures Tagmonia writes are JPEG/PNG (D11).
   */
  mime: string;
  /** Empty when read with `pictureData: false`; `size` still reports the stored length. */
  data: Uint8Array;
  /** Byte length of the stored image; set on read. */
  size?: number;
  description?: string;
}

export type AudioFormat = "flac" | "ogg" | "opus" | "mp3" | "m4a";

export interface AudioProps {
  format: AudioFormat;
  durationMs: number;
  sampleRate?: number;
  channels?: number;
  bitrateKbps?: number;
}

/**
 * Format-native key/value dump, for diagnostics and the review UI's "raw tags"
 * view. Keys are the implementation's native names; binary values are omitted.
 */
export type RawTagDump = Record<string, string[]>;

export interface ReadResult {
  tags: CanonicalTags;
  pictures: Picture[];
  audio: AudioProps;
  raw: RawTagDump;
}

export interface TagChange {
  /** Fields to set. Arrays replace wholesale. */
  set: Partial<CanonicalTags>;
  /** Fields to delete. */
  remove: CanonicalField[];
  /** Replace all pictures when present. */
  pictures?: Picture[];
}

export interface ReadOptions {
  /** Default true. False returns picture metadata (type, mime, size) without the image bytes. */
  pictureData?: boolean;
}

export interface TagIO {
  /** Absolute path; callers resolve and confine paths to the music root first. */
  read(path: string, options?: ReadOptions): Promise<ReadResult>;
  /** Must be atomic (temp file in the same dir, fsync, rename) and never re-encode audio. */
  write(path: string, change: TagChange): Promise<void>;
  /** Releases resources (child processes, wasm instances). */
  close?(): Promise<void>;
}

export class TagIOError extends Error {
  constructor(message: string, readonly path?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TagIOError";
  }
}
