/**
 * Adding a release that MusicBrainz lacks (§12, D52): check for duplicates, open
 * MusicBrainz's release editor pre-filled in a new tab, and follow up once
 * MusicBrainz sends the new release back. The user reviews and submits on
 * MusicBrainz, from their own account; Tagmonia never submits anything.
 */
import { useEffect, useState } from "preact/hooks";
import type { ProposalDto, SubmissionDto } from "../../../shared/types.ts";
import { api } from "../api.ts";

const TEST = "https://test.musicbrainz.org";

function host(server: string): string {
  return new URL(server).host;
}

/**
 * Posts the seed to the release editor in a new tab. The tab is opened before the
 * request, while the click still counts as the user's, so it is not blocked as a pop-up.
 */
async function openEditor(id: number): Promise<void> {
  const tab = window.open("", "tagmonia-mb-editor");
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

function Duplicates({ s, onUse }: { s: SubmissionDto; onUse: (mbid: string) => void }) {
  if (s.duplicates.length === 0) {
    return <p class="tm-muted">{host(s.server)} has nothing with this barcode, these provider pages, or this title.</p>;
  }
  return (
    <>
      <p>
        <span class="tm-badge tm-badge-warn tm-inline">check first</span> {host(s.server)}{" "}
        may already have this release. If one of these is it, use it instead of adding a duplicate.
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
                  <button type="button" class="tm-button tm-secondary tm-small" onClick={() => onUse(d.mbid)}>
                    Use this
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function Submission(
  { releaseId, version, onProposalChanged }: {
    releaseId: number;
    /** Bumped by the page when the proposal changes. */
    version: number;
    onProposalChanged: () => void;
  },
) {
  const [proposal, setProposal] = useState<ProposalDto | null>(null);
  const [sub, setSub] = useState<SubmissionDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState("");

  const load = async () => {
    try {
      const [p, s] = await Promise.all([api.proposal(releaseId), api.submission(releaseId)]);
      setProposal(p.proposal);
      setSub(s.submission);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    load();
  }, [releaseId, version]);
  const working = sub?.state === "checking" || sub?.state === "verifying";
  useEffect(() => {
    if (!working) return;
    const t = setTimeout(async () => {
      const before = sub?.state;
      await load();
      // A verified release builds its MusicBrainz proposal: the review above shows it.
      if (before === "verifying") onProposalChanged();
    }, 1500);
    return () => clearTimeout(t);
  }, [sub]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const fromProvider = !!proposal && !proposal.releaseMbid && !!proposal.sourceUrl;
  const active = sub && sub.state !== "abandoned";
  if (!fromProvider && !(active && sub.state === "returned")) return null;
  const testServer = sub?.server === TEST;

  return (
    <section class="tm-card">
      <h2>Add to MusicBrainz</h2>
      {error && <p class="tm-error" role="alert">{error}</p>}
      {(!active || sub.state === "failed") && proposal && (
        <>
          <p class="tm-muted tm-section-note">
            MusicBrainz does not have this release. Tagmonia can open MusicBrainz's release editor filled in from the
            providers; you check it and submit it from your own MusicBrainz account. Nothing is submitted for you.
          </p>
          {sub?.state === "failed" && sub.error && <p class="tm-error">{sub.error}</p>}
          <button
            type="button"
            class="tm-button"
            disabled={busy}
            onClick={() => act(() => api.prepareSubmission(proposal.id))}
          >
            Check MusicBrainz and prepare the editor
          </button>
        </>
      )}
      {active && testServer && sub.state !== "failed" && (
        <p>
          <span class="tm-badge tm-badge-warn tm-inline">test server</span>{" "}
          This goes to test.musicbrainz.org (Settings → MusicBrainz submissions): it exists only there, and its
          identifiers mean nothing on musicbrainz.org.
        </p>
      )}
      {sub?.state === "checking" && <p class="tm-muted">Checking {host(sub.server)} for this release…</p>}
      {sub && (sub.state === "ready" || sub.state === "seeded") && (
        <>
          <Duplicates
            s={sub}
            onUse={(mbid) =>
              act(async () => {
                await api.propose(releaseId, { releaseMbid: mbid, ...(testServer ? { server: TEST } : {}) });
                await api.abandonSubmission(sub.id);
                onProposalChanged();
              })}
          />
          <p>
            <button type="button" class="tm-button" disabled={busy} onClick={() => act(() => openEditor(sub.id))}>
              {sub.state === "seeded" ? "Open the release editor again" : `Open the ${host(sub.server)} release editor`}
            </button>{" "}
            <button
              type="button"
              class="tm-button tm-secondary"
              disabled={busy}
              onClick={() => act(() => api.abandonSubmission(sub.id))}
            >
              Cancel
            </button>
          </p>
          {sub.state === "seeded" && (
            <>
              <p class="tm-muted">
                Check every tab of the editor, then submit. MusicBrainz sends you back here with the new release. If it
                does not, paste the new release's link:
              </p>
              {sub.error && <p class="tm-error">{sub.error}</p>}
              <form
                class="tm-manual"
                onSubmit={(e) => {
                  e.preventDefault();
                  act(() => api.submissionCallback(sub.id, link.trim())).then(() => setLink(""));
                }}
              >
                <label>
                  The new release on {host(sub.server)}
                  <input
                    type="url"
                    placeholder={`${sub.server}/release/…`}
                    value={link}
                    onInput={(e) => setLink(e.currentTarget.value)}
                  />
                </label>
                <button type="submit" class="tm-button tm-secondary" disabled={busy || !link.trim()}>
                  Use this release
                </button>
              </form>
            </>
          )}
        </>
      )}
      {sub?.state === "verifying" && <p class="tm-muted">Checking the new release on {host(sub.server)}…</p>}
      {sub?.state === "returned" && sub.followUps && (
        <>
          <p>
            <span class="tm-badge tm-badge-ok tm-inline">added</span> The release is on {host(sub.server)}:{" "}
            <a href={sub.followUps.release} target="_blank" rel="noopener noreferrer">{sub.releaseMbid}</a>. Its
            MusicBrainz identifiers are in the proposal above: write them to the files to finish.
          </p>
          <ul class="tm-values">
            <li>
              <a href={sub.followUps.addCoverArt} target="_blank" rel="noopener noreferrer">Add cover art</a>{" "}
              <span class="tm-muted">(cover art cannot be filled in by Tagmonia; upload the cover shown above)</span>
            </li>
            {sub.followUps.isrcs
              ? (
                <li>
                  <a href={sub.followUps.isrcs} target="_blank" rel="noopener noreferrer">Submit the ISRCs</a>{" "}
                  <span class="tm-muted">(with MagicISRC, from your MusicBrainz account)</span>
                </li>
              )
              : testServer && <li class="tm-muted">ISRCs can be submitted only to musicbrainz.org.</li>}
          </ul>
        </>
      )}
    </section>
  );
}
