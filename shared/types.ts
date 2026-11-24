/**
 * API DTOs shared by the server and the web client (CLAUDE.md: never duplicate
 * DTO shapes). Type-only imports keep this file free of runtime code, so both
 * sides can use it.
 */
import type { CanonicalTags } from "../server/tagio/types.ts";
import type {
  MatchMethod,
  ReleaseSummary as EditionSummary,
  SignalName,
  TrackMapping,
} from "../server/identify/types.ts";

export type { CanonicalTags, EditionSummary, MatchMethod, SignalName, TrackMapping };

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  checks: {
    /** The music root exists and is a readable directory. */
    musicRoot: boolean;
    /** The config directory is writable (database and snapshots live there). */
    configDir: boolean;
    /** The database answers queries. */
    database: boolean;
  };
}

export interface ApiError {
  error: string;
}

// ---- auth (§14.1)

export interface AuthState {
  /** No user exists yet: the UI shows first-run setup. */
  setupRequired: boolean;
  user: { username: string; isAdmin: boolean } | null;
  /** Send as the X-CSRF-Token header on every state-changing request. Null when signed out. */
  csrfToken: string | null;
}

export interface Credentials {
  username: string;
  password: string;
}

export const CSRF_HEADER = "X-CSRF-Token";

// ---- jobs

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobDto<P = unknown, R = unknown> {
  id: number;
  kind: string;
  state: JobState;
  progress: P | null;
  result: R | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface ScanProgressDto {
  phase: "walking" | "grouping" | "done";
  /** Audio files found so far. */
  seen: number;
  /** New or changed files whose tags were read. */
  read: number;
}

export interface ScanResultDto {
  seen: number;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  unreadable: number;
  skippedSymlinks: number;
  ignored: number;
  unreadableDirs: number;
  unitsRegrouped: number;
  candidatesTouched: number[];
  durationMs: number;
}

export type ScanJobDto = JobDto<ScanProgressDto, ScanResultDto>;

// ---- library browser (Phase 1, read-only)

export interface LibrarySummary {
  files: number;
  releases: number;
  /** Files that could not be read (shown with their error). */
  unreadable: number;
  readOnly: boolean;
  /** Most recent scan job, running or finished. */
  scan: ScanJobDto | null;
}

/** A release candidate (§6.1 `candidate`): files believed to form one release. */
export interface ReleaseSummary {
  id: number;
  /** Relative to the music root. */
  folder: string;
  artist: string | null;
  album: string | null;
  mbid: string | null;
  trackCount: number;
  formats: string[];
  status: string;
  errorCount: number;
  hasCover: boolean;
  updatedAt: number;
}

export interface ReleaseList {
  total: number;
  items: ReleaseSummary[];
}

export interface PictureInfo {
  type: string;
  mime: string;
  size: number;
}

export interface LibraryFileDto {
  id: number;
  /** Relative to the music root. */
  path: string;
  format: string | null;
  sizeBytes: number;
  durationMs: number | null;
  sampleRate: number | null;
  channels: number | null;
  bitrateKbps: number | null;
  tags: CanonicalTags;
  pictures: PictureInfo[];
  readError: string | null;
  scannedAt: number;
}

export interface ReleaseDetail {
  release: ReleaseSummary;
  files: LibraryFileDto[];
}

// ---- identification (§8, Phase 2)

export type CandidateStatus =
  | "new"
  | "changed"
  | "identifying"
  | "matched"
  | "needs_review"
  | "no_match"
  | "error";

/** A scored MusicBrainz release for a release candidate. */
export interface MatchDto {
  rank: number;
  releaseMbid: string;
  releaseGroupMbid: string | null;
  score: number;
  method: MatchMethod;
  /** null = no evidence for that signal; it was left out of the score (D36). */
  signals: Record<SignalName, number | null>;
  coverage: number;
  /** Held below the auto threshold for lack of evidence (D36). */
  capped: boolean;
  identifierMatch: boolean;
  /** The files name this release (MBID, barcode or catalog number) (D38). */
  pinned: boolean;
  summary: EditionSummary;
  mapping: TrackMapping;
}

/** One row of the edition picker (§8.2). */
export interface EditionDto {
  releaseMbid: string;
  summary: EditionSummary;
  /** Looked up and scored; unexamined editions come from the release group browse (D38). */
  examined: boolean;
  score: number | null;
}

export interface IdentificationDto {
  status: CandidateStatus;
  identifiedAt: number | null;
  error: string | null;
  /** The files changed since the last identification. */
  stale: boolean;
  /** Best first. */
  matches: MatchDto[];
  /** Releases of the best match's release group, best first; empty without a match. */
  editions: EditionDto[];
  thresholds: { auto: number; review: number };
  /** The latest identify job for this release, when one is queued or running. */
  job: JobDto | null;
}

/** POST /api/library/releases/:id/identify. Without a URL, identification runs automatically (§8). */
export interface IdentifyRequest {
  /** §8 order 5: a MusicBrainz release URL (or bare MBID) the user chose. */
  releaseUrl?: string;
}
