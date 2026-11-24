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

/** Best first; ties broken by release id so the order is stable across runs. */
export function rank(scored: ScoredRelease[]): ScoredRelease[] {
  return [...scored].sort((a, b) => b.score - a.score || a.releaseId.localeCompare(b.releaseId));
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
  // Any close runner-up, an edition or not, means the evidence cannot tell them apart.
  const second = ranked[1];
  return second && best.score - second.score <= t.editionMargin ? "needs_review" : "matched";
}
