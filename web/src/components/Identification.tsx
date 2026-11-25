/**
 * Identification results for one release (§8): the best MusicBrainz match with
 * its evidence, the other candidates, the edition picker (§8.2) and how the
 * files map onto the tracks (§8.3). Read-only: choosing a release and writing
 * tags is the review step.
 */
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { EditionDto, IdentificationDto, LibraryFileDto, MatchDto, SignalName } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { METHOD_LABELS, percent, SIGNAL_LABELS, statusOf, when } from "../format.ts";

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

function MbLink({ mbid, children }: { mbid: string; children: ComponentChildren }) {
  return <a href={MB_RELEASE + mbid} target="_blank" rel="noopener noreferrer">{children}</a>;
}

function BestMatch({ m, thresholds }: { m: MatchDto; thresholds: IdentificationDto["thresholds"] }) {
  const s = m.summary;
  return (
    <>
      <h3>
        <MbLink mbid={m.releaseMbid}>{s.title}</MbLink> <span class="tm-muted">— {s.artist}</span>
      </h3>
      <p class="tm-muted tm-section-note">
        {[s.format, s.country, s.date, s.labels.join(", "), catnos(s.catalogNumbers)].filter((x) => x && x !== "–")
          .join(" · ")}
      </p>
      <p>
        Score <strong>{percent(m.score)}</strong> (auto-match at {percent(thresholds.auto)}, found by{" "}
        {METHOD_LABELS[m.method]})
        {m.pinned && (
          <span class="tm-badge tm-badge-ok">
            {m.method === "manual" ? "chosen by you" : "the files name this release"}
          </span>
        )}
        {m.capped && (
          <span class="tm-badge tm-badge-warn" title="Too little evidence for an automatic match">
            held for review: too little evidence
          </span>
        )}
      </p>
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
    </>
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
          {matches.map((m, i) => (
            <tr key={m.releaseMbid} class={i === 0 ? "tm-best" : ""}>
              <td class="tm-num">{percent(m.score)}</td>
              <td>
                <MbLink mbid={m.releaseMbid}>{m.summary.title}</MbLink>
                <span class="tm-muted">— {m.summary.artist}</span>
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
  { editions, best, onChoose }: { editions: EditionDto[]; best: string; onChoose?: (mbid: string) => void },
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
            <tr key={e.releaseMbid} class={e.releaseMbid === best ? "tm-best" : ""}>
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

/** §8.3: which file became which track; unmapped files and unmatched tracks are listed, never forced. */
function TrackMapping({ m, files }: { m: MatchDto; files: LibraryFileDto[] }) {
  const byId = new Map(files.map((f) => [f.id, f]));
  const multiDisc = new Set(m.mapping.pairs.map((p) => p.medium)).size > 1 ||
    new Set(m.mapping.unmatchedTracks.map((t) => t.medium)).size > 1;
  const pos = (medium: number, position: number) => (multiDisc ? `${medium}-${position}` : String(position));
  const name = (id: number) => {
    const f = byId.get(id);
    return f ? (f.tags.title ?? f.path.split("/").pop()) : `file ${id}`;
  };
  const pairs = [...m.mapping.pairs].sort((a, b) => a.medium - b.medium || a.position - b.position);
  return (
    <>
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
      {m.mapping.unmappedFiles.length > 0 && (
        <p>
          <span class="tm-badge tm-badge-warn">not on this release</span> {m.mapping.unmappedFiles.map(name).join(", ")}
        </p>
      )}
      {m.mapping.unmatchedTracks.length > 0 && (
        <p>
          <span class="tm-badge tm-badge-warn">missing from the folder</span>{" "}
          {m.mapping.unmatchedTracks.map((t) => `${pos(t.medium, t.position)}. ${t.title}`).join(", ")}
        </p>
      )}
    </>
  );
}

function emptyMessage(d: IdentificationDto): string {
  if (d.status === "new" || d.status === "changed") return "Not identified yet; identification runs after each scan.";
  if (d.status === "identifying") return "Identifying…";
  if (d.status === "error") return `Identification failed: ${d.error ?? "unknown error"}`;
  return "No release on MusicBrainz fits these files well enough.";
}

export function Identification(
  { releaseId, data, files, onReload, onChoose, onChooseProvider }: {
    releaseId: number;
    /** Loaded and kept live by the release page (D53). */
    data: IdentificationDto;
    files: LibraryFileDto[];
    onReload: () => Promise<void>;
    /** Builds a proposal from the chosen release; rejects with the server's message (e.g. busy). */
    onChoose?: (mbid: string) => Promise<void>;
    /** Builds a proposal from a provider album link, for a release not on MusicBrainz (§10.4). */
    onChooseProvider?: (url: string) => Promise<void>;
  },
) {
  const [error, setError] = useState<string | null>(null);
  const load = onReload;
  // MusicBrainz's 1 request per second makes identification take a few seconds; the page polls meanwhile.
  const busy = !!data.job || data.status === "identifying";

  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);

  const identify = async (releaseUrl?: string) => {
    setUrlError(null);
    try {
      await api.identify(releaseId, releaseUrl ? { releaseUrl } : {});
      if (releaseUrl) setUrl("");
      await load();
    } catch (e) {
      // Bad links and busy releases are the user's to fix; keep the rest of the panel.
      if (releaseUrl) setUrlError((e as Error).message);
      else setError((e as Error).message);
    }
  };

  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const fromProvider = async () => {
    if (!onChooseProvider) return;
    setSourceError(null);
    setSourceBusy(true);
    try {
      await onChooseProvider(sourceUrl.trim());
      setSourceUrl("");
    } catch (e) {
      setSourceError((e as Error).message);
    } finally {
      setSourceBusy(false);
    }
  };

  const [chooseError, setChooseError] = useState<string | null>(null);
  const choose = onChoose &&
    ((mbid: string) => {
      setChooseError(null);
      onChoose(mbid).catch((e) => setChooseError((e as Error).message));
    });

  const best = data.matches[0];
  const others = data.matches.slice(0, 5);
  return (
    <>
      {error && <p class="tm-error" role="alert">{error}</p>}
      <section class="tm-card">
        <div class="tm-toolbar">
          <div>
            <h2>
              MusicBrainz match <StatusBadge status={busy ? "identifying" : data.status} />
            </h2>
            <p class="tm-muted tm-section-note">
              {data.identifiedAt ? `Identified ${when(data.identifiedAt)}` : "Never identified"}
              {data.stale && (
                <>
                  {" · "}
                  <span class="tm-badge tm-badge-warn tm-inline">files changed since</span>
                </>
              )}
            </p>
          </div>
          <div class="tm-actions">
            <button type="button" class="tm-button tm-secondary" onClick={() => identify()} disabled={busy}>
              {busy ? "Identifying…" : "Identify again"}
            </button>
          </div>
        </div>
        {best ? <BestMatch m={best} thresholds={data.thresholds} /> : <p class="tm-muted">{emptyMessage(data)}</p>}
        <form
          class="tm-manual"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) identify(url.trim());
          }}
        >
          <label>
            Use a specific release
            <input
              type="url"
              placeholder="https://musicbrainz.org/release/…"
              value={url}
              onInput={(e) => setUrl(e.currentTarget.value)}
              disabled={busy}
            />
          </label>
          <button type="submit" class="tm-button tm-secondary" disabled={busy || !url.trim()}>Use this release</button>
          {urlError && <p class="tm-error" role="alert">{urlError}</p>}
        </form>
        {onChooseProvider && (
          <form
            class="tm-manual"
            onSubmit={(e) => {
              e.preventDefault();
              if (sourceUrl.trim()) fromProvider();
            }}
          >
            <label>
              Not on MusicBrainz? Build the tags from an album page
              <input
                type="url"
                placeholder="https://www.deezer.com/album/… · iTunes · Discogs · Bandcamp"
                value={sourceUrl}
                onInput={(e) => setSourceUrl(e.currentTarget.value)}
                disabled={sourceBusy}
              />
            </label>
            <button type="submit" class="tm-button tm-secondary" disabled={sourceBusy || !sourceUrl.trim()}>
              Use this album
            </button>
            {sourceError && <p class="tm-error" role="alert">{sourceError}</p>}
          </form>
        )}
      </section>

      {data.editions.length > 1 && (
        <section class="tm-card">
          <h2>Editions</h2>
          <p class="tm-muted tm-section-note">
            {best.pinned
              ? "The files name the highlighted release; the album's other editions are listed for comparison."
              : `${data.editions.length} releases of this album fit the files and nothing in them tells the editions apart: compare your copy's country, label, catalog number or barcode.`}
          </p>
          {chooseError && <p class="tm-error" role="alert">{chooseError}</p>}
          <EditionPicker editions={data.editions} best={best.releaseMbid} onChoose={choose} />
        </section>
      )}

      {others.length > 1 && (
        <section class="tm-card">
          <h2>Candidates</h2>
          {chooseError && data.editions.length <= 1 && <p class="tm-error" role="alert">{chooseError}</p>}
          <Candidates matches={others} onChoose={choose} />
        </section>
      )}

      {best && (
        <section class="tm-card">
          <h2>Track mapping</h2>
          <TrackMapping m={best} files={files} />
        </section>
      )}
    </>
  );
}
