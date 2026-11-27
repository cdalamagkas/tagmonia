/**
 * The Match tab (§8; docs/proposals/release-page-restructure.md, PR 3): where the tags come from and how
 * sure Tagmonia is, the track mapping reduced to what is off, the other releases, and one box for any
 * release link. The grouping is release/match.ts.
 */
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type {
  EditionDto,
  EditionSummary,
  EvidenceLinkDto,
  IdentificationDto,
  LibraryFileDto,
  MatchDto,
  ProposalDto,
  SearchTerms,
  SignalName,
} from "../../../shared/types.ts";
import { api } from "../api.ts";
import { METHOD_LABELS, percent, SIGNAL_LABELS, statusOf, when } from "../format.ts";
import { classifyLink, GOOD_FIT, type MappingView, matchView } from "../release/match.ts";
import { sourceName } from "../release/status.ts";

const MB_RELEASE = "https://musicbrainz.org/release/";
const SIGNALS: SignalName[] = ["trackCount", "durations", "titles", "album", "artist", "fingerprint"];

/** MusicBrainz writes "[none]" for releases without a catalog number. */
function catnos(list: string[]): string {
  return list.filter((c) => c.toLowerCase() !== "[none]").join(", ") || "–";
}

export function StatusBadge({ status }: { status: string }) {
  const s = statusOf(status);
  return <span class={`tm-badge tm-inline${s.tone ? ` tm-badge-${s.tone}` : ""}`}>{s.label}</span>;
}

function MbLink({ mbid, server, children }: { mbid: string; server?: string; children: ComponentChildren }) {
  const base = server ? `${server}/release/` : MB_RELEASE;
  return <a href={base + mbid} target="_blank" rel="noopener noreferrer">{children}</a>;
}

function facts(s: EditionSummary): string {
  return [
    s.format,
    s.country,
    s.date,
    s.labels.join(", "),
    catnos(s.catalogNumbers) === "–" ? null : catnos(s.catalogNumbers),
    s.barcode ? `barcode ${s.barcode}` : null,
    `${s.trackCount} tracks`,
  ].filter(Boolean).join(" · ");
}

/** The score line: how well the release fits and how it was found; whether the files name it. */
function ScoreLine({ m, thresholds }: { m: MatchDto; thresholds: IdentificationDto["thresholds"] }) {
  return (
    <p>
      Fits <strong>{percent(m.score)}</strong>{" "}
      <span class="tm-muted">
        (found by {METHOD_LABELS[m.method]}; automatic from {percent(thresholds.auto)})
      </span>{" "}
      {m.pinned && (
        <span class="tm-badge tm-badge-ok tm-inline">
          {m.method === "manual" ? "chosen by you" : "the files name this release"}
        </span>
      )}
      {m.capped && (
        <span class="tm-badge tm-badge-warn tm-inline" title="Too little evidence for an automatic match">
          held for review: too little evidence
        </span>
      )}
    </p>
  );
}

