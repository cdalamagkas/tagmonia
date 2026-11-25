/** The release page header's status sentence and next action, per state (D53). */
import { assertEquals } from "@std/assert";
import type {
  FieldProposalDto,
  HistoryResponse,
  IdentificationDto,
  JobDto,
  ProposalDto,
  ProposalResponse,
  SubmissionDto,
} from "../../shared/types.ts";
import { isLive } from "../../web/src/release/useRelease.ts";
import { changesToWrite, type ReleaseState, releaseStatus, sourceLine } from "../../web/src/release/status.ts";

const MBID = "f390ab14-095d-42aa-ade3-fbbafe093f9d";

function job(kind: string): JobDto {
  return {
    id: 1,
    kind,
    state: "running",
    progress: null,
    result: null,
    error: null,
    createdAt: 0,
    startedAt: 0,
    finishedAt: null,
  };
}

function ident(over: Partial<IdentificationDto> = {}): IdentificationDto {
  return {
    status: "matched",
    identifiedAt: 1,
    error: null,
    stale: false,
    matches: [{
      rank: 1,
      releaseMbid: MBID,
      releaseGroupMbid: null,
      score: 1,
      method: "existing_mbid",
      signals: { trackCount: 1, durations: 1, titles: 1, album: 1, artist: 1, fingerprint: null },
      coverage: 1,
      capped: false,
      identifierMatch: true,
      pinned: true,
      summary: {
        title: "Symphony no. 5",
        artist: "Karajan",
        date: "1978",
        country: "GB",
        labels: ["DG"],
        catalogNumbers: [],
        barcode: null,
        format: '12" Vinyl',
        trackCount: 4,
        status: "official",
      },
      mapping: { pairs: [], unmappedFiles: [], unmatchedTracks: [] },
    }],
    editions: [],
    thresholds: { auto: 0.92, review: 0.7 },
    job: null,
    ...over,
  } as IdentificationDto;
}

function field(over: Partial<FieldProposalDto> = {}): FieldProposalDto {
  return {
    id: 1,
    fileId: 1,
    field: "album",
    current: "Old",
    proposed: "New",
    edited: null,
    status: "changed",
    decision: "auto",
    locked: false,
    sources: [],
    origin: "musicbrainz",
    conflict: false,
    resolvedFrom: null,
    ...over,
  };
}

function proposal(over: Partial<ProposalDto> = {}): ProposalDto {
  return {
    id: 7,
    releaseMbid: MBID,
    sourceUrl: null,
    primarySource: "musicbrainz",
    mbServer: null,
    state: "needs_review",
    chosenBy: "auto",
    createdAt: 0,
    stale: false,
    counts: { changed: 1, added: 0, unchanged: 0, locked: 0, filled: 0, conflicts: 0 },
    unmappedFiles: [],
    fields: [field()],
    providers: [],
    cover: null,
    ...over,
  };
}

function state(
  over: {
    identification?: Partial<IdentificationDto>;
    proposal?: ProposalDto | null;
    response?: Partial<ProposalResponse>;
    history?: Partial<HistoryResponse>;
    submission?: SubmissionDto | null;
  } = {},
): ReleaseState {
  return {
    identification: ident(over.identification),
    proposal: {
      proposal: over.proposal === undefined ? proposal() : over.proposal,
      job: null,
      readOnly: false,
      locks: [],
      evidence: null,
      ...over.response,
    },
    history: { batches: [], job: null, ...over.history },
    submission: over.submission ?? null,
  };
}

const say = (s: ReleaseState) => {
  const r = releaseStatus(s);
  return [r.tone, r.sentence, r.primary?.id ?? null, r.primary?.label ?? null];
};

Deno.test("running work comes first, and keeps the page polling", () => {
  const writing = state({ history: { job: job("write") } });
  assertEquals(say(writing), ["busy", "Writing to the files…", null, null]);
  assertEquals(say(state({ history: { job: job("undo") } }))[1], "Undoing the last write…");
  assertEquals(say(state({ response: { job: job("propose") } }))[1], "Preparing the changes…");
  const identifying = state({ proposal: null, identification: { status: "identifying" } });
  assertEquals(say(identifying)[1], "Identifying on MusicBrainz…");
  assertEquals([isLive(writing), isLive(identifying), isLive(state())], [true, true, false]);
  // The bug this fixes: identification done, its automatic proposal queued: still live.
  assertEquals(isLive(state({ proposal: null, response: { job: job("propose") } })), true);
});

