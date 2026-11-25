/**
 * API DTOs shared by the server and the web client (CLAUDE.md: never duplicate
 * DTO shapes). Type-only imports keep this file free of runtime code, so both
 * sides can use it.
 */
import type { CanonicalTags } from "../server/tagio/types.ts";
import type { Settings } from "../server/settings.ts";
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
  /** The music server told to rescan after writes (§13); null when none is configured. */
  musicServer: MusicServerStatus | null;
}

export interface MusicServerStatus {
  name: "jellyfin";
  /** Library refreshed after writes; null = all libraries. */
  library: string | null;
  /** Latest refresh request, queued, running or finished. */
  lastRefresh: JobDto | null;
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

// ---- proposals (§10, Phase 3)

export type ProposalState = "draft" | "needs_review" | "approved" | "written" | "discarded";
export type FieldStatus = "unchanged" | "changed" | "added";
export type FieldDecision = "auto" | "accepted" | "edited" | "kept_current";

export interface FieldSourceDto {
  provider: string;
  value: unknown;
  agreesWithProposed: boolean;
}

/** One canonical field of one file: what it holds now and what the sources propose. */
export interface FieldProposalDto {
  id: number;
  fileId: number;
  field: keyof CanonicalTags;
  current: unknown;
  proposed: unknown;
  /** The user's own value when decision is "edited". */
  edited: unknown;
  status: FieldStatus;
  decision: FieldDecision;
  locked: boolean;
  sources: FieldSourceDto[];
  /** Whose value is proposed: not "musicbrainz" means filled by a fallback provider (D48). */
  origin: string;
  /** The sources disagree; until decided (decision not "auto"), the write is refused. */
  conflict: boolean;
  /** The source the user picked to settle the field, if any. */
  resolvedFrom: string | null;
}

export interface ProposalDto {
  id: number;
  releaseMbid: string | null;
  state: ProposalState;
  /** "auto" when identification was confident, "user" when picked in the UI. */
  chosenBy: "auto" | "user";
  createdAt: number;
  /** The files changed since the proposal was built. */
  stale: boolean;
  /** filled: rows whose value comes from a fallback provider; conflicts: rows still waiting for a decision. */
  counts: { changed: number; added: number; unchanged: number; locked: number; filled: number; conflicts: number };
  /** Files with no track on the release; they are left untouched. */
  unmappedFiles: number[];
  fields: FieldProposalDto[];
  /** The same release on Deezer, iTunes and Discogs (D47). */
  providers: ProviderMatchDto[];
  /** The proposed front cover (D49); null for a proposal built before cover art existed. */
  cover: CoverProposalDto | null;
}

export type CoverSourceId = "coverartarchive" | "itunes" | "deezer" | "discogs";
export type CoverStatusDto = "added" | "changed" | "unchanged";

export interface CoverImageDto {
  mime: string;
  width: number;
  height: number;
  /** Bytes. */
  size: number;
  /** Where it was downloaded from. */
  url: string;
  /** Same-origin preview: GET /api/proposals/:id/cover/embed or …/folder. */
  preview: string;
}

export interface CoverProposalDto {
  mode: Settings["covers"]["mode"];
  /** null: no source had a cover. */
  source: CoverSourceId | null;
  skipped: { source: CoverSourceId; reason: string }[];
  embed: CoverImageDto | null;
  folder: CoverImageDto | null;
  embedStatus: CoverStatusDto | null;
  folderStatus: CoverStatusDto | null;
  folderPath: string | null;
  decision: "auto" | "accepted" | "kept_current";
  /** The release's files now: how many there are and how many have a front cover, with its sizes in bytes. */
  current: { files: number; withFront: number; sizes: number[] };
  /** Whether writing changes anything about the cover. */
  writes: boolean;
}

/** GET /api/library/releases/:id/cover/info: the cover the release has now (D50). */
export interface CurrentCoverDto {
  /** Embedded in the first track that has a picture, or an image file in the album folder. */
  kind: "embedded" | "folder";
  path: string;
  mime: string;
  width: number | null;
  height: number | null;
  /** Bytes. */
  size: number;
  /** How many of the release's files have an embedded picture. */
  filesWithPicture: number;
  files: number;
}

/** POST /api/proposals/:id/cover/decision */
export interface CoverDecisionRequest {
  decision: "accepted" | "kept_current";
}

export interface ProviderMatchDto {
  provider: "deezer" | "itunes" | "discogs";
  status: "found" | "different_edition" | "not_found" | "skipped" | "error";
  via: "link" | "barcode" | null;
  url: string | null;
  reason: string | null;
}

/** GET …/proposal: the latest proposal (or null) and the live propose job, if any. */
export interface ProposalResponse {
  proposal: ProposalDto | null;
  job: JobDto | null;
  /** Writes are refused in read-only mode; the UI says so instead of offering them. */
  readOnly: boolean;
  /** Locks that apply to this release: global, this release's, and its files'. */
  locks: LockDto[];
}

/** POST …/proposal: build a proposal from this MusicBrainz release. */
export interface ProposeRequest {
  releaseMbid: string;
}

// ---- writing and undo (§11.3, Phase 3)

export type WriteBatchStatus = "running" | "done" | "partial" | "failed" | "undone";

export interface WriteFileResultDto {
  /** Relative to the music root. */
  path: string;
  status: "written" | "skipped_stale" | "skipped_changed" | "failed" | "restored";
  error: string | null;
}

export interface WriteBatchDto {
  id: number;
  kind: "write" | "undo";
  status: WriteBatchStatus;
  proposalId: number | null;
  /** For an undo: the write it reverted. */
  undoesBatchId: number | null;
  startedAt: number;
  finishedAt: number | null;
  counts: { written: number; skipped: number; failed: number };
  error: string | null;
  files: WriteFileResultDto[];
  /** A finished write whose files can be put back as they were. */
  undoable: boolean;
}

/** GET …/history: newest first, with the live write or undo job if any. */
export interface HistoryResponse {
  batches: WriteBatchDto[];
  job: JobDto | null;
}

// ---- review (§10, Phase 3)

export type LockScope = "file" | "release" | "global_field";

/** A standing "never change this field" rule (§10.3 rule 1). */
export interface LockDto {
  id: number;
  scope: LockScope;
  /** File id for "file", release (candidate) id for "release", "" for "global_field". */
  target: string;
  field: keyof CanonicalTags;
}

export interface LockRequest {
  scope: LockScope;
  target: string;
  field: keyof CanonicalTags;
}

/** POST /api/proposals/:id/decisions: one decision for a set of field rows (e.g. a release field on every file). */
export interface DecisionRequest {
  fieldIds: number[];
  decision: FieldDecision;
  /** Required with "edited": the user's own value, in the field's canonical type. */
  edited?: unknown;
  /** With "accepted": take this source's value instead of the proposed one (settles a conflict, D48). */
  source?: "musicbrainz" | "deezer" | "itunes" | "discogs";
}

// ---- providers and settings (§9.2, §14.3, §15.2, Phase 4)

export type SettingsDto = Settings;

/** PATCH /api/settings answer: the saved settings, and changed paths that apply only after a restart. */
export interface SettingsUpdateResponse {
  settings: SettingsDto;
  restartRequired: string[];
}

export interface CredentialFieldDto {
  key: string;
  label: string;
  /** Never returned once saved; only "set". */
  secret: boolean;
  kind: "text" | "url";
  optional: boolean;
  set: boolean;
  /** "environment" fields are managed by the deployment and cannot be changed in the app. */
  source: "environment" | "app" | null;
  /** Non-secret fields only. */
  value: string | null;
  /** A saved value that cannot be decrypted (the secret key changed). */
  error: string | null;
}

export interface ProviderHealthDto {
  ok: boolean;
  message: string;
  checkedAt: number;
}

export interface ProviderDto {
  id: string;
  name: string;
  tier: "core" | "enrichment" | "music_server";
  help: string;
  /** Changing credentials takes effect after a restart (Discogs, D12). */
  restartRequired: boolean;
  /** Has an on/off switch; null when always on. */
  enabled: boolean | null;
  /** Every required credential has a value. */
  configured: boolean;
  fields: CredentialFieldDto[];
  health: ProviderHealthDto | null;
  /** A health check queued or running. */
  test: JobDto | null;
}

export interface ProvidersResponse {
  providers: ProviderDto[];
}

/** PUT /api/providers/:id/credentials: a string saves a field, null (or "") removes it. */
export interface CredentialsRequest {
  values: Record<string, string | null>;
}
