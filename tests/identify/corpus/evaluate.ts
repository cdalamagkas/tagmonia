/**
 * Runs one labelled case through the real pipeline (synthesised files →
 * buildEvidence → identify → MusicBrainz client) and judges it by D26 as
 * clarified in D38.
 */
import { editionsOf } from "../../../server/identify/editions.ts";
import { identify, type IdentifyConfig, type IdentifyResult } from "../../../server/identify/identify.ts";
import { buildEvidence } from "../../../server/jobs/identify.ts";
import type { MusicBrainzClient } from "../../../server/providers/musicbrainz/client.ts";
import type { MbRelease } from "../../../server/providers/musicbrainz/schema.ts";
import { type Damage, synthesize } from "./synth.ts";

export interface ManifestCase {
  slug: string;
  damage: Damage;
  releaseMbid: string;
  releaseGroupMbid: string | null;
  title: string;
}

export interface CaseOutcome {
  slug: string;
  damage: Damage;
  verdict: IdentifyResult["verdict"];
  topScore: number | null;
  /** The labelled release, or an indistinguishable edition of it, is tied for first. */
  rankedFirst: boolean;
  /** It is among the top 3 or the edition picker's alternatives. */
  shown: boolean;
  /** Verdict "matched" on a release that is not correct: the one outcome D26 forbids. */
  wrongAutoMatch: boolean;
  /** Unidentifiable cases are only held to the safety rule. */
  identifiable: boolean;
  methods: string[];
}

function recordingSequence(r: MbRelease): string {
  return r.media.flatMap((m) => (m.tracks ?? []).map((t) => t.recording.id)).join(",");
}

export async function runCase(
  c: ManifestCase,
  client: MusicBrainzClient,
  cfg: IdentifyConfig,
): Promise<CaseOutcome> {
  const labelled = (await client.lookupRelease(c.releaseMbid))?.value;
  if (!labelled) throw new Error(`${c.slug}: labelled release ${c.releaseMbid} not found`);
  const { folder, files } = synthesize(labelled, { slug: c.slug, damage: c.damage });
  const evidence = buildEvidence(null, files);
  const result = await identify(evidence, client, folder, cfg);

  // D38: with no barcode, catalog number or MBID in the files, editions with the
  // same recordings in the same order cannot be told apart, so either is correct.
  const distinguishing = !!(evidence.barcode || evidence.catalogNumbers?.length || evidence.albumMbid);
  const labelledSeq = recordingSequence(labelled);
  const correctCache = new Map<string, boolean>();
  async function correct(releaseId: string): Promise<boolean> {
    if (releaseId === labelled!.id) return true;
    if (distinguishing) return false;
    if (!correctCache.has(releaseId)) {
      // Already looked up by identify, so this is a cache hit, never a new request.
      const other = (await client.lookupRelease(releaseId))?.value;
      correctCache.set(
        releaseId,
        !!other && other["release-group"]?.id === labelled!["release-group"]?.id &&
          recordingSequence(other) === labelledSeq,
      );
    }
    return correctCache.get(releaseId)!;
  }

  const ranked = result.ranked;
  const top = ranked[0];
  let rankedFirst = false;
  for (const r of ranked) {
    if (top && r.score === top.score && await correct(r.releaseId)) rankedFirst = true;
  }
  const shownIds = new Set([
    ...ranked.slice(0, 3).map((r) => r.releaseId),
    ...editionsOf(ranked, cfg.thresholds).map((r) => r.releaseId),
  ]);
  let shown = false;
  for (const id of shownIds) if (await correct(id)) shown = true;
  // The edition picker also lists unexamined editions; only an exact id counts there,
  // since judging equivalence would need a lookup identify never made.
  if (result.unexaminedEditions.some((e) => e.releaseId === labelled.id)) shown = true;

  return {
    slug: c.slug,
    damage: c.damage,
    verdict: result.verdict,
    topScore: top?.score ?? null,
    rankedFirst,
    shown,
    wrongAutoMatch: result.verdict === "matched" && !(await correct(top.releaseId)),
    identifiable: c.damage !== "unidentifiable",
    methods: result.methodsTried,
  };
}

export interface Summary {
  cases: number;
  identifiable: number;
  wrongAutoMatches: string[];
  rankedFirstRate: number;
  shownRate: number;
  byVerdict: Record<string, number>;
}

export function summarize(outcomes: CaseOutcome[]): Summary {
  const id = outcomes.filter((o) => o.identifiable);
  const byVerdict: Record<string, number> = {};
  for (const o of outcomes) byVerdict[o.verdict] = (byVerdict[o.verdict] ?? 0) + 1;
  return {
    cases: outcomes.length,
    identifiable: id.length,
    wrongAutoMatches: outcomes.filter((o) => o.wrongAutoMatch).map((o) => o.slug),
    rankedFirstRate: id.filter((o) => o.rankedFirst).length / id.length,
    shownRate: id.filter((o) => o.shown).length / id.length,
    byVerdict,
  };
}

export function table(outcomes: CaseOutcome[]): string {
  const rows = outcomes.map((o) =>
    [
      o.slug.padEnd(20),
      o.damage.padEnd(18),
      o.verdict.padEnd(12),
      (o.topScore?.toFixed(3) ?? "-").padStart(5),
      o.rankedFirst ? "first" : o.shown ? "shown" : o.identifiable ? "MISS " : "n/a  ",
      o.wrongAutoMatch ? "WRONG-AUTO" : "",
      o.methods.join(","),
    ].join("  ")
  );
  return rows.join("\n");
}
