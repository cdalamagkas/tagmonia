/**
 * Identification order (ARCHITECTURE.md §8): existing MBID, barcode/catalog
 * number, text search, fingerprint (AcoustID); manual lookup arrives with the
 * review UI. Stops at the first method that yields a confident,
 * unambiguous match.
 *
 * Talks to MusicBrainz only through `MbSource`, so it is tested without the network.
 */
import type { Cited, ReleaseQuery } from "../providers/musicbrainz/client.ts";
import { MusicBrainzResponseError } from "../providers/musicbrainz/client.ts";
import type { MbBrowseRelease, MbRelease, MbSearchRelease } from "../providers/musicbrainz/schema.ts";
import { DEFAULT_THRESHOLDS, rank, type Thresholds, type Verdict, verdict } from "./editions.ts";
import { similarity } from "./normalize.ts";
import { creditString, normalizeBarcode, normalizeCatno, releaseSummary, toReleaseView } from "./release.ts";
import {
  countSignal,
  declaredSize,
  DEFAULT_SCORING,
  scoreRelease,
  type ScoringConfig,
  sizeAgreement,
} from "./score.ts";
import type { CandidateEvidence, MatchMethod, ReleaseSummary, ReleaseView, ScoredRelease } from "./types.ts";
import type { FingerprintSource } from "./acoustid_source.ts";
import { AcoustIdKeyError } from "../providers/acoustid.ts";

export interface MbSource {
  searchReleases(q: ReleaseQuery, opts?: { limit?: number; signal?: AbortSignal }): Promise<Cited<MbSearchRelease[]>>;
  lookupRelease(mbid: string, signal?: AbortSignal): Promise<Cited<MbRelease> | null>;
  /** Optional so simple sources still work; without it the edition picker lists search hits only. */
  browseReleaseGroup?(releaseGroupId: string, opts?: { signal?: AbortSignal }): Promise<Cited<MbBrowseRelease[]>>;
}

export interface IdentifyConfig {
  scoring: ScoringConfig;
  thresholds: Thresholds;
  /**
   * Full lookups per search. Search results already carry title, artist and
   * track count, so they are pre-ranked on those and only the best few are
   * fetched: at 1 request per second this bounds the time per album (D36).
   */
  maxLookupsPerSearch: number;
}

export const DEFAULT_IDENTIFY: IdentifyConfig = {
  scoring: DEFAULT_SCORING,
  thresholds: DEFAULT_THRESHOLDS,
  maxLookupsPerSearch: 5,
};

export interface IdentifiedRelease extends ScoredRelease {
  method: MatchMethod;
  snapshotId: number;
}

export interface IdentifyResult {
  verdict: Verdict;
  /** Best first. */
  ranked: IdentifiedRelease[];
  methodsTried: MatchMethod[];
  /** The files' MBID pointed at a release MusicBrainz has since merged into another (§8 order 1). */
  redirected?: { from: string; to: string };
  /** Releases that could not be scored, e.g. truncated tracklists (D32). */
  skipped: { releaseId: string; reason: string }[];
  /** Fingerprinting was attempted but could not run (e.g. a rejected AcoustID key). */
  fingerprintError?: string;
  /**
   * Releases of the best release's group, within one track of its count, that
   * were found (by search or by browsing the group) but not looked up. Their
   * summaries are enough for the edition picker. While one with the same track
   * count exists the result is never "matched" (D38).
   */
  unexaminedEditions: { releaseId: string; summary: ReleaseSummary }[];
}

function hitTrackCount(h: { "track-count"?: number; media: { "track-count": number }[] }): number {
  return h["track-count"] ?? h.media.reduce((n, m) => n + m["track-count"], 0);
}

interface PoolEntry {
  releaseGroupId: string | null;
  trackCount: number;
  summary: ReleaseSummary;
}

function poolEntry(h: MbSearchRelease | MbBrowseRelease, releaseGroupId?: string): PoolEntry {
  const n = hitTrackCount(h);
  return {
    releaseGroupId: h["release-group"]?.id ?? releaseGroupId ?? null,
    trackCount: n,
    summary: releaseSummary(h, n),
  };
}

/** Guesses "Artist - Album (1999) [FLAC]" from a folder name, for untagged sets. Used to search, never to score. */
export function queryFromFolder(folder: string): { artist?: string; album?: string } {
  const base = folder.split("/").filter(Boolean).pop() ?? "";
  const clean = base.replace(/[([][^)\]]*[)\]]/g, " ").replace(/\s+/g, " ").trim();
  const parts = clean.split(/\s+-\s+/);
  if (parts.length >= 2) return { artist: parts[0], album: parts.slice(1).join(" - ") };
  return clean ? { album: clean } : {};
}

