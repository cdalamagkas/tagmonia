/**
 * Release scoring and track mapping (ARCHITECTURE.md §8.1, §8.3). Pure: the
 * weights and thresholds come from settings and are tuned on tests/identify/.
 */
import { assign } from "./hungarian.ts";
import { positionFromPath, similarity, titleFromPath } from "./normalize.ts";
import { normalizeBarcode, normalizeCatno } from "./release.ts";
import type {
  CandidateEvidence,
  FileEvidence,
  ReleaseView,
  ScoredRelease,
  SignalName,
  TrackMapping,
  Weights,
} from "./types.ts";

export interface ScoringConfig {
  weights: Weights;
  autoThreshold: number;
  /**
   * Below this share of the total weight backed by evidence, a score is held
   * just under `autoThreshold`: too little evidence for an unattended match (D36).
   */
  minCoverage: number;
  /** §8.1: an exact barcode or catalog number match sets this floor. */
  identifierFloor: number;
}

export const DEFAULT_SCORING: ScoringConfig = {
  weights: { trackCount: 0.20, durations: 0.25, titles: 0.20, album: 0.10, artist: 0.10, fingerprint: 0.15 },
  autoThreshold: 0.92,
  minCoverage: 0.6,
  identifierFloor: 0.95,
};

/** ≤ 3 s off is a strong match (§8.1); nothing in common from 15 s on. */
export function durationSimilarity(aMs: number, bMs: number): number {
  const d = Math.abs(aMs - bMs);
  if (d <= 3000) return 1;
  if (d >= 15000) return 0;
  return 1 - (d - 3000) / 12000;
}

/** Title from tags, else from the file name. */
function fileTitle(f: FileEvidence): string | undefined {
  return f.title?.trim() || titleFromPath(f.path);
}

function filePosition(f: FileEvidence): { disc?: number; track?: number } {
  if (f.tracknumber !== undefined) return { disc: f.discnumber, track: f.tracknumber };
  return positionFromPath(f.path);
}

interface PairSignals {
  duration: number | null;
  title: number | null;
}

/**
 * Maps files to release tracks with the Hungarian algorithm on duration,
 * title and position, so files in the wrong order still map (§8.3). Pairs that
 * share nothing are left unmapped rather than forced.
 */
export function mapTracks(
  files: FileEvidence[],
  release: ReleaseView,
): { mapping: TrackMapping; pairs: PairSignals[] } {
  const singleMedium = new Set(release.tracks.map((t) => t.medium)).size === 1;
  const sig: PairSignals[][] = [];
  const cost = files.map((f, i) => {
    const title = fileTitle(f);
    const pos = filePosition(f);
    sig[i] = [];
    return release.tracks.map((t, j) => {
      const duration = f.durationMs !== null && t.lengthMs !== null
        ? durationSimilarity(f.durationMs, t.lengthMs)
        : null;
      const ts = title ? similarity(title, t.title) : null;
      const samePos = pos.track === undefined
        ? null
        : pos.track === t.position && (singleMedium || (pos.disc ?? 1) === t.medium)
        ? 1
        : 0;
      sig[i][j] = { duration, title: ts };
      let num = 0, den = 0;
      for (const [v, w] of [[duration, 0.5], [ts, 0.35], [samePos, 0.15]] as const) {
        if (v === null) continue;
        num += v * w;
        den += w;
      }
      return den === 0 ? 0.5 : 1 - num / den;
    });
  });

  const assigned = assign(cost);
  const mapping: TrackMapping = { pairs: [], unmappedFiles: [], unmatchedTracks: [] };
  const pairs: PairSignals[] = [];
  const usedTracks = new Set<number>();
  assigned.forEach((j, i) => {
    // A pair this poor is a different song; showing it as unmapped is more honest (§8.3).
    if (j < 0 || cost[i][j] > 0.75) {
      mapping.unmappedFiles.push(files[i].fileId);
      return;
    }
    const t = release.tracks[j];
    usedTracks.add(j);
    mapping.pairs.push({
      fileId: files[i].fileId,
      medium: t.medium,
      position: t.position,
      trackId: t.trackId,
      recordingId: t.recordingId,
      cost: Math.round(cost[i][j] * 1000) / 1000,
    });
    pairs.push(sig[i][j]);
  });
  release.tracks.forEach((t, j) => {
    if (!usedTracks.has(j)) mapping.unmatchedTracks.push({ medium: t.medium, position: t.position, title: t.title });
  });
  return { mapping, pairs };
}

