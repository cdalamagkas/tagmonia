/**
 * Adding a release that MusicBrainz lacks (§12, D52), as a step panel launched from the release page's
 * header (D53, PR 4): check for duplicates and artists, open MusicBrainz's release editor pre-filled in a
 * new tab, and follow up once MusicBrainz sends the new release back. The user reviews and submits on
 * MusicBrainz, from their own account; Tagmonia never submits anything.
 */
import { useEffect, useState } from "preact/hooks";
import type { ProposalDto, SubmissionArtistDto, SubmissionDto } from "../../../shared/types.ts";
import { api } from "../api.ts";
import {
  activeSubmission,
  artistRow,
  artistsToLink,
  serverHost,
  shouldCheckFollowUps,
  STEPS,
  type StepsView,
  stepsView,
  TEST_SERVER,
} from "../release/submission.ts";

/**
 * Posts the seed to the release editor in a new tab. The tab is opened before the
 * request, while the click still counts as the user's, so it is not blocked as a pop-up.
 */
export async function openEditor(id: number): Promise<void> {
  const tab = globalThis.open("", "tagmonia-mb-editor");
  try {
    const { action, fields } = await api.openSubmission(id);
    // The editor tab must not reach back into Tagmonia.
    if (tab) tab.opener = null;
    const form = document.createElement("form");
    form.method = "POST";
    form.action = action;
    form.target = "tagmonia-mb-editor";
    form.acceptCharset = "UTF-8";
    for (const [name, value] of Object.entries(fields)) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
    form.remove();
  } catch (e) {
    tab?.close();
    throw e;
  }
}

/**
 * §12.3: the editor links an artist only by MBID. One row per credited artist, in one format:
 * name — status — link to the artist — one action, the action following the status.
 */
function ArtistLine(
  { a, server, busy, onChoose }: {
    a: SubmissionArtistDto;
    server: string;
    busy: boolean;
    onChoose: (name: string, artist: string | null) => void;
  },
) {
  const row = artistRow(a, server);
  return (
    <li class="tm-artist-row">
      <strong>{row.name}</strong>
      <span class={`tm-badge tm-inline ${row.ok ? "tm-badge-ok" : "tm-badge-warn"}`}>{row.label}</span>
      {row.url && <a href={row.url} target="_blank" rel="noopener noreferrer">on {serverHost(server)}</a>}
      {row.status === "chosen" && (
        <button
          type="button"
          class="tm-linklike tm-small-link"
          disabled={busy}
          onClick={() => onChoose(a.name, null)}
        >
          undo
        </button>
      )}
      {row.status === "name" && (
        <button
          type="button"
          class="tm-linklike tm-small-link"
          disabled={busy}
          onClick={() => onChoose(a.name, "none")}
        >
          not this artist
        </button>
      )}
      {a.addLinksUrl && (
        <a class="tm-small-link" href={a.addLinksUrl} target="_blank" rel="noopener noreferrer">
          add its {a.links.length === 1 ? "provider page" : "provider pages"}
        </a>
      )}
      {!row.ok && (
        <div class="tm-artist-fix">
          {a.suggestions.map((g) => (
            <div key={g.mbid}>
              <a href={`${server}/artist/${g.mbid}`} target="_blank" rel="noopener noreferrer">{g.name}</a>
              {(g.disambiguation || g.country) && (
                <span class="tm-muted">{` (${[g.disambiguation, g.country].filter(Boolean).join(", ")})`}</span>
              )}{" "}
              <button
                type="button"
                class="tm-button tm-secondary tm-small"
                disabled={busy}
                onClick={() => onChoose(a.name, g.mbid)}
              >
                Use this artist
              </button>
            </div>
          ))}
          <details class="tm-fold" open={a.suggestions.length === 0}>
            <summary>
              {a.suggestions.length > 0 ? "None of these?" : `Add it, or paste its ${serverHost(server)} link`}
            </summary>
            <PasteArtist server={server} busy={busy} onUse={(link) => onChoose(a.name, link)} />
            {a.createUrl && (
              <p class="tm-small-note">
                <a href={a.createUrl} target="_blank" rel="noopener noreferrer">
                  Add this artist on {serverHost(server)}
                </a>{" "}
                <span class="tm-muted">(the form is filled in with its provider pages)</span>
              </p>
            )}
          </details>
        </div>
      )}
    </li>
  );
}

