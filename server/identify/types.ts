/** Inputs and outputs of identification (ARCHITECTURE.md §8), independent of the database and HTTP. */

export interface FileEvidence {
  fileId: number;
  /** Relative to the music root; used for title/position guesses on untagged files. */
  path: string;
  durationMs: number | null;
  title?: string;
  tracknumber?: number;
  discnumber?: number;
  /** Recording MBIDs AcoustID returned for this file's fingerprint (part 4). */
  acoustidRecordingIds?: string[];
}

export interface CandidateEvidence {
  files: FileEvidence[];
  album?: string;
  albumArtist?: string;
  barcode?: string;
  catalogNumbers?: string[];
  /** `musicbrainz_albumid` the files agree on, if any (§8 order 1). */
  albumMbid?: string;
}

export interface ReleaseTrack {
  medium: number;
  position: number;
  title: string;
  lengthMs: number | null;
  trackId: string;
  recordingId: string;
}

/** What the edition picker shows side by side (§8.2). */
export interface ReleaseSummary {
  title: string;
  artist: string;
  date: string | null;
  country: string | null;
  labels: string[];
  catalogNumbers: string[];
  barcode: string | null;
  /** e.g. "2×CD", "CD + DVD", "Digital Media". */
  format: string;
  trackCount: number;
  status: string | null;
}

export interface ReleaseView {
  id: string;
  releaseGroupId: string | null;
  summary: ReleaseSummary;
  tracks: ReleaseTrack[];
}

export type SignalName = "trackCount" | "durations" | "titles" | "album" | "artist" | "fingerprint";

export type Weights = Record<SignalName, number>;

export interface MappedPair {
  fileId: number;
  medium: number;
  position: number;
  trackId: string;
  recordingId: string;
  /** 0 = perfect, 1 = nothing in common. */
  cost: number;
}

export interface TrackMapping {
  pairs: MappedPair[];
  unmappedFiles: number[];
  unmatchedTracks: { medium: number; position: number; title: string }[];
}

export type MatchMethod = "existing_mbid" | "barcode" | "catno" | "text" | "fingerprint" | "manual";

export interface ScoredRelease {
  releaseId: string;
  releaseGroupId: string | null;
  score: number;
  /** null = signal unavailable for this candidate, excluded from the weighted mean. */
  signals: Record<SignalName, number | null>;
  /** Share of the total weight that had evidence. */
  coverage: number;
  /** Score was held below the auto threshold for lack of evidence (D36). */
  capped: boolean;
  /** Barcode or catalog number matched exactly. */
  identifierMatch: boolean;
  /** The files name this release: identifier match, or the MBID already in their tags (D38). */
  pinned?: boolean;
  mapping: TrackMapping;
  summary: ReleaseSummary;
}
