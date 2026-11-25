/**
 * YouTube as evidence (ARCHITECTURE.md §9.5, D55). Pure. Its values fill only what no other source has, or
 * refine a year-only date with a full one for the same year; otherwise they are listed next to the other
 * sources, where they corroborate or differ, and never make a conflict. Only a playlist with as many
 * videos as the release has tracks counts: a longer or shorter one is another edition, shown but unused.
 */
import type { ProviderMatch } from "../providers/enrichment.ts";
import type { YouTubeEvidence } from "../providers/youtube.ts";
import type { CanonicalTags } from "../tagio/types.ts";
import { valuesAgree } from "./compare.ts";
import type { FieldProvenance } from "./merge.ts";

export interface TagsWithProvenance {
  release: CanonicalTags;
  provenance: Map<string, FieldProvenance>;
}

/** The match row for a pasted YouTube link: found when its video count is the release's track count. */
export function youtubeMatch(e: YouTubeEvidence, trackCount: number): ProviderMatch {
  const n = e.tracks.length;
  const base = { provider: "youtube" as const, via: "link" as const, url: e.url, release: null, evidence: e };
  return n === trackCount ? { ...base, status: "found", reason: null } : {
    ...base,
    status: "different_edition",
    reason: `${n} video${n === 1 ? "" : "s"}; the release has ${trackCount} track${trackCount === 1 ? "" : "s"}`,
  };
}

/** Adds YouTube's date and label to `tags` in place, as evidence. */
export function applyEvidence(tags: TagsWithProvenance, match: ProviderMatch | null): void {
  const e = match?.status === "found" ? match.evidence : undefined;
  if (!e) return;
  const { release, provenance } = tags;
  const note = (field: "date" | "label", value: unknown, proposed: boolean) => {
    const prev = provenance.get(field);
    const sources = [...(prev?.sources ?? []), { provider: "youtube" as const, value }];
    if (proposed) {
      (release as Record<string, unknown>)[field] = value;
      provenance.set(field, { origin: "youtube", sources, conflict: prev?.conflict ?? false });
    } else if (prev) {
      // Only listed: the proposed value, its origin and any conflict between the other sources stay.
      provenance.set(field, { ...prev, sources });
    }
  };

  if (e.date) {
    const current = release.date;
    const refines = !!current && e.date.length > current.length && valuesAgree("date", e.date, current);
    note("date", e.date, !current || refines);
  }
  if (e.label) {
    note("label", [e.label], !release.label || release.label.length === 0);
  }
}