function Artists(
  { s, busy, skipped, onChoose }: {
    s: SubmissionDto;
    busy: boolean;
    skipped: boolean;
    onChoose: (name: string, artist: string | null) => void;
  },
) {
  if (s.artists.length === 0) return null;
  if (skipped) {
    return (
      <p class="tm-step-line">
        <strong>Artists:</strong> {s.artists.map((a, i) => (
          <>
            {i > 0 && ", "}
            <a href={`${s.server}/artist/${a.mbid}`} target="_blank" rel="noopener noreferrer">{a.name}</a>
          </>
        ))} <span class="tm-muted">found on {serverHost(s.server)} by their provider pages</span>
      </p>
    );
  }
  const missing = artistsToLink(s);
  return (
    <div class="tm-step-section">
      <h3>Artists</h3>
      <ul class="tm-artist-rows">
        {s.artists.map((a) => <ArtistLine key={a.name} a={a} server={s.server} busy={busy} onChoose={onChoose} />)}
      </ul>
      {missing > 0 && (
        <p class="tm-muted tm-small-note">
          The release editor links an artist only when it already exists on {serverHost(s.server)}. Add{" "}
          {missing === 1 ? "it" : "them"}, then Check again below; or open the editor now and add{" "}
          {missing === 1 ? "it" : "them"} there.
        </p>
      )}
    </div>
  );
}

/** A MusicBrainz artist link (or MBID) for an artist the search did not find. */
function PasteArtist({ server, busy, onUse }: { server: string; busy: boolean; onUse: (link: string) => void }) {
  const [link, setLink] = useState("");
  return (
    <form
      class="tm-inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (link.trim()) onUse(link.trim());
      }}
    >
      <input
        type="url"
        placeholder={`the artist's ${serverHost(server)} link`}
        aria-label="MusicBrainz artist link"
        value={link}
        onInput={(e) => setLink(e.currentTarget.value)}
      />
      <button type="submit" class="tm-button tm-secondary tm-small" disabled={busy || !link.trim()}>Use</button>
    </form>
  );
}

