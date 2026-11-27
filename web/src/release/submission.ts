/**
 * Add to MusicBrainz as a step panel (docs/proposals/release-page-restructure.md, PR 4, D53): which of the
 * five steps a submission is at, one row format for its artists, and the header's sentence while it is
 * under way. Pure, so it is unit-tested without a browser.
 */
import type { ProposalDto, SubmissionArtistDto, SubmissionDto } from "../../../shared/types.ts";

export const TEST_SERVER = "https://test.musicbrainz.org";

export function serverHost(server: string): string {
  return new URL(server).host;
}

export type StepId = "check" | "artists" | "duplicates" | "editor" | "done";
export const STEPS: { id: StepId; label: string }[] = [
  { id: "check", label: "Check" },
  { id: "artists", label: "Artists" },
  { id: "duplicates", label: "Duplicates" },
  { id: "editor", label: "Editor" },
  { id: "done", label: "Done" },
];

export type StepState = "done" | "current" | "todo" | "skipped";

export interface StepsView {
  current: StepId;
  states: Record<StepId, StepState>;
}

/** A submission the panel and header follow: abandoned ones are history. */
export function activeSubmission(s: SubmissionDto | null): SubmissionDto | null {
  return s && s.state !== "abandoned" ? s : null;
}

/** Artists the editor cannot link yet: no MBID on the server. */
export function artistsToLink(s: SubmissionDto): number {
  return s.artists.filter((a) => !a.mbid).length;
}

/**
 * Where the submission stands. The artist step is skipped when every artist was found by its provider
 * page, the duplicate step when there are none; neither blocks the editor, which can link or add artists
 * itself, so they are steps to look at, not gates.
 */
export function stepsView(s: SubmissionDto | null): StepsView {
  const sub = activeSubmission(s);
  const allFound = !!sub && sub.artists.every((a) => a.mbid && a.via === "link");
  const checked = !!sub && sub.state !== "checking" && sub.state !== "failed";
  let current: StepId;
  if (!checked) current = "check";
  else if (sub.state === "returned") current = "done";
  else if (sub.state === "seeded" || sub.state === "verifying") current = "editor";
  else if (artistsToLink(sub) > 0) current = "artists";
  else if (sub.duplicates.length > 0) current = "duplicates";
  else current = "editor";
  const order = STEPS.map((x) => x.id);
  const at = order.indexOf(current);
  const states = {} as Record<StepId, StepState>;
  for (const [i, id] of order.entries()) {
    if (i === at) states[id] = "current";
    else if (i > at) states[id] = "todo";
    else if (id === "artists" && allFound) states[id] = "skipped";
    // Passed for the editor (which can add artists itself), but not done: it keeps its number, not a tick.
    else if (id === "artists" && artistsToLink(sub!) > 0) states[id] = "todo";
    else if (id === "duplicates" && sub && sub.duplicates.length === 0) states[id] = "skipped";
    else states[id] = "done";
  }
  return { current, states };
}

export type ArtistStatus = "link" | "chosen" | "name" | "unlinked" | "missing";

export interface ArtistRow {
  name: string;
  status: ArtistStatus;
  /** "found by its page", "your choice", "same name, check it", "not linked yet", "not on test.musicbrainz.org" */
  label: string;
  /** The artist on the server, when linked. */
  url: string | null;
  ok: boolean;
}