/**
 * From the mapping, not raw counts: 9 tracks plus a hidden file against a
 * 10-track bonus edition is not an exact count match when the extra file maps
 * to nothing there (D38).
 */
function trackCountSignal(mapping: TrackMapping): number {
  const d = Math.max(mapping.unmappedFiles.length, mapping.unmatchedTracks.length);
  return d === 0 ? 1 : d === 1 ? 0.5 : 0;
}

/** Mean over max(files, tracks): an unmapped file or an unmatched track counts as 0. */
function meanOver(values: (number | null)[], n: number): number | null {
  const known = values.filter((v): v is number => v !== null);
  if (known.length === 0 || n === 0) return null;
  return known.reduce((a, b) => a + b, 0) / n;
}

function identifierMatches(ev: CandidateEvidence, r: ReleaseView): boolean {
  const bc = normalizeBarcode(ev.barcode);
  if (bc && bc === normalizeBarcode(r.summary.barcode)) return true;
  const mine = new Set((ev.catalogNumbers ?? []).map(normalizeCatno).filter((x) => x));
  return r.summary.catalogNumbers.some((c) => {
    const n = normalizeCatno(c);
    return n !== null && mine.has(n);
  });
}

export function scoreRelease(
  ev: CandidateEvidence,
  r: ReleaseView,
  cfg: ScoringConfig = DEFAULT_SCORING,
): ScoredRelease {
  const { mapping, pairs } = mapTracks(ev.files, r);
  const n = Math.max(ev.files.length, r.tracks.length);
  const titledFiles = ev.files.filter((f) => fileTitle(f)).length;
  const fingerprinted = ev.files.filter((f) => f.acoustidRecordingIds?.length);
  const releaseRecordings = new Set(r.tracks.map((t) => t.recordingId));

  const signals: Record<SignalName, number | null> = {
    trackCount: trackCountSignal(mapping),
    durations: meanOver(pairs.map((p) => p.duration), n),
    // Titles count only when most files have one, or a few guessed titles would dominate.
    titles: titledFiles * 2 >= ev.files.length ? meanOver(pairs.map((p) => p.title), n) : null,
    album: ev.album ? similarity(ev.album, r.summary.title) : null,
    artist: ev.albumArtist ? similarity(ev.albumArtist, r.summary.artist) : null,
    fingerprint: fingerprinted.length
      ? fingerprinted.filter((f) => f.acoustidRecordingIds!.some((id) => releaseRecordings.has(id))).length /
        ev.files.length
      : null,
  };

  let num = 0, den = 0, total = 0;
  for (const [name, w] of Object.entries(cfg.weights) as [SignalName, number][]) {
    total += w;
    const v = signals[name];
    if (v === null) continue;
    num += v * w;
    den += w;
  }
  const coverage = total > 0 ? den / total : 0;
  let score = den > 0 ? num / den : 0;

  const identifierMatch = identifierMatches(ev, r);
  // The floor needs a plausible track count: a shared barcode cannot rescue a 3-file folder against a 20-track box.
  if (identifierMatch && (signals.trackCount ?? 0) >= 0.5) score = Math.max(score, cfg.identifierFloor);

  let capped = false;
  if (coverage < cfg.minCoverage && !identifierMatch && score >= cfg.autoThreshold) {
    score = cfg.autoThreshold - 0.01;
    capped = true;
  }

  return {
    releaseId: r.id,
    releaseGroupId: r.releaseGroupId,
    score: Math.round(score * 10000) / 10000,
    signals,
    coverage: Math.round(coverage * 1000) / 1000,
    capped,
    identifierMatch,
    mapping,
    summary: r.summary,
  };
}