function Duplicates({ s, busy, onUse }: { s: SubmissionDto; busy: boolean; onUse: (mbid: string) => void }) {
  if (s.duplicates.length === 0) {
    return (
      <p class="tm-step-line">
        <strong>Duplicates:</strong>{" "}
        <span class="tm-muted">
          none on {serverHost(s.server)} (nothing with this barcode, these provider pages, or this title)
        </span>
      </p>
    );
  }
  return (
    <div class="tm-step-section">
      <h3>Possible duplicates</h3>
      <p class="tm-muted tm-small-note">
        {serverHost(s.server)}{" "}
        may already have this release. If one of these is it, use it instead of adding a duplicate: the tags are then
        proposed from it.
      </p>
      <div class="tm-table-wrap">
        <table class="tm-table">
          <thead>
            <tr>
              <th>Release</th>
              <th>Date</th>
              <th>Country</th>
              <th>Barcode</th>
              <th class="tm-num">Tracks</th>
              <th>Why</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {s.duplicates.map((d) => (
              <tr key={d.mbid}>
                <td>
                  <a href={`${s.server}/release/${d.mbid}`} target="_blank" rel="noopener noreferrer">{d.title}</a>
                  {d.artist && <span class="tm-muted">— {d.artist}</span>}
                </td>
                <td>{d.date ?? "–"}</td>
                <td>{d.country ?? "–"}</td>
                <td>{d.barcode ?? "–"}</td>
                <td class="tm-num">{d.trackCount ?? "–"}</td>
                <td class="tm-muted">{d.reasons.join("; ")}</td>
                <td>
                  <button
                    type="button"
                    class="tm-button tm-secondary tm-small"
                    disabled={busy}
                    onClick={() => onUse(d.mbid)}
                  >
                    Use this
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Progress({ view }: { view: StepsView }) {
  return (
    <ol class="tm-steps" aria-label="Steps">
      {STEPS.map((step, i) => {
        const st = view.states[step.id];
        return (
          <li
            key={step.id}
            class={`tm-step tm-step-${st}`}
            aria-current={st === "current" ? "step" : undefined}
            title={st === "skipped" ? "Nothing to do here" : undefined}
          >
            <span class="tm-step-n" aria-hidden="true">{st === "done" || st === "skipped" ? "✓" : i + 1}</span>
            {step.label}
          </li>
        );
      })}
    </ol>
  );
}

/** Step 4: the editor, then the wait for MusicBrainz to send the browser back. */
function Editor(
  { s, busy, act }: { s: SubmissionDto; busy: boolean; act: (fn: () => Promise<unknown>) => Promise<void> },
) {
  const [link, setLink] = useState("");
  const host = serverHost(s.server);
  if (s.state === "verifying") return <p class="tm-muted">Checking the new release on {host}…</p>;
  return (
    <div class="tm-step-section">
      <h3>Release editor</h3>
      <p>
        <button type="button" class="tm-button" disabled={busy} onClick={() => act(() => openEditor(s.id))}>
          {s.state === "seeded" ? "Open the release editor again" : `Open the ${host} release editor`}
        </button>
      </p>
      {s.state === "ready" && (
        <p class="tm-muted tm-small-note">
          It opens in a new tab, filled in from the providers. You check it and submit it from your own MusicBrainz
          account; nothing is submitted for you.
        </p>
      )}
      {s.state === "seeded" && (
        <>
          <p role="status">
            Waiting for you to submit on{" "}
            {host}. Check every tab of the editor first; MusicBrainz then sends you back here.
          </p>
          {s.error && <p class="tm-error">{s.error}</p>}
          <p class="tm-muted tm-small-note">Not sent back? Paste the new release's link:</p>
          <form
            class="tm-inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              act(() => api.submissionCallback(s.id, link.trim())).then(() => setLink(""));
            }}
          >
            <input
              type="url"
              placeholder={`${s.server}/release/…`}
              aria-label={`The new release on ${host}`}
              value={link}
              onInput={(e) => setLink(e.currentTarget.value)}
            />
            <button type="submit" class="tm-button tm-secondary tm-small" disabled={busy || !link.trim()}>
              Use this release
            </button>
          </form>
        </>
      )}
    </div>
  );
}

/** Step 5: the release is on MusicBrainz; a checklist of what finishes the job. */
function Done(
  { s, proposal, changes, building, onShowChanges, onCheck }: {
    s: SubmissionDto;
    proposal: ProposalDto | null;
    changes: number;
    building: boolean;
    onShowChanges: () => void;
    /** Looks the release up again for its cover art and ISRCs (D65). */
    onCheck: () => Promise<void>;
  },
) {
  const host = serverHost(s.server);
  const f = s.followUps;
  const [error, setError] = useState<string | null>(null);
  const check = () => {
    setError(null);
    onCheck().catch((e) => setError((e as Error).message));
  };
  // Opening the follow-ups looks again, so cover art added meanwhile shows as done without a click.
  useEffect(() => {
    if (shouldCheckFollowUps(s, Date.now())) check();
  }, [s.id]);
  const again = f && (
    <button type="button" class="tm-linklike tm-small-link" disabled={f.checking} onClick={check}>
      {f.checking ? "checking…" : "check again"}
    </button>
  );
  const ours = proposal?.releaseMbid === s.releaseMbid;
  const written = ours && changes === 0 && !building;
  return (
    <div class="tm-step-section">
      <p>
        <span class="tm-badge tm-badge-ok tm-inline">added</span> The release is on {host}
        {f && (
          <>
            {": "}
            <a href={f.release} target="_blank" rel="noopener noreferrer">{s.releaseMbid}</a>
          </>
        )}.
      </p>
      <ul class="tm-checklist">
        <li class={written ? "tm-check-done" : ""}>
          <strong>Write the MusicBrainz IDs</strong> {building || !ours
            ? <span class="tm-muted">preparing the changes from the new release…</span>
            : written
            ? <span class="tm-muted">written</span>
            : (
              <>
                <span class="tm-muted">{changes === 1 ? "1 change" : `${changes} changes`} ready</span>{" "}
                <button type="button" class="tm-button tm-small" onClick={onShowChanges}>Review the changes</button>
              </>
            )}
        </li>
        {f && (
          f.coverArtAdded
            ? (
              <li class="tm-check-done">
                <strong>Cover art</strong> <span class="tm-muted">on {host}</span>
              </li>
            )
            : (
              <li>
                <a href={f.addCoverArt} target="_blank" rel="noopener noreferrer">Add cover art</a>{" "}
                <span class="tm-muted">(Tagmonia cannot upload it; use the cover in the header)</span> · {again}
              </li>
            )
        )}
        {f?.isrcs
          ? (
            f.isrcsAdded
              ? (
                <li class="tm-check-done">
                  <strong>ISRCs</strong> <span class="tm-muted">on {host}</span>
                </li>
              )
              : (
                <li>
                  <a href={f.isrcs} target="_blank" rel="noopener noreferrer">Submit the ISRCs</a>{" "}
                  <span class="tm-muted">(with MagicISRC, from your MusicBrainz account)</span> · {again}
                </li>
              )
          )
          : s.server === TEST_SERVER && <li class="tm-muted">ISRCs can be submitted only to musicbrainz.org.</li>}
      </ul>
      {error && <p class="tm-error" role="alert">{error}</p>}
      {f?.checkedAt && (
        <p class="tm-muted tm-small-note">
          Last looked at {host} {new Date(f.checkedAt).toLocaleString()}; edits can take a moment to show.
        </p>
      )}
    </div>
  );
}

/**
 * The Add to MusicBrainz panel (D52, D53 PR 4): launched from the header, over the tabs, closable at any
 * point. The submission keeps its state when closed, and the header shows it.
 */
export function AddToMusicBrainz(
  { releaseId, proposal, submission, changes, building, onReload, onClose, onShowChanges }: {
    releaseId: number;
    /** Both loaded and kept live by the release page: it polls while a check or verification runs. */
    proposal: ProposalDto | null;
    submission: SubmissionDto | null;
    /** Changes the proposal would write, counted as the header counts them. */
    changes: number;
    /** A proposal is being built (after the return: from the new release). */
    building: boolean;
    onReload: () => Promise<void>;
    onClose: () => void;
    onShowChanges: () => void;
  },
) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onReload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sub = activeSubmission(submission);
  const view = stepsView(sub);
  const testServer = sub?.server === TEST_SERVER;
  const working = sub && (sub.state === "ready" || sub.state === "seeded");

  return (
    <section class="tm-card tm-mb-panel" aria-labelledby="tm-mb-panel-title" id="tm-add-to-musicbrainz">
      <div class="tm-mb-panel-head">
        <h2 id="tm-mb-panel-title">Add to MusicBrainz</h2>
        <button type="button" class="tm-icon-button" aria-label="Close" title="Close" onClick={onClose}>✕</button>
      </div>
      <Progress view={view} />
      {testServer && (
        <p class="tm-small-note">
          <span class="tm-badge tm-badge-warn tm-inline">test server</span>{" "}
          Releases added here exist only on test.musicbrainz.org (Settings → MusicBrainz); their identifiers mean
          nothing on musicbrainz.org.
        </p>
      )}
      {error && <p class="tm-error" role="alert">{error}</p>}

      {view.current === "check" && (
        sub?.state === "checking"
          ? <p class="tm-muted">Checking {serverHost(sub.server)} for this release and its artists…</p>
          : (
            <div class="tm-step-section">
              <p class="tm-muted tm-small-note">
                MusicBrainz does not have this release. Tagmonia looks for it and its artists there first, then opens
                MusicBrainz's release editor filled in from the providers. You check it and submit it from your own
                MusicBrainz account.
              </p>
              {sub?.state === "failed" && sub.error && <p class="tm-error">{sub.error}</p>}
              {proposal && (
                <button
                  type="button"
                  class="tm-button"
                  disabled={busy}
                  onClick={() => act(() => api.prepareSubmission(proposal.id))}
                >
                  {sub?.state === "failed" ? "Try again" : "Check MusicBrainz and prepare the editor"}
                </button>
              )}
            </div>
          )
      )}

      {sub && (working || sub.state === "verifying") && (
        <>
          <Artists
            s={sub}
            busy={busy}
            skipped={view.states.artists === "skipped"}
            onChoose={(name, artist) => act(() => api.chooseSubmissionArtist(sub.id, name, artist))}
          />
          <Duplicates
            s={sub}
            busy={busy}
            onUse={(mbid) =>
              act(async () => {
                await api.propose(releaseId, { releaseMbid: mbid, ...(testServer ? { server: TEST_SERVER } : {}) });
                await api.abandonSubmission(sub.id);
                onClose();
                onShowChanges();
              })}
          />
          <Editor s={sub} busy={busy} act={act} />
        </>
      )}

      {sub?.state === "returned" && (
        <Done
          s={sub}
          proposal={proposal}
          changes={changes}
          building={building}
          onShowChanges={onShowChanges}
          onCheck={() => api.checkFollowUps(sub.id).then(onReload)}
        />
      )}

      {working && (
        <div class="tm-mb-panel-foot">
          <button
            type="button"
            class="tm-button tm-secondary"
            disabled={busy}
            onClick={() => act(() => api.recheckSubmission(sub.id))}
            title="Look for the release and its artists on MusicBrainz again, e.g. after adding an artist"
          >
            Check again
          </button>
          <button
            type="button"
            class="tm-button tm-secondary"
            disabled={busy}
            onClick={() => act(() => api.abandonSubmission(sub.id))}
          >
            Cancel the submission
          </button>
        </div>
      )}
    </section>
  );
}
