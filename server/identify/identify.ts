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
import type { MbRelease, MbSearchRelease } from "../providers/musicbrainz/schema.ts";
import { DEFAULT_THRESHOLDS, rank, type Thresholds, type Verdict, verdict } from "./editions.ts";
import { similarity } from "./normalize.ts";
import { creditString, normalizeBarcode, normalizeCatno, toReleaseView } from "./release.ts";
import { DEFAULT_SCORING, scoreRelease, type ScoringConfig } from "./score.ts";
import type { CandidateEvidence, MatchMethod, ReleaseView, ScoredRelease } from "./types.ts";
import type { FingerprintSource } from "./acoustid_source.ts";
import { AcoustIdKeyError } from "../providers/acoustid.ts";

export interface MbSource {
  searchReleases(q: ReleaseQuery, opts?: { limit?: number; signal?: AbortSignal }): Promise<Cited<MbSearchRelease[]>>;
  lookupRelease(mbid: string, signal?: AbortSignal): Promise<Cited<MbRelease> | null>;
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
  const d = Math.abs(tracks - ev.files.length);
  const count = d === 0 ? 1 : d === 1 ? 0.5 : 0;
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
): Promise<IdentifyResult> {
  let ev = evidence;
  const best = new Map<string, IdentifiedRelease>();
  /** Kept so fingerprint evidence can rescore releases found by earlier methods. */
  const views = new Map<string, { view: ReleaseView; snapshotId: number }>();
  const looked = new Set<string>();
  const result: IdentifyResult = { verdict: "no_match", ranked: [], methodsTried: [], skipped: [] };

  const settled = () => {
    result.ranked = rank([...best.values()]) as IdentifiedRelease[];
    result.verdict = verdict(result.ranked, cfg.thresholds);
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
    if (!prev || scored.score > prev.score) {
      best.set(scored.releaseId, { ...scored, method, snapshotId: got.snapshotId });
    }
    return got.value;
  }

  async function searchAndScore(q: ReleaseQuery, method: MatchMethod, pre: { album?: string; artist?: string }) {
    result.methodsTried.push(method);
    const hits = (await mb.searchReleases(q, { limit: 25, signal })).value;
    const order = hits
      .filter((h) => !looked.has(h.id))
      .map((h) => ({ h, s: preScore(ev, h, pre) }))
      .sort((a, b) => b.s - a.s || a.h.id.localeCompare(b.h.id))
      .slice(0, cfg.maxLookupsPerSearch);
    for (const { h } of order) await lookupAndScore(h.id, method);
  }

  // 1. Existing MBID: verify it still exists; MusicBrainz answers a merged MBID with its target.
  if (ev.albumMbid) {
    result.methodsTried.push("existing_mbid");
    const r = await lookupAndScore(ev.albumMbid, "existing_mbid");
    if (r && r.id !== ev.albumMbid) result.redirected = { from: ev.albumMbid, to: r.id };
    if (settled()) return result;
  }

  const n = ev.files.length;
  // 2. Barcode, then catalog number: exact identifiers.
  if (normalizeBarcode(ev.barcode)) {
    await searchAndScore({ barcode: ev.barcode }, "barcode", { album: ev.album, artist: ev.albumArtist });
    if (settled()) return result;
  }
  const catno = (ev.catalogNumbers ?? []).find((c) => normalizeCatno(c));
  if (catno) {
    // A catalog number alone is often shared across labels; the artist narrows it when known.
    await searchAndScore({ catno, artist: ev.albumArtist }, "catno", { album: ev.album, artist: ev.albumArtist });
    if (settled()) return result;
  }

  // 3. Text search from tags, else from the folder name.
  const fromFolder = queryFromFolder(folder);
  const album = ev.album ?? fromFolder.album;
  const artist = ev.albumArtist ?? (ev.album ? undefined : fromFolder.artist);
  if (album) {
    await searchAndScore({ release: album, artist, tracks: n || undefined }, "text", { album, artist });
    if (!settled() && artist && best.size === 0) {
      // Artist spellings differ a lot ("The Beatles" vs "Beatles"); retry on the title alone.
      await searchAndScore({ release: album, tracks: n || undefined }, "text", { album, artist });
    }
  }

  if (settled()) return result;

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
      return result;
    }
    ev = {
      ...ev,
      files: ev.files.map((f) => ({ ...f, acoustidRecordingIds: matches.get(f.fileId)?.recordingIds ?? [] })),
    };
    // Earlier candidates now have fingerprint evidence too: score them again.
    for (const [id, prev] of best) {
      const v = views.get(id)!;
      best.set(id, { ...scoreRelease(ev, v.view, cfg.scoring), method: prev.method, snapshotId: v.snapshotId });
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

  settled();
  return result;
}
