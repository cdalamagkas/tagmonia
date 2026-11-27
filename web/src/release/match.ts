/**
 * What the Match tab shows (docs/proposals/release-page-restructure.md, PR 3): the release the tags come
 * from, whether its match is certain, the track mapping reduced to what is off, and one list of
 * alternatives. Pure, so it is unit-tested without a browser.
 */
import type { EditionDto, IdentificationDto, MatchDto, ProposalDto } from "../../../shared/types.ts";

/** A file fits its track well at or above this; below, its row is shown (1 − cost, as the scores are). */
export const GOOD_FIT = 0.9;

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LinkKind =
  | { kind: "musicbrainz"; mbid: string }
  | { kind: "provider"; url: string }
  /** Evidence for the tags, not a source (§9.5, D55). */
  | { kind: "youtube"; url: string }
  | { kind: "invalid"; message: string };

/**
 * One link box for every source: a MusicBrainz release link (or a bare MBID) chooses that release; any
 * YouTube link adds evidence; any other https link is handed to the server, which accepts Deezer, iTunes,
 * Discogs and Bandcamp album pages and says why it refuses anything else (§14.5).
 */
export function classifyLink(text: string): LinkKind {
  const s = text.trim();
  if (MBID.test(s)) return { kind: "musicbrainz", mbid: s.toLowerCase() };
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return { kind: "invalid", message: "Paste a link (https://…) or a MusicBrainz release ID" };
  }
  if (url.hostname === "musicbrainz.org" || url.hostname.endsWith(".musicbrainz.org")) {
    const m = /^\/release\/([0-9a-f-]{36})(?:\/|$)/i.exec(url.pathname);
    if (!m || !MBID.test(m[1])) {
      return { kind: "invalid", message: "That MusicBrainz link is not a release (…/release/…)" };
    }
    return { kind: "musicbrainz", mbid: m[1].toLowerCase() };
  }
  if (url.protocol !== "https:") return { kind: "invalid", message: "Links must start with https://" };
  if (/^((www|m|music)\.)?youtube\.com$|^youtu\.be$/.test(url.hostname)) return { kind: "youtube", url: url.href };
  return { kind: "provider", url: url.href };
}

export type Source =
  | {
    kind: "musicbrainz";
    mbid: string;
    server: string;
    chosenBy: "auto" | "user";
    match: MatchDto | null;
    edition: EditionDto | null;
  }
  | { kind: "provider"; url: string }
  /** The user's search terms as tags (D63). */
  | { kind: "terms" }
  /** No proposal yet: the best match, if any, is a suggestion. */
  | { kind: "none" };

export interface MappingView {
  /** Every file maps to a track at a good fit, and nothing is left over on either side. */
  allGood: boolean;
  files: number;
  /** Pairs below GOOD_FIT, in track order. */
  weak: MatchDto["mapping"]["pairs"];
  unmappedFiles: number[];
  unmatchedTracks: MatchDto["mapping"]["unmatchedTracks"];
}

export interface MatchView {
  source: Source;
  /** The release the evidence and mapping are about: the chosen one, else the best match. */
  subject: MatchDto | null;
  /** The match is not certain: its evidence opens by itself. */
  uncertain: boolean;
  mapping: MappingView | null;
  /** The subject's other editions, and other releases; neither repeats the subject. */
  editions: EditionDto[];
  others: MatchDto[];
}

export function mappingView(m: MatchDto): MappingView {
  const pairs = [...m.mapping.pairs].sort((a, b) => a.medium - b.medium || a.position - b.position);
  const weak = pairs.filter((p) => 1 - p.cost < GOOD_FIT);
  return {
    allGood: weak.length === 0 && m.mapping.unmappedFiles.length === 0 && m.mapping.unmatchedTracks.length === 0,
    files: pairs.length + m.mapping.unmappedFiles.length,
    weak,
    unmappedFiles: m.mapping.unmappedFiles,
    unmatchedTracks: m.mapping.unmatchedTracks,
  };
}

/** Held for review, or below the automatic threshold, and the files do not name it. */
function uncertainMatch(m: MatchDto, ident: IdentificationDto): boolean {
  return !m.pinned && (m.capped || m.score < ident.thresholds.auto);
}

export function matchView(ident: IdentificationDto, p: ProposalDto | null): MatchView {
  let source: Source = { kind: "none" };
  if (p?.releaseMbid) {
    source = {
      kind: "musicbrainz",
      mbid: p.releaseMbid,
      server: p.mbServer ?? "https://musicbrainz.org",
      chosenBy: p.chosenBy,
      match: ident.matches.find((m) => m.releaseMbid === p.releaseMbid) ?? null,
      edition: ident.editions.find((e) => e.releaseMbid === p.releaseMbid) ?? null,
    };
  } else if (p?.sourceUrl) {
    source = { kind: "provider", url: p.sourceUrl };
  } else if (p) {
    source = { kind: "terms" };
  }

  // Without a proposal, the best match is a suggestion, unless identification concluded that nothing fits:
  // then every guess stays folded under "MusicBrainz searched" (problem 2 of the proposal).
  const subject = source.kind === "musicbrainz"
    ? source.match
    : source.kind === "none" && ident.status !== "no_match"
    ? ident.matches[0] ?? null
    : null;
  const subjectId = source.kind === "musicbrainz" ? source.mbid : subject?.releaseMbid ?? null;
  const editionIds = new Set(ident.editions.map((e) => e.releaseMbid));
  return {
    source,
    subject,
    // A release the user chose is not "uncertain"; an automatic choice or a suggestion can be.
    uncertain: subject !== null &&
      !(source.kind === "musicbrainz" && source.chosenBy === "user") &&
      (uncertainMatch(subject, ident) || ident.status === "needs_review"),
    mapping: subject ? mappingView(subject) : null,
    editions: ident.editions.length > 1 ? ident.editions.filter((e) => e.releaseMbid !== subjectId) : [],
    others: ident.matches.filter((m) => m.releaseMbid !== subjectId && !editionIds.has(m.releaseMbid)).slice(0, 5),
  };
}