Deno.test("an open proposal: stale, then conflicts, then changes to write, else all right", () => {
  assertEquals(say(state({ proposal: proposal({ stale: true }) })), [
    "attention",
    "The files changed since these changes were prepared",
    "build",
    "Build again",
  ]);
  const conflicts = proposal({
    fields: [
      field({ fileId: 1, field: "title", conflict: true }),
      field({ fileId: 2, field: "title", conflict: true }),
    ],
    counts: { ...proposal().counts, conflicts: 2 },
  });
  assertEquals(say(state({ proposal: conflicts })).slice(1, 3), ["2 fields need your choice", "resolve"]);
  assertEquals(say(state()).slice(1), ["1 change ready", "write", "Write 1 change"]);
  // A disagreement on an album field is one choice, though every file has the row (as the Changes tab lists it).
  const albumConflict = proposal({
    fields: [1, 2, 3, 4, 5].map((fileId) => field({ fileId, field: "date", conflict: true })),
    counts: { ...proposal().counts, conflicts: 5 },
  });
  assertEquals(say(state({ proposal: albumConflict })).slice(1, 3), ["1 field needs your choice", "resolve"]);
  const none = proposal({ fields: [field({ status: "unchanged" })] });
  assertEquals(say(state({ proposal: none })), ["ok", "Everything is already right", null, null]);
});

Deno.test("the cover counts as a change, in the header as in the write (problem 4)", () => {
  const coverOnly = proposal({
    fields: [field({ status: "unchanged" })],
    cover: { writes: true } as ProposalDto["cover"],
  });
  assertEquals(changesToWrite(coverOnly), 1);
  assertEquals(say(state({ proposal: coverOnly })).slice(1), [
    "1 change ready: a new cover",
    "write",
    "Write 1 change",
  ]);
  // Kept and locked rows are not written; an edit of an unchanged row is.
  const mixed = proposal({
    fields: [
      field({ decision: "kept_current" }),
      field({ locked: true }),
      field({ status: "unchanged", decision: "edited", edited: "Mine" }),
    ],
  });
  assertEquals(changesToWrite(mixed), 1);
  // An album field written to five files is one change; a track field is one per track.
  const album = [1, 2, 3, 4, 5].map((fileId) => field({ fileId, field: "album" }));
  const titles = [1, 2, 3, 4, 5].map((fileId) => field({ fileId, field: "title" }));
  assertEquals(changesToWrite(proposal({ fields: [...album, ...titles] })), 6);
});

Deno.test("read-only mode offers the write, disabled with the reason", () => {
  const r = releaseStatus(state({ response: { readOnly: true } }));
  assertEquals([r.primary?.id, r.primary?.disabled], ["write", "Read-only mode: nothing is written"]);
});

Deno.test("written: when, with Undo while the write can be undone", () => {
  const batch = {
    id: 3,
    kind: "write" as const,
    undoable: true,
    finishedAt: 1_700_000_000_000,
  } as HistoryResponse["batches"][number];
  const r = releaseStatus(state({ proposal: proposal({ state: "written" }), history: { batches: [batch] } }));
  assertEquals([r.tone, r.sentence.startsWith("Written "), r.sentence.endsWith("· nothing left to change")], [
    "ok",
    true,
    true,
  ]);
  assertEquals(r.secondary.map((a) => a.id), ["undo"]);
  const readOnly = releaseStatus(state({
    proposal: proposal({ state: "written" }),
    history: { batches: [batch] },
    response: { readOnly: true },
  }));
  assertEquals(readOnly.secondary, [], "no undo in read-only mode");
});

Deno.test("a release from a provider link: Add to MusicBrainz follows, until MusicBrainz has it", () => {
  const fromDeezer = proposal({
    releaseMbid: null,
    sourceUrl: "https://www.deezer.com/album/1",
    primarySource: "deezer",
    fields: [field({ origin: "deezer" }), field({ origin: "itunes", field: "label" })],
  });
  const r = releaseStatus(state({ proposal: fromDeezer }));
  assertEquals([r.primary?.id, r.secondary.map((a) => a.id)], ["write", ["submission"]]);
  const allRight = releaseStatus(state({
    proposal: { ...fromDeezer, fields: [field({ status: "unchanged", origin: "deezer" })] },
  }));
  assertEquals(allRight.primary?.id, "submission", "nothing to write: adding to MusicBrainz is the next step");
  const returned = releaseStatus(state({ proposal: fromDeezer, submission: sub({ state: "returned" }) }));
  assertEquals(returned.secondary, []);
  const src = sourceLine(state({ proposal: fromDeezer }), (m) => m);
  assertEquals([src.label, src.url, src.details], [
    "Deezer album (not on MusicBrainz)",
    "https://www.deezer.com/album/1",
    ["filled from iTunes"],
  ]);
});

function sub(over: Partial<SubmissionDto> = {}): SubmissionDto {
  return {
    id: 3,
    candidateId: 1,
    proposalId: 7,
    server: "https://test.musicbrainz.org",
    state: "ready",
    duplicates: [],
    artists: [],
    releaseMbid: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
    followUps: null,
    ...over,
  };
}

