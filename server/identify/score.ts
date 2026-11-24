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
/** "Track 01", "Unknown": a title that names nothing, so it can neither confirm nor contradict a track. */
const GENERIC_TITLE = /^(track|piste|titel|pista|traccia|untitled|unknown|audio|title)\s*\d*$/i;

function fileTitle(f: FileEvidence): string | undefined {
  const t = f.title?.trim() || titleFromPath(f.path);
  return t && !GENERIC_TITLE.test(t.trim()) ? t : undefined;
}

/** Below this, a file's title says it is a different piece of music than the track. */
const TITLE_CONTRADICTS = 0.3;

/**
 * Total tracks per disc and total discs, as most files' own tags declare them
 * (D45). Null when the files do not say: the count then falls back to how many
 * of the release's tracks are present.
 */
export function declaredSize(files: FileEvidence[]): { perDisc: Map<number, number>; discs: number | null } | null {
  const votes = new Map<number, Map<number, number>>();
  const discVotes = new Map<number, number>();
  for (const f of files) {
    if (f.totaltracks && f.totaltracks > 0) {
      const disc = f.discnumber ?? 1;
      const m = votes.get(disc) ?? new Map<number, number>();
      m.set(f.totaltracks, (m.get(f.totaltracks) ?? 0) + 1);
      votes.set(disc, m);
    }
    if (f.totaldiscs && f.totaldiscs > 0) discVotes.set(f.totaldiscs, (discVotes.get(f.totaldiscs) ?? 0) + 1);
  }
  if (votes.size === 0) return null;
  const top = (m: Map<number, number>) => [...m].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  return {
    perDisc: new Map([...votes].map(([disc, m]) => [disc, top(m)])),
    discs: discVotes.size ? top(discVotes) : null,
  };
}

/**
 * How well a release's size agrees with the declared size, in [0, 1]: per disc
 * the files are on, the smaller of declared and actual track count over the
 * larger; times the same ratio for the number of discs when declared.
 */
export function sizeAgreement(declared: ReturnType<typeof declaredSize>, mediumTracks: number[]): number | null {
  if (!declared) return null;
  const ratio = (a: number, b: number) => (a === b ? 1 : Math.min(a, b) / Math.max(a, b));
  const perDisc = [...declared.perDisc].map(([disc, total]) => {
    const actual = mediumTracks[disc - 1];
    return actual === undefined ? 0 : ratio(total, actual);
  });
  const tracks = perDisc.reduce((a, b) => a + b, 0) / perDisc.length;
  return declared.discs ? tracks * ratio(declared.discs, mediumTracks.length) : tracks;
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
      // A clearly different title, and no track number to back the pair: a coincidence of durations,
      // not this track (a hidden track must not land on a bonus track of a bigger edition, D45).
      if (ts !== null && ts < TITLE_CONTRADICTS && samePos !== 1) return 1;
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
/**
 * How well the files' count fits the release (D45). Files that are not on the
 * release weigh heavily (one halves it, two or more zero it), as before (D38).
 * Tracks missing from the folder only mildly: people often keep part of an
 * album, so half an album scores 0.75. The penalty is not zero, so a release
 * the files fill completely still beats a bigger edition that also holds them.
 */
export function countSignal(
  filesNotOnRelease: number,
  filesOnRelease: number,
  releaseTracks: number,
  /** From the files' own "of N" tags when they have them; it replaces the share present (D45). */
  declaredAgreement: number | null = null,
): number {
  const extra = filesNotOnRelease === 0 ? 1 : filesNotOnRelease === 1 ? 0.5 : 0;
  const present = declaredAgreement ?? (releaseTracks > 0 ? Math.min(1, filesOnRelease / releaseTracks) : 0);
  return extra * (0.5 + 0.5 * present);
}

function trackCountSignal(mapping: TrackMapping, release: ReleaseView, files: FileEvidence[]): number {
  const media = new Map<number, number>();
  for (const t of release.tracks) media.set(t.medium, (media.get(t.medium) ?? 0) + 1);
  const mediumTracks = [...media].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
  const declared = sizeAgreement(declaredSize(files), mediumTracks);
  return countSignal(mapping.unmappedFiles.length, mapping.pairs.length, release.tracks.length, declared);
}

/**
 * Mean over the files: a file that maps to nothing counts as 0, but a track
 * missing from the folder does not count at all (D45); the count signal
 * already accounts for it.
 */
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
  const n = ev.files.length;
  const titledFiles = ev.files.filter((f) => fileTitle(f)).length;
  const fingerprinted = ev.files.filter((f) => f.acoustidRecordingIds?.length);
  const releaseRecordings = new Set(r.tracks.map((t) => t.recordingId));

  const signals: Record<SignalName, number | null> = {
    trackCount: trackCountSignal(mapping, r, ev.files),
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
  // The floor needs the files to belong to the release: a barcode cannot rescue a folder of other music.
  // Missing tracks are fine: three files carrying a box set's barcode are from that box (D45).
  if (identifierMatch && mapping.unmappedFiles.length <= 1) score = Math.max(score, cfg.identifierFloor);

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
