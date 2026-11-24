/**
 * Edition picking (ARCHITECTURE.md §8.2) and the final verdict for a candidate.
 * Never silently pick one edition: near-ties within a release group go to review.
 */
import type { ScoredRelease } from "./types.ts";

export type Verdict = "matched" | "needs_review" | "no_match";

export interface Thresholds {
  autoThreshold: number;
  reviewThreshold: number;
  /** Releases of the same release group within this distance of the best are editions to choose from. */
  editionMargin: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { autoThreshold: 0.92, reviewThreshold: 0.70, editionMargin: 0.03 };

/** The files name this edition (MBID, barcode or catalog number) and it fits them well enough to auto-match. */
function confidentlyPinned(r: ScoredRelease, t: Thresholds): boolean {
  return !!r.pinned && r.score >= t.autoThreshold;
}

/**
 * Best first. A release the files themselves name ranks above unpinned ones
 * once it reaches the auto threshold (D38); ties broken by release id so the
 * order is stable across runs.
 */
export function rank(scored: ScoredRelease[], t: Thresholds = DEFAULT_THRESHOLDS): ScoredRelease[] {
  const tier = (r: ScoredRelease) => (confidentlyPinned(r, t) ? 1 : 0);
  return [...scored].sort((a, b) => tier(b) - tier(a) || b.score - a.score || a.releaseId.localeCompare(b.releaseId));
}

/** Releases that compete with the best one as editions of the same release group. */
export function editionsOf(ranked: ScoredRelease[], t: Thresholds = DEFAULT_THRESHOLDS): ScoredRelease[] {
  const best = ranked[0];
  if (!best?.releaseGroupId) return best ? [best] : [];
  return ranked.filter((r) => r.releaseGroupId === best.releaseGroupId && best.score - r.score <= t.editionMargin);
}

export function verdict(ranked: ScoredRelease[], t: Thresholds = DEFAULT_THRESHOLDS): Verdict {
  const best = ranked[0];
  if (!best || best.score < t.reviewThreshold) return "no_match";
  if (best.score < t.autoThreshold) return "needs_review";
  // Any close runner-up, an edition or not, means the evidence cannot tell them apart; when
  // the files name the edition, only another release they also name can compete (D38).
  const rivals = confidentlyPinned(best, t) ? ranked.slice(1).filter((r) => r.pinned) : ranked.slice(1);
  const second = rivals[0];
  return second && best.score - second.score <= t.editionMargin ? "needs_review" : "matched";
}