/** "Why this release": the signals behind the score, folded unless the match is uncertain. */
function Evidence({ m, open }: { m: MatchDto; open: boolean }) {
  return (
    <details class="tm-fold" open={open}>
      <summary>Why this release</summary>
      <table class="tm-table tm-kv">
        <tbody>
          {SIGNALS.map((k) => (
            <tr key={k}>
              <th>{SIGNAL_LABELS[k]}</th>
              <td>
                {m.signals[k] === null
                  ? <span class="tm-muted">no evidence (not counted)</span>
                  : percent(m.signals[k])}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/** The track mapping (§8.3): one line when every file fits; otherwise only what is off, with the rest folded. */
function Mapping({ view, m, files }: { view: MappingView; m: MatchDto; files: LibraryFileDto[] }) {
  const byId = new Map(files.map((f) => [f.id, f]));
  const multiDisc = new Set(m.mapping.pairs.map((p) => p.medium)).size > 1 ||
    new Set(m.mapping.unmatchedTracks.map((t) => t.medium)).size > 1;
  const pos = (medium: number, position: number) => (multiDisc ? `${medium}-${position}` : String(position));
  const name = (id: number) => {
    const f = byId.get(id);
    return f ? (f.tags.title ?? f.path.split("/").pop()) : `file ${id}`;
  };
  const all = [...m.mapping.pairs].sort((a, b) => a.medium - b.medium || a.position - b.position);
  const table = (pairs: typeof all) => (
    <div class="tm-table-wrap">
      <table class="tm-table">
        <thead>
          <tr>
            <th class="tm-num tm-col-narrow">Track</th>
            <th>File</th>
            <th class="tm-num">Fit</th>
          </tr>
        </thead>
        <tbody>
          {pairs.map((p) => (
            <tr key={p.fileId}>
              <td class="tm-num tm-col-narrow">{pos(p.medium, p.position)}</td>
              <td>{name(p.fileId)}</td>
              <td class="tm-num">{percent(1 - p.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <section class="tm-card">
      <h2>Track mapping</h2>
      {view.allGood ? <p>All {view.files} files map one to one onto the release's tracks.</p> : (
        <>
          {view.weak.length > 0 && (
            <>
              <p>
                <span class="tm-badge tm-badge-warn tm-inline">weak fit</span> {view.weak.length}{" "}
                file{view.weak.length === 1 ? "" : "s"} fit{view.weak.length === 1 ? "s" : ""}{" "}
                {view.weak.length === 1 ? "its" : "their"} track less than {percent(GOOD_FIT)}:
              </p>
              {table(view.weak)}
            </>
          )}
          {view.unmappedFiles.length > 0 && (
            <p>
              <span class="tm-badge tm-badge-warn tm-inline">not on this release</span>{" "}
              {view.unmappedFiles.map(name).join(", ")} <span class="tm-muted">(left untouched)</span>
            </p>
          )}
          {view.unmatchedTracks.length > 0 && (
            <p>
              <span class="tm-badge tm-inline">missing from the folder</span>{" "}
              {view.unmatchedTracks.map((t) => `${pos(t.medium, t.position)}. ${t.title}`).join(", ")}
            </p>
          )}
        </>
      )}
      {all.length > 0 && (
        <details class="tm-fold">
          <summary>Show every file and its track</summary>
          {table(all)}
        </details>
      )}
    </section>
  );
}

/** One box for any release: a MusicBrainz release, or a Deezer, iTunes, Discogs or Bandcamp album. */
function LinkBox(
  { busy, onMusicBrainz, onProvider, onYouTube }: {
    busy: boolean;
    onMusicBrainz: (mbid: string) => Promise<void>;
    onProvider: (url: string) => Promise<void>;
    onYouTube: (url: string) => Promise<void>;
  },
) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const submit = async () => {
    const link = classifyLink(text);
    if (link.kind === "invalid") return setError(link.message);
    setError(null);
    setWorking(true);
    try {
      if (link.kind === "musicbrainz") await onMusicBrainz(link.mbid);
      else if (link.kind === "youtube") await onYouTube(link.url);
      else await onProvider(link.url);
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  return (
    <form
      class="tm-manual"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) submit();
      }}
    >
      <label>
        Use another release
        <input
          id="tm-link-box"
          type="text"
          inputMode="url"
          placeholder="A MusicBrainz release, a Deezer, iTunes, Discogs or Bandcamp album, or a YouTube playlist"
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
          disabled={busy || working}
        />
      </label>
      <button type="submit" class="tm-button tm-secondary" disabled={busy || working || !text.trim()}>
        Use this link
      </button>
      {error && <p class="tm-error" role="alert">{error}</p>}
    </form>
  );
}

/**
 * Search terms (D63): for files whose tags are too thin to find them. They replace the files' album, artist
 * and (for one file) title when MusicBrainz is searched; when nothing fits, they can become the tags.
 */
function SearchTermsForm(
  { terms, files, busy, nothingFits, usedAsTags, onSearch, onClear, onUseAsTags }: {
    terms: SearchTerms | null;
    files: LibraryFileDto[];
    busy: boolean;
    /** Identification with the terms found nothing good enough. */
    nothingFits: boolean;
    /** The current proposal already comes from the terms. */
    usedAsTags: boolean;
    onSearch: (t: SearchTerms) => Promise<void>;
    onClear: () => Promise<void>;
    onUseAsTags: () => Promise<void>;
  },
) {
  const single = files.length === 1;
  const first = files[0]?.tags;
  const [artist, setArtist] = useState(terms?.artist ?? first?.albumartist ?? first?.artist ?? "");
  const [album, setAlbum] = useState(terms?.album ?? first?.album ?? "");
  const [title, setTitle] = useState(terms?.title ?? (single ? first?.title ?? "" : ""));
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const act = async (fn: () => Promise<void>) => {
    setError(null);
    setWorking(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const off = busy || working;
  const typed = !!(artist.trim() || album.trim() || (single && title.trim()));
  return (
    <details class="tm-fold tm-terms" open={!!terms || nothingFits}>
      <summary>Search with your own terms</summary>
      <p class="tm-muted tm-section-note">
        For files with few or no tags: type what you know (found elsewhere, for example) and MusicBrainz is searched
        again with it. Nothing is written.
      </p>
      <form
        class="tm-manual"
        onSubmit={(e) => {
          e.preventDefault();
          if (!typed) return;
          act(() =>
            onSearch({
              ...(artist.trim() ? { artist: artist.trim() } : {}),
              ...(album.trim() ? { album: album.trim() } : {}),
              ...(single && title.trim() ? { title: title.trim() } : {}),
            })
          );
        }}
      >
        <label>
          Artist
          <input
            type="text"
            maxLength={200}
            value={artist}
            disabled={off}
            onInput={(e) => setArtist(e.currentTarget.value)}
          />
        </label>
        <label>
          Album
          <input
            type="text"
            maxLength={200}
            value={album}
            disabled={off}
            onInput={(e) => setAlbum(e.currentTarget.value)}
          />
        </label>
        {single && (
          <label>
            Track title
            <input
              type="text"
              maxLength={200}
              value={title}
              disabled={off}
              onInput={(e) => setTitle(e.currentTarget.value)}
            />
          </label>
        )}
        <button type="submit" class="tm-button tm-secondary" disabled={off || !typed}>Search MusicBrainz</button>
        {error && <p class="tm-error" role="alert">{error}</p>}
      </form>
      {terms && (
        <p class="tm-terms-after">
          {!usedAsTags && (
            nothingFits
              ? (
                <>
                  <span>MusicBrainz has nothing that fits these terms.</span>{" "}
                  <button type="button" class="tm-button tm-small" disabled={off} onClick={() => act(onUseAsTags)}>
                    Use them as tags
                  </button>
                </>
              )
              : (
                <button type="button" class="tm-linklike tm-small-link" disabled={off} onClick={() => act(onUseAsTags)}>
                  None of these fit? Use your terms as tags
                </button>
              )
          )}
          {usedAsTags && <span class="tm-muted">The Changes tab holds your terms as tags.</span>}
          {" · "}
          <button type="button" class="tm-linklike tm-small-link" disabled={off} onClick={() => act(onClear)}>
            Forget these terms
          </button>
        </p>
      )}
    </details>
  );
}

/** The release's YouTube link (§9.5, D55): evidence for the date and label, never the source of the tags. */
function EvidenceLine(
  { evidence, hasProposal, busy, onRemove }: {
    evidence: EvidenceLinkDto;
    hasProposal: boolean;
    busy: boolean;
    onRemove: () => void;
  },
) {
  const what = evidence.url.includes("/playlist?") ? "YouTube playlist" : "YouTube video";
  return (
    <p class="tm-section-note">
      <span class="tm-muted">Evidence:</span>{" "}
      <a href={evidence.url} target="_blank" rel="noopener noreferrer">{what}</a>{" "}
      <span class="tm-muted">
        {hasProposal
          ? "fills the release date and label where nothing else has them; see Changes."
          : "used once the tags are proposed."}
      </span>{" "}
      <button type="button" class="tm-linklike tm-small-link" disabled={busy} onClick={onRemove}>remove</button>
    </p>
  );
}

/** "Use this": builds the proposal from that release (§10); the page shows it in the review panel. */
function UseButton({ mbid, onChoose }: { mbid: string; onChoose?: (mbid: string) => void }) {
  if (!onChoose) return null;
  return (
    <button type="button" class="tm-button tm-secondary tm-small" onClick={() => onChoose(mbid)}>
      Use this
    </button>
  );
}

function Candidates({ matches, onChoose }: { matches: MatchDto[]; onChoose?: (mbid: string) => void }) {
  return (
    <div class="tm-table-wrap">
      <table class="tm-table">
        <thead>
          <tr>
            <th class="tm-num">Score</th>
            <th>Release</th>
            <th>Format</th>
            <th>Country</th>
            <th>Date</th>
            <th class="tm-num">Tracks</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {matches.map((m) => (
            <tr key={m.releaseMbid}>
              <td class="tm-num">{percent(m.score)}</td>
              <td>
                <MbLink mbid={m.releaseMbid}>{m.summary.title}</MbLink>
                <span class="tm-muted">{` — ${m.summary.artist}`}</span>
              </td>
              <td>{m.summary.format}</td>
              <td>{m.summary.country ?? "–"}</td>
              <td>{m.summary.date ?? "–"}</td>
              <td class="tm-num">{m.summary.trackCount}</td>
              <td>
                <UseButton mbid={m.releaseMbid} onChoose={onChoose} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** §8.2: editions side by side, so a collector can tell their pressing from the others. */
function EditionPicker(
  { editions, onChoose }: { editions: EditionDto[]; onChoose?: (mbid: string) => void },
) {
  return (
    <div class="tm-table-wrap">
      <table class="tm-table">
        <thead>
          <tr>
            <th class="tm-num">Score</th>
            <th>Country</th>
            <th>Date</th>
            <th>Label</th>
            <th>Catalog no.</th>
            <th>Barcode</th>
            <th>Format</th>
            <th class="tm-num">Tracks</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {editions.map((e) => (
            <tr key={e.releaseMbid}>
              <td class="tm-num">
                {e.examined
                  ? percent(e.score)
                  : <span class="tm-muted" title="Found in the release group, not scored">–</span>}
              </td>
              <td>{e.summary.country ?? "–"}</td>
              <td>{e.summary.date ?? "–"}</td>
              <td>{e.summary.labels.join(", ") || "–"}</td>
              <td>{catnos(e.summary.catalogNumbers)}</td>
              <td class="tm-path">{e.summary.barcode ?? "–"}</td>
              <td>{e.summary.format || "–"}</td>
              <td class="tm-num">{e.summary.trackCount}</td>
              <td>
                <MbLink mbid={e.releaseMbid}>MusicBrainz ↗</MbLink>{" "}
                <UseButton mbid={e.releaseMbid} onChoose={onChoose} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function nothingYet(d: IdentificationDto, busy: boolean): string {
  if (busy || d.status === "identifying") return "Identifying on MusicBrainz…";
  if (d.status === "new" || d.status === "changed") return "Not identified yet; identification runs after each scan.";
  if (d.status === "error") return `Identification failed: ${d.error ?? "unknown error"}`;
  return "No release on MusicBrainz fits these files well enough.";
}

export function Identification(
  { releaseId, data, proposal, evidence, files, onReload, onChoose, onChooseProvider }: {
    releaseId: number;
    /** Loaded and kept live by the release page (D53). */
    data: IdentificationDto;
    proposal: ProposalDto | null;
    /** The release's YouTube link, if any (§9.5, D55). */
    evidence: EvidenceLinkDto | null;
    files: LibraryFileDto[];
    onReload: () => Promise<void>;
    /** Builds a proposal from a MusicBrainz release; rejects with the server's message (e.g. busy). */
    onChoose: (mbid: string) => Promise<void>;
    /** Builds a proposal from a provider album link, for a release not on MusicBrainz (§10.4). */
    onChooseProvider: (url: string) => Promise<void>;
  },
) {
  const [error, setError] = useState<string | null>(null);
  // MusicBrainz's 1 request per second makes identification take a few seconds; the page polls meanwhile.
  const busy = !!data.job || data.status === "identifying";
  const v = matchView(data, proposal);

  const run = (fn: () => Promise<unknown>) => {
    setError(null);
    return fn().then(() => onReload(), (e) => setError((e as Error).message));
  };
  const choose = (mbid: string) => run(() => onChoose(mbid));
  /**
   * A pasted MusicBrainz release is the user's choice: propose from it at once, and identify against it,
   * so its evidence and track mapping show here too.
   */
  const chooseLink = async (mbid: string) => {
    await onChoose(mbid);
    await api.identify(releaseId, { releaseUrl: mbid }).catch(() => {});
    await onReload();
  };

  const best = data.matches[0] ?? null;
  const subject = v.subject;
  const summary = v.source.kind === "musicbrainz"
    ? (v.source.match?.summary ?? v.source.edition?.summary)
    : subject?.summary;
  const alternatives = (v.editions.length > 0 || v.others.length > 0) && (
    <>
      {v.editions.length > 0 && (
        <>
          <h3>Same album, other editions</h3>
          <p class="tm-muted tm-section-note">
            {subject?.pinned
              ? "The files name the release above; its other editions are listed for comparison."
              : "Nothing in the files tells these editions apart: compare your copy's country, label, catalog number or barcode."}
          </p>
          <EditionPicker editions={v.editions} onChoose={choose} />
        </>
      )}
      {v.others.length > 0 && (
        <>
          <h3>Other releases</h3>
          <Candidates matches={v.others} onChoose={choose} />
        </>
      )}
    </>
  );

  return (
    <>
      {error && <p class="tm-error" role="alert">{error}</p>}
      <section class="tm-card">
        <div class="tm-toolbar">
          <div>
            <h2>Where the tags come from</h2>
            <p class="tm-muted tm-section-note">
              {busy ? "Identifying…" : data.identifiedAt ? `Identified ${when(data.identifiedAt)}` : "Never identified"}
              {data.stale && (
                <>
                  {" · "}
                  <span class="tm-badge tm-badge-warn tm-inline">files changed since</span>
                </>
              )}
            </p>
          </div>
          <div class="tm-actions">
            <button
              type="button"
              class="tm-button tm-secondary"
              onClick={() => run(() => api.identify(releaseId, {}))}
              disabled={busy}
            >
              {busy ? "Identifying…" : "Identify again"}
            </button>
          </div>
        </div>

        {v.source.kind === "provider" && (
          <>
            <h3>
              <a href={v.source.url} target="_blank" rel="noopener noreferrer">{sourceName(v.source.url)} album</a>{" "}
              <span class="tm-badge tm-badge-warn tm-inline">not on MusicBrainz</span>
            </h3>
            <p class="tm-muted">
              The tags come from this album, filled in from the same release on the other providers; see Changes.
            </p>
          </>
        )}

        {v.source.kind === "terms" && (
          <>
            <h3>
              Your search terms <span class="tm-badge tm-badge-warn tm-inline">not on MusicBrainz</span>
            </h3>
            <p class="tm-muted">The tags come from what you typed; see Changes.</p>
          </>
        )}

        {v.source.kind === "musicbrainz" && (
          <>
            <h3>
              <MbLink mbid={v.source.mbid} server={v.source.server}>
                {summary?.title ?? "This MusicBrainz release"}
              </MbLink>
              {summary && <span class="tm-muted">{` — ${summary.artist}`}</span>}{" "}
              {v.source.server !== "https://musicbrainz.org" && (
                <span class="tm-badge tm-badge-warn tm-inline">{new URL(v.source.server).host}</span>
              )}
            </h3>
            {summary && <p class="tm-muted tm-section-note">{facts(summary)}</p>}
            <p class="tm-muted">{v.source.chosenBy === "user" ? "Chosen by you." : "Matched automatically."}</p>
            {subject && <ScoreLine m={subject} thresholds={data.thresholds} />}
            {subject && <Evidence m={subject} open={v.uncertain} />}
          </>
        )}

        {v.source.kind === "none" && (
          subject
            ? (
              <>
                <h3>
                  <span class="tm-muted">Best match:</span>{" "}
                  <MbLink mbid={subject.releaseMbid}>{subject.summary.title}</MbLink>
                  <span class="tm-muted">{` — ${subject.summary.artist}`}</span>
                </h3>
                <p class="tm-muted tm-section-note">{facts(subject.summary)}</p>
                <ScoreLine m={subject} thresholds={data.thresholds} />
                <p>
                  <button type="button" class="tm-button" onClick={() => choose(subject.releaseMbid)}>
                    Use this release
                  </button>
                </p>
                <Evidence m={subject} open={v.uncertain} />
              </>
            )
            : <p class="tm-muted">{nothingYet(data, busy)}</p>
        )}

        {evidence && (
          <EvidenceLine
            evidence={evidence}
            hasProposal={!!proposal}
            busy={busy}
            onRemove={() => run(() => api.removeEvidence(releaseId))}
          />
        )}
        <SearchTermsForm
          key={JSON.stringify(data.searchTerms)}
          terms={data.searchTerms}
          files={files}
          busy={busy}
          nothingFits={!busy && data.status === "no_match"}
          usedAsTags={v.source.kind === "terms"}
          onSearch={async (t) => {
            await api.setSearchTerms(releaseId, t);
            await onReload();
          }}
          onClear={async () => {
            await api.clearSearchTerms(releaseId);
            await onReload();
          }}
          onUseAsTags={async () => {
            await api.propose(releaseId, { fromSearchTerms: true });
            await onReload();
          }}
        />
        <LinkBox
          busy={busy}
          onMusicBrainz={chooseLink}
          onProvider={(url) => onChooseProvider(url)}
          onYouTube={async (url) => {
            await api.setEvidence(releaseId, url);
            await onReload();
          }}
        />
      </section>

      {subject && v.mapping && <Mapping view={v.mapping} m={subject} files={files} />}

      {alternatives && (
        v.source.kind === "provider" || (v.source.kind === "none" && !subject)
          ? (
            <section class="tm-card">
              <details class="tm-fold">
                <summary>
                  MusicBrainz searched: nothing close{best ? ` (best ${percent(best.score)})` : ""}
                </summary>
                {alternatives}
              </details>
            </section>
          )
          : <section class="tm-card">{alternatives}</section>
      )}
    </>
  );
}