/** One row format for every credited artist: name — status — link — one action (the action follows the status). */
export function artistRow(a: SubmissionArtistDto, server: string): ArtistRow {
  const url = a.mbid ? `${server}/artist/${a.mbid}` : null;
  if (a.mbid) {
    const status: ArtistStatus = a.via === "chosen" ? "chosen" : a.via === "name" ? "name" : "link";
    const label = status === "chosen"
      ? "your choice"
      : status === "name"
      ? "same name, check it"
      : "found by its provider page";
    return { name: a.name, status, label, url, ok: true };
  }
  return a.suggestions.length > 0
    ? { name: a.name, status: "unlinked", label: "not linked yet", url, ok: false }
    : { name: a.name, status: "missing", label: `not on ${serverHost(server)}`, url, ok: false };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What the header says while a submission is under way, and the action that moves it on. */
export interface SubmissionHeader {
  tone: "busy" | "attention" | "ok" | "error";
  sentence: string;
  /** panel: open the panel; editor: open the release editor; retry: check again from the start; write: write the proposal. */
  primary: { id: "panel" | "editor" | "retry" | "write"; label: string } | null;
}

/**
 * The returned case depends on the proposal Tagmonia builds from the new release: until its MusicBrainz
 * identifiers are written, writing them is what finishes the job (problem 7 of the proposal).
 */
export function submissionHeader(
  s: SubmissionDto | null,
  p: ProposalDto | null,
  changes: number,
): SubmissionHeader | null {
  const sub = activeSubmission(s);
  if (!sub) return null;
  const host = serverHost(sub.server);
  switch (sub.state) {
    case "checking":
      return { tone: "busy", sentence: `Checking ${host} for this release…`, primary: null };
    case "verifying":
      return { tone: "busy", sentence: `Checking the new release on ${host}…`, primary: null };
    case "failed":
      return {
        tone: "error",
        sentence: sub.error ?? "Preparing the submission failed",
        primary: { id: "retry", label: "Try again" },
      };
    case "seeded":
      return {
        tone: "attention",
        sentence: `Waiting for you to submit on ${host}`,
        primary: { id: "panel", label: "Continue" },
      };
    case "ready": {
      const missing = artistsToLink(sub);
      if (missing > 0) {
        return {
          tone: "attention",
          sentence: `${plural(missing, "artist")} to link before the editor`,
          primary: { id: "panel", label: "Continue" },
        };
      }
      if (sub.duplicates.length > 0) {
        return {
          tone: "attention",
          sentence: `${host} may already have this release`,
          primary: { id: "panel", label: "Continue" },
        };
      }
      return {
        tone: "attention",
        sentence: "Ready to open the release editor",
        primary: { id: "editor", label: "Open the release editor" },
      };
    }
    case "returned": {
      // Only while the page is about the release it added; a later change of source ends the story.
      if (!p || p.releaseMbid !== sub.releaseMbid) return null;
      if (changes > 0 && (p.state === "draft" || p.state === "needs_review" || p.state === "approved")) {
        const ids = p.fields.some((f) => f.field.startsWith("musicbrainz_") && f.status !== "unchanged");
        return {
          tone: "attention",
          sentence: `Added to ${host} · ${plural(changes, "change")} to write${
            ids ? ", its MusicBrainz IDs among them" : ""
          }`,
          primary: { id: "write", label: `Write ${plural(changes, "change")}` },
        };
      }
      const pending = pendingFollowUps(sub);
      return pending.length
        ? {
          tone: "ok",
          sentence: `On ${host} · follow-ups: ${pending.join(", ")}`,
          primary: { id: "panel", label: "Follow-ups" },
        }
        : { tone: "ok", sentence: `On ${host} · follow-ups done`, primary: null };
    }
    default:
      return null;
  }
}

/** Follow-ups MusicBrainz does not have yet, as last looked up (D65); unknown ones count as pending. */
export function pendingFollowUps(sub: SubmissionDto): string[] {
  const f = sub.followUps;
  return [
    ...(f?.coverArtAdded === true ? [] : ["cover art"]),
    ...(f?.isrcs && f.isrcsAdded !== true ? ["ISRCs"] : []),
  ];
}

/** Open the follow-ups: look again when something is pending and the last look is over a minute old. */
export function shouldCheckFollowUps(sub: SubmissionDto, now: number): boolean {
  const f = sub.followUps;
  if (sub.state !== "returned" || !f || f.checking || pendingFollowUps(sub).length === 0) return false;
  return f.checkedAt === null || now - f.checkedAt > 60_000;
}
