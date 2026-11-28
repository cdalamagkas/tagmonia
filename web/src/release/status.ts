/**
 * Where a release stands and what to do next (docs/proposals/release-page-restructure.md, D53): one
 * status sentence and one primary action for the release page's header, from the release's
 * identification, proposal, write history and submission. Pure, so it is unit-tested without a browser.
 */
import type {
  HistoryResponse,
  IdentificationDto,
  ProposalDto,
  ProposalResponse,
  ReleaseChangesDto,
  SubmissionDto,
} from "../../../shared/types.ts";
import { changesToWrite, openChoices, renames, writes } from "../../../shared/changes.ts";
import { activeSubmission, submissionHeader } from "./submission.ts";

export { changesToWrite, openChoices, renames, writes };

export const SOURCE_NAMES: Record<string, string> = {
  musicbrainz: "MusicBrainz",
  deezer: "Deezer",
  itunes: "iTunes",
  tidal: "Tidal",
  spotify: "Spotify",
  discogs: "Discogs",
  bandcamp: "Bandcamp",
  youtube: "YouTube",
  user: "your search terms",
};

/** The provider of a "not on MusicBrainz" proposal's page, by its host. */
export function sourceName(url: string | null): string {
  const host = url ? new URL(url).hostname : "";
  if (host.endsWith("deezer.com")) return "Deezer";
  if (host.endsWith("apple.com")) return "iTunes";
  if (host.endsWith("discogs.com")) return "Discogs";
  if (host === "tidal.com" || host.endsWith(".tidal.com")) return "Tidal";
  if (host === "open.spotify.com") return "Spotify";
  if (host.endsWith("bandcamp.com")) return "Bandcamp";
  if (host === "youtu.be" || host.endsWith("youtube.com")) return "YouTube";
  return "the provider";
}

export function isOpen(p: ProposalDto): boolean {
  return p.state === "draft" || p.state === "needs_review" || p.state === "approved";
}

export type ActionId =
  | "write" // write the proposal
  | "build" // build the proposal again from the same source
  | "prepare" // build a proposal from the best MusicBrainz match
  | "identify" // identify again
  | "undo" // undo the latest write
  | "match" // open the Match tab
  | "resolve" // open the Tags tab at the conflicts
  | "submission" // open the Add to MusicBrainz panel
  | "editor" // open MusicBrainz's release editor (the submission is ready)
  | "retry"; // check MusicBrainz again after a failed submission check

export interface Action {
  id: ActionId;
  label: string;
  /** Why it cannot be used now (read-only mode, a running write); shown as the button's title. */
  disabled?: string;
}

export interface ReleaseStatus {
  /** busy: a job runs (the page polls); attention: something needs the user; ok: nothing to do. */
  tone: "busy" | "attention" | "ok" | "error" | "neutral";
  sentence: string;
  primary: Action | null;
  secondary: Action[];
}