/** Cheap ranking of search hits on what the search response already contains. */
function preScore(ev: CandidateEvidence, hit: MbSearchRelease, query: { album?: string; artist?: string }): number {
  const tracks = hit["track-count"] ?? hit.media.reduce((n, m) => n + m["track-count"], 0);
  // The scorer's own count rule (D45), so a release holding a partial album is still looked up,
  // and the edition the files' "of N" tags describe is looked up first.
  const files = ev.files.length;
  const declared = sizeAgreement(declaredSize(ev.files), hit.media.map((m) => m["track-count"]));
  const count = countSignal(Math.max(0, files - tracks), Math.min(files, tracks), tracks, declared);
  const album = query.album ? similarity(query.album, hit.title) : 0.5;
  const artist = query.artist ? similarity(query.artist, creditString(hit["artist-credit"])) : 0.5;
  return 0.4 * count + 0.3 * album + 0.2 * artist + 0.1 * (hit.score / 100);
}

export async function identify(
  evidence: CandidateEvidence,
  mb: MbSource,
  folder: string,
  cfg: IdentifyConfig = DEFAULT_IDENTIFY,
  signal?: AbortSignal,
  /** Absent when no AcoustID key is configured: order 4 is skipped. */
  fingerprints?: FingerprintSource,
  /** §8 order 5: the user named a release; it is scored and the automatic search is skipped. */
  opts: { manualMbid?: string } = {},
): Promise<IdentifyResult> {
  let ev = evidence;
  const best = new Map<string, IdentifiedRelease>();
  /** Kept so fingerprint evidence can rescore releases found by earlier methods. */
  const views = new Map<string, { view: ReleaseView; snapshotId: number }>();
  const looked = new Set<string>();
  const result: IdentifyResult = {
    verdict: "no_match",
    ranked: [],
    methodsTried: [],
    skipped: [],
    unexaminedEditions: [],
  };
  /** Every release seen without a lookup: candidates for the edition picker. */
  const pool = new Map<string, PoolEntry>();

  const settled = () => {
    result.ranked = rank([...best.values()], cfg.thresholds) as IdentifiedRelease[];
    result.verdict = verdict(result.ranked, cfg.thresholds);
    const top = result.ranked[0];
    const editions = top?.releaseGroupId
      ? [...pool].filter(([id, e]) =>
        !looked.has(id) && e.releaseGroupId === top.releaseGroupId &&
        Math.abs(e.trackCount - top.summary.trackCount) <= 1
      )
      : [];
    result.unexaminedEditions = editions.map(([releaseId, e]) => ({ releaseId, summary: e.summary }));
    // Never silently pick one edition (§8.2), including ones the budget did not look at;
    // unless the files name the edition themselves.
    if (
      result.verdict === "matched" && !top.pinned &&
      editions.some(([, e]) => e.trackCount === top.summary.trackCount)
    ) {
      result.verdict = "needs_review";
    }
    return result.verdict === "matched";
  };

  async function lookupAndScore(mbid: string, method: MatchMethod): Promise<MbRelease | null> {
    if (looked.has(mbid)) return null;
    looked.add(mbid);
    let got: Cited<MbRelease> | null;
    try {
      got = await mb.lookupRelease(mbid, signal);
    } catch (e) {
      // One unusable release must not fail the whole candidate; network errors still do (the job retries).
      if (!(e instanceof MusicBrainzResponseError)) throw e;
      result.skipped.push({ releaseId: mbid, reason: e.message });
      return null;
    }
    if (!got) return null;
    looked.add(got.value.id);
    const view = toReleaseView(got.value);
    views.set(view.id, { view, snapshotId: got.snapshotId });
    const scored = scoreRelease(ev, view, cfg.scoring);
    const prev = best.get(scored.releaseId);
    // The files' own MBID (or the release it was merged into), or the user's own choice, names the
    // edition as an identifier does.
    const pinned = scored.identifierMatch || method === "existing_mbid" || method === "manual";
    if (!prev || scored.score > prev.score) {
      best.set(scored.releaseId, { ...scored, pinned, method, snapshotId: got.snapshotId });
    }
    return got.value;
  }

  async function searchAndScore(q: ReleaseQuery, method: MatchMethod, pre: { album?: string; artist?: string }) {
    result.methodsTried.push(method);
    const found = (await mb.searchReleases(q, { limit: 25, signal })).value;
    for (const h of found) pool.set(h.id, poolEntry(h));
    const order = found
      .filter((h) => !looked.has(h.id))
      .map((h) => ({ h, s: preScore(ev, h, pre) }))
      .sort((a, b) => b.s - a.s || a.h.id.localeCompare(b.h.id))
      .slice(0, cfg.maxLookupsPerSearch);
    for (const { h } of order) await lookupAndScore(h.id, method);
  }

  /** §8 orders 1-4; returns as soon as one is confident. */
  async function run(): Promise<void> {
    // 5. Manual: the user's choice replaces the automatic order (it is still scored, so a wrong URL shows).
    if (opts.manualMbid) {
      result.methodsTried.push("manual");
      await lookupAndScore(opts.manualMbid, "manual");
      return;
    }

    // 1. Existing MBID: verify it still exists; MusicBrainz answers a merged MBID with its target.
    if (ev.albumMbid) {
      result.methodsTried.push("existing_mbid");
      const r = await lookupAndScore(ev.albumMbid, "existing_mbid");
      if (r && r.id !== ev.albumMbid) result.redirected = { from: ev.albumMbid, to: r.id };
      if (settled()) return;
    }

    const n = ev.files.length;
    // 2. Barcode, then catalog number: exact identifiers.
    if (normalizeBarcode(ev.barcode)) {
      await searchAndScore({ barcode: ev.barcode }, "barcode", { album: ev.album, artist: ev.albumArtist });
      if (settled()) return;
    }
    const catno = (ev.catalogNumbers ?? []).find((c) => normalizeCatno(c));
    if (catno) {
      // A catalog number alone is often shared across labels; the artist narrows it when known.
      await searchAndScore({ catno, artist: ev.albumArtist }, "catno", { album: ev.album, artist: ev.albumArtist });
      if (settled()) return;
    }

    // 3. Text search from tags, else from the folder name.
    // A single file without an album tag (D62) is not named by its folder ("Misc"); a single's release
    // is usually named after its track.
    const single = ev.files.length === 1 && !ev.album;
    const fromFolder: { artist?: string; album?: string } = single ? {} : queryFromFolder(folder);
    const album = ev.album ?? (single ? ev.files[0].title : fromFolder.album);
    const artist = ev.albumArtist ?? (ev.album ? undefined : fromFolder.artist);
    if (album) {
      await searchAndScore({ release: album, artist, tracks: n || undefined }, "text", { album, artist });
      if (!settled() && artist && best.size === 0) {
        // Artist spellings differ a lot ("The Beatles" vs "Beatles"); retry on the title alone.
        await searchAndScore({ release: album, tracks: n || undefined }, "text", { album, artist });
      }
      if (!settled() && best.size === 0) {
        // Phrases miss misspelt tags ("Dmumy"); fuzzy words still find them (D38).
        await searchAndScore({ release: album, artist, tracks: n || undefined, fuzzy: true }, "text", {
          album,
          artist,
        });
      }
    }

    if (settled()) return;

    // 4. Fingerprints: when tags and text search are weak or missing.
    if (fingerprints && ev.files.length) {
      result.methodsTried.push("fingerprint");
      let matches;
      try {
        matches = await fingerprints.lookup(ev.files, signal);
      } catch (e) {
        // A rejected key affects every candidate; report it and keep the other methods' results.
        if (!(e instanceof AcoustIdKeyError)) throw e;
        result.fingerprintError = e.message;
        settled();
        return;
      }
      ev = {
        ...ev,
        files: ev.files.map((f) => ({ ...f, acoustidRecordingIds: matches.get(f.fileId)?.recordingIds ?? [] })),
      };
      // Earlier candidates now have fingerprint evidence too: score them again.
      for (const [id, prev] of best) {
        const v = views.get(id)!;
        const rescored = scoreRelease(ev, v.view, cfg.scoring);
        best.set(id, { ...rescored, pinned: prev.pinned, method: prev.method, snapshotId: v.snapshotId });
      }
      // Releases containing the most fingerprinted files first.
      const votes = new Map<string, number>();
      for (const m of matches.values()) for (const r of m.releaseIds) votes.set(r, (votes.get(r) ?? 0) + 1);
      const order = [...votes]
        .filter(([id]) => !looked.has(id))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, cfg.maxLookupsPerSearch);
      for (const [id] of order) await lookupAndScore(id, "fingerprint");
    }
  }

  await run();
  // The edition picker needs the release group's other releases, not only the ones search happened
  // to return; and a confident match must not hide an edition it never examined (D38).
  const top = result.ranked[0];
  if (top?.releaseGroupId && top.score >= cfg.thresholds.reviewThreshold && mb.browseReleaseGroup) {
    const group = top.releaseGroupId;
    for (const r of (await mb.browseReleaseGroup(group, { signal })).value) {
      if (!pool.has(r.id)) pool.set(r.id, poolEntry(r, group));
    }
  }
  settled();
  return result;
}