Deno.test("a submission under way takes the status line (D52, PR 4)", () => {
  const fromDeezer = proposal({
    releaseMbid: null,
    sourceUrl: "https://www.deezer.com/album/1",
    primarySource: "deezer",
  });
  const at = (s: Partial<SubmissionDto>, p: ProposalDto = fromDeezer) => state({ proposal: p, submission: sub(s) });
  assertEquals(say(at({ state: "checking" })), ["busy", "Checking test.musicbrainz.org for this release…", null, null]);
  const artist = { name: "X", links: [], mbid: null, via: null, suggestions: [], createUrl: null, addLinksUrl: null };
  assertEquals(say(at({ artists: [artist, { ...artist, name: "Y" }] })), [
    "attention",
    "2 artists to link before the editor",
    "submission",
    "Continue",
  ]);
  const dup = { mbid: MBID, title: "T", artist: null, date: null, country: null, barcode: null, trackCount: null };
  assertEquals(
    say(at({ duplicates: [{ ...dup, reasons: ["barcode"] }] }))[1],
    "test.musicbrainz.org may already have this release",
  );
  const ready = releaseStatus(at({}));
  assertEquals(
    [ready.sentence, ready.primary?.id, ready.secondary.map((a) => a.id)],
    ["Ready to open the release editor", "editor", ["write"]],
    "the provider's changes can still be written meanwhile",
  );
  assertEquals(say(at({ state: "seeded" }))[1], "Waiting for you to submit on test.musicbrainz.org");
  assertEquals(say(at({ state: "verifying" }))[0], "busy");
  assertEquals(say(at({ state: "failed", error: "MusicBrainz is down" })), [
    "error",
    "MusicBrainz is down",
    "retry",
    "Try again",
  ]);
  assertEquals(say(at({ state: "abandoned" }))[2], "write", "a cancelled submission is history");
  // The source was changed to a MusicBrainz release meanwhile: the submission no longer applies.
  assertEquals(say(at({ state: "ready" }, proposal()))[2], "write");

  // Returned: Tagmonia proposes from the new release; writing its identifiers finishes the job.
  const NEW = "11111111-0000-4000-8000-000000000001";
  const fromNew = proposal({
    releaseMbid: NEW,
    mbServer: "https://test.musicbrainz.org",
    fields: [field({ field: "musicbrainz_albumid", current: null, proposed: NEW, status: "added" })],
  });
  const back = {
    state: "returned" as const,
    releaseMbid: NEW,
    followUps: { release: "r", addCoverArt: "c", isrcs: null },
  };
  assertEquals(say(at(back, fromNew)), [
    "attention",
    "Added to test.musicbrainz.org · 1 change to write, its MusicBrainz IDs among them",
    "write",
    "Write 1 change",
  ]);
  assertEquals(say(at(back, { ...fromNew, state: "written" })), [
    "ok",
    "On test.musicbrainz.org · follow-ups: cover art",
    "submission",
    "Follow-ups",
  ]);
  assertEquals(say(at(back, { ...fromNew, stale: true }))[2], "build", "a stale proposal comes first");
});

Deno.test("no proposal yet: identification decides the next action", () => {
  const noProposal = (identification: Partial<IdentificationDto>) => say(state({ proposal: null, identification }));
  assertEquals(noProposal({ status: "new" }).slice(1, 3), ["Not identified yet", "identify"]);
  assertEquals(noProposal({ status: "no_match", matches: [] }).slice(1, 4), [
    "Not on MusicBrainz as far as Tagmonia can tell",
    "match",
    "Paste an album link",
  ]);
  const editions = [1, 2, 3].map((i) => ({ releaseMbid: `e${i}` })) as IdentificationDto["editions"];
  assertEquals(noProposal({ status: "needs_review", editions }).slice(1, 3), [
    "3 releases fit; none is certain",
    "match",
  ]);
  assertEquals(
    noProposal({ status: "error", error: "MusicBrainz is down" })[1],
    "Identification failed: MusicBrainz is down",
  );
  assertEquals(noProposal({ status: "matched" }).slice(1, 3), ["Matched to Symphony no. 5", "prepare"]);
});

Deno.test("the source line: the release on MusicBrainz with its facts and the match, or the test server", () => {
  const s = sourceLine(state(), (m) => (m === "existing_mbid" ? "MusicBrainz ID in the tags" : m));
  assertEquals([s.label, s.url], ["MusicBrainz", `https://musicbrainz.org/release/${MBID}`]);
  assertEquals(s.details, ["Symphony no. 5", '12" Vinyl', "GB", "1978", "DG", "100% (MusicBrainz ID in the tags)"]);
  const test = sourceLine(state({ proposal: proposal({ mbServer: "https://test.musicbrainz.org" }) }), (m) => m);
  assertEquals([test.label, test.url], ["MusicBrainz (test server)", `https://test.musicbrainz.org/release/${MBID}`]);
  assertEquals(
    sourceLine(state({ proposal: null, identification: { matches: [] } }), (m) => m).label,
    "No source chosen yet",
  );
});