export interface ReleaseState {
  identification: IdentificationDto;
  proposal: ProposalResponse;
  history: HistoryResponse;
  submission: SubmissionDto | null;
  /** The album waits in the inbox; written, it moves into the library (D57). */
  inInbox?: boolean;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The latest write that can be undone, if any. */
export function undoableBatch(h: HistoryResponse) {
  return h.batches.find((b) => b.kind === "write" && b.undoable) ?? null;
}

/** Tags from a provider, and the release is not (yet) on MusicBrainz. */
function fromProvider(p: ProposalDto | null): boolean {
  return !!p && !p.releaseMbid && !!p.sourceUrl;
}

/** Adding it to MusicBrainz is the next step after writing, until a submission is under way. */
function addToMusicBrainz(p: ProposalDto, s: SubmissionDto | null): Action | null {
  if (!fromProvider(p) || activeSubmission(s)) return null;
  return { id: "submission", label: "Add to MusicBrainz →" };
}

/**
 * While a submission is under way (D52), its state takes the status line. A returned one does so only
 * while nothing else needs the user first (a stale proposal, an open choice).
 */
function submissionStatus(s: ReleaseState): ReleaseStatus | null {
  const pr = s.proposal;
  const p = pr.proposal;
  const sub = activeSubmission(s.submission);
  if (!sub) return null;
  const open = !!p && isOpen(p);
  const n = p && open ? changesToWrite(p) : 0;
  if (sub.state === "returned") {
    if (p && open && (p.stale || openChoices(p) > 0)) return null;
  } else if (!fromProvider(p) && sub.state !== "verifying") {
    // The source was changed to a MusicBrainz release meanwhile: the submission no longer applies.
    return null;
  }
  const h = submissionHeader(sub, p, n);
  if (!h) return null;
  const write: Action = {
    id: "write",
    label: `Write ${plural(n, "change")}`,
    ...(pr.readOnly ? { disabled: "Read-only mode: nothing is written" } : {}),
  };
  const primary: Action | null = !h.primary
    ? null
    : h.primary.id === "write"
    ? write
    : { id: h.primary.id === "panel" ? "submission" : h.primary.id, label: h.primary.label };
  const secondary: Action[] = [];
  if (n > 0 && primary?.id !== "write" && !p!.stale) secondary.push(write);
  if (p?.state === "written") {
    const batch = undoableBatch(s.history);
    if (batch && !pr.readOnly) secondary.push({ id: "undo", label: "Undo" });
  }
  return { tone: h.tone, sentence: h.sentence, primary, secondary };
}

export function releaseStatus(s: ReleaseState): ReleaseStatus {
  const status = statusOf(s);
  if (!s.inInbox || status.tone === "busy") return status;
  // An inbox album (D57): its write is also the move into the library.
  const inbox = (a: Action | null) => a?.id === "write" ? { ...a, label: "Write and move to the library" } : a;
  return {
    ...status,
    sentence: `In the inbox · ${status.sentence}`,
    primary: inbox(status.primary),
    secondary: status.secondary.map((a) => inbox(a)!),
  };
}

function statusOf(s: ReleaseState): ReleaseStatus {
  const { identification: ident, proposal: pr, history } = s;
  const p = pr.proposal;

  // Running work first: the page polls while any of it lasts.
  if (history.job) {
    const undoing = history.job.kind === "undo";
    return {
      tone: "busy",
      sentence: undoing ? "Undoing the last write…" : "Writing to the files…",
      primary: null,
      secondary: [],
    };
  }
  if (pr.job) return { tone: "busy", sentence: "Preparing the changes…", primary: null, secondary: [] };
  if (ident.job || ident.status === "identifying") {
    return { tone: "busy", sentence: "Identifying on MusicBrainz…", primary: null, secondary: [] };
  }
  const submitting = submissionStatus(s);
  if (submitting) return submitting;

  if (p && isOpen(p)) {
    const extra = [addToMusicBrainz(p, s.submission)].filter((a): a is Action => !!a);
    if (p.stale) {
      return {
        tone: "attention",
        sentence: "The files changed since these changes were prepared",
        primary: { id: "build", label: "Build again" },
        secondary: extra,
      };
    }
    const choices = openChoices(p);
    if (choices > 0) {
      return {
        tone: "attention",
        sentence: `${plural(choices, "field")} ${choices === 1 ? "needs" : "need"} your choice`,
        primary: { id: "resolve", label: "Resolve" },
        secondary: extra,
      };
    }
    const n = changesToWrite(p);
    if (n === 0) {
      return {
        tone: "ok",
        sentence: "Everything is already right",
        primary: extra[0] ?? null,
        secondary: extra.slice(1),
      };
    }
    const cover = n !== 1 ? "" : p.cover?.writes ? ": a new cover" : renames(p) ? ": new file names" : "";
    return {
      tone: "attention",
      sentence: `${plural(n, "change")} ready${cover}`,
      primary: {
        id: "write",
        label: `Write ${plural(n, "change")}`,
        ...(pr.readOnly ? { disabled: "Read-only mode: nothing is written" } : {}),
      },
      secondary: extra,
    };
  }

  if (p && p.state === "written") {
    const batch = undoableBatch(history);
    const at = batch?.finishedAt ?? p.createdAt;
    const secondary = [
      addToMusicBrainz(p, s.submission),
      batch && !pr.readOnly ? { id: "undo" as const, label: "Undo" } : null,
    ].filter((a): a is Action => !!a);
    return {
      tone: "ok",
      sentence: `Written ${new Date(at).toLocaleString()} · nothing left to change`,
      primary: null,
      secondary,
    };
  }

  if (p && p.state === "discarded") {
    return {
      tone: "neutral",
      sentence: "The proposed changes were discarded",
      primary: { id: "build", label: "Build again" },
      secondary: [],
    };
  }

  // No proposal yet: identification decides.
  switch (ident.status) {
    case "new":
    case "changed":
      return {
        tone: "neutral",
        sentence: ident.status === "changed" ? "The files changed; not identified again yet" : "Not identified yet",
        primary: { id: "identify", label: "Identify" },
        secondary: [],
      };
    case "error":
      return {
        tone: "error",
        sentence: `Identification failed${ident.error ? `: ${ident.error}` : ""}`,
        primary: { id: "identify", label: "Identify again" },
        secondary: [],
      };
    case "no_match":
      return {
        tone: "attention",
        sentence: "Not on MusicBrainz as far as Tagmonia can tell",
        primary: { id: "match", label: "Paste an album link" },
        secondary: [],
      };
    case "needs_review": {
      const fit = Math.max(
        ident.editions.length,
        ident.matches.filter((m) => m.score >= ident.thresholds.review).length,
      );
      return {
        tone: "attention",
        sentence: fit > 1 ? `${fit} releases fit; none is certain` : "A release fits, but not with certainty",
        primary: { id: "match", label: "Choose a release" },
        secondary: [],
      };
    }
    default: {
      const best = ident.matches[0];
      return {
        tone: "attention",
        sentence: best ? `Matched to ${best.summary.title}` : "Matched",
        primary: best ? { id: "prepare", label: "Prepare the changes" } : null,
        secondary: [],
      };
    }
  }
}

export interface SourceLine {
  /** "MusicBrainz", "MusicBrainz (test server)", "Deezer album (not on MusicBrainz)", or "No source chosen yet". */
  label: string;
  url: string | null;
  /** Facts about the source: title, format, country, date, label; the match score and how it was found. */
  details: string[];
}

/** Where the tags come from, for the header (the proposal's source; else the best match, if any). */
export function sourceLine(s: ReleaseState, methodLabel: (m: string) => string): SourceLine {
  const p = s.proposal.proposal;
  const ident = s.identification;
  if (p && !p.releaseMbid && p.sourceUrl) {
    const filled = [...new Set(p.fields.map((f) => f.origin).filter((o) => o !== p.primarySource))]
      .map((o) => SOURCE_NAMES[o] ?? o);
    return {
      label: `${sourceName(p.sourceUrl)} album (not on MusicBrainz)`,
      url: p.sourceUrl,
      details: filled.length ? [`filled from ${filled.join(", ")}`] : [],
    };
  }
  if (p && !p.releaseMbid && !p.sourceUrl) {
    return { label: "Your search terms (not on MusicBrainz)", url: null, details: [] };
  }
  const mbid = p?.releaseMbid ?? null;
  if (mbid) {
    const server = p?.mbServer ?? "https://musicbrainz.org";
    const match = ident.matches.find((m) => m.releaseMbid === mbid);
    const edition = ident.editions.find((e) => e.releaseMbid === mbid);
    const sum = match?.summary ?? edition?.summary;
    const details = sum
      ? [sum.title, sum.format, sum.country, sum.date, sum.labels.join(", ")].filter((x): x is string => !!x)
      : [];
    if (match) details.push(`${Math.round(match.score * 100)}% (${methodLabel(match.method)})`);
    return {
      label: p?.mbServer ? "MusicBrainz (test server)" : "MusicBrainz",
      url: `${server}/release/${mbid}`,
      details,
    };
  }
  return { label: "No source chosen yet", url: null, details: [] };
}

/** The library list's Changes column (D61): what the latest prepared changes would do, in a few words. */
export function changesLabel(
  c: ReleaseChangesDto | null,
): { label: string; tone: "" | "ok" | "warn" | "info"; title: string } {
  if (!c) return { label: "–", tone: "", title: "No changes prepared yet" };
  const n = (k: number, one: string, many: string) => (k === 1 ? `1 ${one}` : `${k} ${many}`);
  switch (c.state) {
    case "stale":
      return { label: "files changed", tone: "warn", title: "The files changed since the changes were prepared" };
    case "choices":
      return {
        label: n(c.choices, "to choose", "to choose"),
        tone: "warn",
        title: `${n(c.choices, "value needs", "values need")} your choice, then ${
          n(c.count, "change", "changes")
        } can be written`,
      };
    case "ready":
      // The number alone: the column is headed Changes, and the title says the rest.
      return { label: String(c.count), tone: "info", title: `${n(c.count, "change", "changes")} ready to write` };
    case "none":
      return { label: "complete", tone: "ok", title: "The files already have everything the source offers" };
    case "written":
      // Nothing new is prepared since the last write: no badge, like a release with nothing prepared.
      return { label: "–", tone: "", title: "The latest changes were written; nothing new is prepared" };
  }
}
