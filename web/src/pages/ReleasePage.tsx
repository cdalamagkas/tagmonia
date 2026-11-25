/**
 * One release (docs/proposals/release-page-restructure.md, D53): a header that says where the release
 * stands and what to do next, then four tabs: Changes, Match, Files, History. The page loads everything
 * once and keeps it live while jobs run (useRelease).
 */
import { useEffect, useState } from "preact/hooks";
import type { CurrentCoverDto, LibraryFileDto } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { bytes, duration, METHOD_LABELS, RELEASE_FIELDS, tagValue } from "../format.ts";
import { onLinkClick } from "../router.ts";
import { Identification } from "../components/Identification.tsx";
import { Review } from "../components/Review.tsx";
import { History } from "../components/History.tsx";
import { CoverImage } from "../components/CoverImage.tsx";
import { AddToMusicBrainz, openEditor } from "../components/Submission.tsx";
import {
  type Action,
  changesToWrite,
  isOpen,
  type ReleaseStatus,
  releaseStatus,
  sourceLine,
  undoableBatch,
} from "../release/status.ts";
import { isLive, type LoadedRelease, useRelease } from "../release/useRelease.ts";
import { activeSubmission } from "../release/submission.ts";

type Tab = "changes" | "match" | "files" | "history";
const TABS: Tab[] = ["changes", "match", "files", "history"];

function coverCaption(c: CurrentCoverDto): string {
  const kb = c.size >= 1024 * 1024 ? `${(c.size / 1024 / 1024).toFixed(1)} MB` : `${Math.round(c.size / 1024)} KB`;
  const type = c.mime === "image/png"
    ? "PNG"
    : c.mime === "image/jpeg"
    ? "JPEG"
    : c.mime.replace("image/", "").toUpperCase();
  const dims = c.width && c.height ? `${c.width} × ${c.height} ` : "";
  const where = c.kind === "embedded"
    ? `embedded in ${c.filesWithPicture} of ${c.files} files`
    : `folder image ${c.path.split("/").pop()}${c.filesWithPicture ? "" : ", none embedded"}`;
  return `${dims}${type}, ${kb} · ${where}`;
}

function releaseTags(files: LibraryFileDto[]) {
  return RELEASE_FIELDS.flatMap((field) => {
    const values = files.map((f) => tagValue(f.tags[field]));
    const distinct = [...new Set(values)];
    if (distinct.length === 1 && distinct[0] === "") return [];
    return [{ field, distinct, missing: values.filter((v) => v === "").length }];
  });
}

function FileTags({ file }: { file: LibraryFileDto }) {
  const entries = Object.entries(file.tags).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div class="tm-file-detail">
      <p class="tm-path">{file.path}</p>
      <p class="tm-muted">
        {[
          file.format?.toUpperCase(),
          file.sampleRate && `${file.sampleRate / 1000} kHz`,
          file.channels && `${file.channels} ch`,
          file.bitrateKbps && `${file.bitrateKbps} kbps`,
          bytes(file.sizeBytes),
          file.pictures.length ? `${file.pictures.length} embedded picture(s)` : "no embedded picture",
        ].filter(Boolean).join(" · ")}
      </p>
      {entries.length === 0 ? <p class="tm-muted">No tags.</p> : (
        <dl class="tm-tags">
          {entries.map(([k, v]) => (
            <>
              <dt>{k}</dt>
              <dd>{tagValue(v)}</dd>
            </>
          ))}
        </dl>
      )}
    </div>
  );
}

/** The Files tab: tags shared by the release's files, then each file, expandable to all its tags. */
function FilesTab({ files }: { files: LibraryFileDto[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const multiDisc = new Set(files.map((f) => f.tags.discnumber ?? 1)).size > 1;
  const tags = releaseTags(files);
  return (
    <section class="tm-card">
      <h2>Album tags in the files</h2>
      {tags.length === 0 ? <p class="tm-muted">No album tags.</p> : (
        <table class="tm-table tm-kv">
          <tbody>
            {tags.map(({ field, distinct, missing }) => (
              <tr key={field}>
                <th>{field}</th>
                <td>
                  {distinct.length === 1 && missing === 0 ? distinct[0] : (
                    <>
                      <span class="tm-badge tm-badge-warn">differs across files</span>
                      <ul class="tm-values">
                        {distinct.map((v) => <li key={v}>{v || <span class="tm-muted">(not set)</span>}</li>)}
                      </ul>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>Files</h2>
      <div class="tm-table-wrap">
        <table class="tm-table">
          <thead>
            <tr>
              <th class="tm-num tm-col-narrow">#</th>
              <th>Title</th>
              <th>Artist</th>
              <th class="tm-num">Length</th>
              <th>Format</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <>
                <tr
                  key={f.id}
                  class={`tm-clickable${open === f.id ? " tm-open" : ""}`}
                  onClick={() => setOpen(open === f.id ? null : f.id)}
                >
                  <td class="tm-num tm-col-narrow">
                    {multiDisc && f.tags.discnumber ? `${f.tags.discnumber}-` : ""}
                    {f.tags.tracknumber ?? ""}
                  </td>
                  <td>
                    <button type="button" class="tm-linklike" aria-expanded={open === f.id}>
                      {f.tags.title ?? <span class="tm-muted">{f.path.split("/").pop()}</span>}
                    </button>
                    {f.readError && <span class="tm-badge tm-badge-error" title={f.readError}>unreadable</span>}
                  </td>
                  <td>{f.tags.artist ?? ""}</td>
                  <td class="tm-num">{duration(f.durationMs)}</td>
                  <td>{f.format ?? "–"}</td>
                </tr>
                {open === f.id && (
                  <tr key={`${f.id}-detail`} class="tm-detail-row">
                    <td colSpan={5}>
                      {f.readError && <p class="tm-error">{f.readError}</p>}
                      <FileTags file={f} />
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ActionButton(
  { a, primary, busy, onAction }: { a: Action; primary: boolean; busy: boolean; onAction: (a: Action) => void },
) {
  if (a.id === "submission" && !primary) {
    return (
      <button type="button" class="tm-linklike" disabled={busy} onClick={() => onAction(a)}>
        {a.label}
      </button>
    );
  }
  return (
    <button
      type="button"
      class={`tm-button${primary ? "" : " tm-secondary"}`}
      disabled={busy || !!a.disabled}
      title={a.disabled}
      onClick={() => onAction(a)}
    >
      {a.label}
    </button>
  );
}

/** Cover, title, where the tags come from, and where the release stands with what to do next. */
function Header(
  { data, status, busy, error, onAction, onSource }: {
    data: LoadedRelease;
    status: ReleaseStatus;
    busy: boolean;
    error: string | null;
    onAction: (a: Action) => void;
    onSource: () => void;
  },
) {
  const { release, files } = data.detail;
  const source = sourceLine(data, (m) => METHOD_LABELS[m as keyof typeof METHOD_LABELS] ?? m);
  const formats = [...new Set(files.map((f) => f.format?.toUpperCase()).filter(Boolean))].join(", ");
  return (
    <section class="tm-card tm-release-header">
      <figure class="tm-release-cover">
        <CoverImage
          releaseId={release.id}
          size="large"
          px={140}
          version={data.filesVersion}
          alt={`Cover of ${release.album ?? "this release"}`}
        />
        <figcaption class="tm-muted">
          {data.cover ? coverCaption(data.cover) : "No cover in the files or the folder."}
        </figcaption>
      </figure>
      <div class="tm-release-summary">
        <h1>{release.album ?? "Loose files"}</h1>
        <p class="tm-muted">
          {release.artist ?? "Unknown artist"} · {release.trackCount} {formats} files ·{" "}
          <span class="tm-path">{release.folder || "/"}</span>
        </p>
        <p class="tm-source">
          <span class="tm-muted">Source:</span>{" "}
          {source.url
            ? <a href={source.url} target="_blank" rel="noopener noreferrer">{source.label}</a>
            : source.label}
          {source.details.length > 0 && <span class="tm-muted">{` · ${source.details.join(" · ")}`}</span>}{" "}
          <button type="button" class="tm-linklike tm-small-link" onClick={onSource}>Change</button>
        </p>
        <div class={`tm-status tm-status-${status.tone}`} role="status" aria-live="polite">
          <span class="tm-status-dot" aria-hidden="true" />
          <span class="tm-status-sentence">{status.sentence}</span>
          <span class="tm-status-actions">
            {status.primary && <ActionButton a={status.primary} primary busy={busy} onAction={onAction} />}
            {status.secondary.map((a) => (
              <ActionButton key={a.id} a={a} primary={false} busy={busy} onAction={onAction} />
            ))}
          </span>
        </div>
        {data.proposal.readOnly && (
          <p class="tm-muted tm-small-note">Read-only mode: you can review, but nothing is written.</p>
        )}
        {error && <p class="tm-error" role="alert">{error}</p>}
      </div>
    </section>
  );
}

function initialTab(): Tab | null {
  const t = new URLSearchParams(location.search).get("tab");
  return TABS.includes(t as Tab) ? (t as Tab) : null;
}

/** `?panel=musicbrainz`: the Add to MusicBrainz panel is open (the callback page links here, at step 5). */
function initialPanel(): boolean {
  return new URLSearchParams(location.search).get("panel") === "musicbrainz";
}

function setSearch(key: string, value: string | null) {
  const url = new URL(location.href);
  if (value === null) url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  history.replaceState(null, "", url.pathname + url.search);
}

export function ReleasePage({ id }: { id: number }) {
  const { data, error: loadError, reload } = useRelease(id);
  const [chosenTab, setChosenTab] = useState<Tab | null>(initialTab);
  const [panel, setPanel] = useState(initialPanel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setChosenTab(initialTab());
    setPanel(initialPanel());
  }, [id]);

  if (loadError && !data) {
    return (
      <main>
        <a href="/" onClick={onLinkClick}>← Library</a>
        <p class="tm-error">{loadError}</p>
      </main>
    );
  }
  if (!data) {
    return (
      <main>
        <p class="tm-muted">Loading…</p>
      </main>
    );
  }

  const p = data.proposal.proposal;
  // Changes when there is something proposed; otherwise Match, where a release is chosen.
  const tab: Tab = chosenTab ?? (p ? "changes" : "match");
  const selectTab = (t: Tab) => {
    setChosenTab(t);
    setSearch("tab", t);
    openPanel(false);
  };
  const openPanel = (open: boolean) => {
    setPanel(open);
    setSearch("panel", open ? "musicbrainz" : null);
  };
  const scrollTo = (elementId: string) =>
    requestAnimationFrame(() => document.getElementById(elementId)?.scrollIntoView({ behavior: "smooth" }));

  /** Runs an action, then reloads; errors (409 etc.) are shown in the header. */
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onAction = (a: Action) => {
    switch (a.id) {
      case "write":
        return act(() => api.write(p!.id));
      case "build":
        return act(() =>
          api.propose(id, p!.releaseMbid ? { releaseMbid: p!.releaseMbid } : { providerUrl: p!.sourceUrl! })
        );
      case "prepare":
        return act(() => api.propose(id, { releaseMbid: data.identification.matches[0].releaseMbid }));
      case "identify":
        return act(() => api.identify(id, {}));
      case "undo": {
        const batch = undoableBatch(data.history);
        return batch && act(() => api.undo(batch.id));
      }
      case "match":
        selectTab("match");
        // "Paste an album link": straight to the box.
        if (a.label.startsWith("Paste")) {
          requestAnimationFrame(() => document.getElementById("tm-link-box")?.focus());
        }
        return;
      case "resolve":
        selectTab("changes");
        return scrollTo("tm-conflicts");
      case "submission":
        openPanel(true);
        return scrollTo("tm-add-to-musicbrainz");
      case "editor": {
        // Straight from the click, so the browser lets the editor open in a new tab.
        const sub = data.submission!;
        return act(() => openEditor(sub.id));
      }
      case "retry":
        return act(() => api.prepareSubmission(p!.id));
    }
  };

  const status = releaseStatus(data);
  const live = isLive(data);
  const { files } = data.detail;
  const changes = p && isOpen(p) ? changesToWrite(p) : 0;
  const tabLabel: Record<Tab, string> = {
    changes: changes > 0 ? `Changes (${changes})` : "Changes",
    match: "Match",
    files: `Files (${files.length})`,
    history: data.history.batches.length ? `History (${data.history.batches.length})` : "History",
  };
  // The panel applies to a release tagged from a provider, or while a submission is under way or has returned.
  const canSubmit = (!!p && !p.releaseMbid && !!p.sourceUrl) || !!activeSubmission(data.submission);
  const showPanel = panel && canSubmit;
  const propose = async (body: Parameters<typeof api.propose>[1]) => {
    await api.propose(id, body);
    await reload();
    selectTab("changes");
  };

  return (
    <main>
      <a href="/" onClick={onLinkClick}>← Library</a>
      <Header
        data={data}
        status={status}
        busy={busy || live}
        error={error ?? loadError}
        onAction={onAction}
        onSource={() => selectTab("match")}
      />
      {showPanel && (
        <AddToMusicBrainz
          releaseId={id}
          proposal={p}
          submission={data.submission}
          changes={changes}
          building={!!data.proposal.job}
          onReload={reload}
          onClose={() => openPanel(false)}
          onShowChanges={() => selectTab("changes")}
        />
      )}
      <div class="tm-tabs" role="tablist" aria-label="Release" hidden={showPanel}>
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`tm-tab-${t}`}
            aria-selected={tab === t}
            aria-controls={`tm-panel-${t}`}
            class={tab === t ? "tm-on" : ""}
            onClick={() => selectTab(t)}
          >
            {tabLabel[t]}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`tm-panel-${tab}`} aria-labelledby={`tm-tab-${tab}`} hidden={showPanel}>
        {tab === "changes" && (
          <>
            <Review
              releaseId={id}
              data={data.proposal}
              files={files}
              live={live}
              currentCover={data.cover}
              filesVersion={data.filesVersion}
              onReload={reload}
            />
          </>
        )}
        {tab === "match" && (
          <Identification
            releaseId={id}
            data={data.identification}
            proposal={p}
            files={files}
            onReload={reload}
            onChoose={(releaseMbid) => propose({ releaseMbid })}
            onChooseProvider={(providerUrl) => propose({ providerUrl })}
          />
        )}
        {tab === "files" && <FilesTab files={files} />}
        {tab === "history" && (
          <History
            data={data.history}
            readOnly={data.proposal.readOnly}
            onUndo={(b) => act(() => api.undo(b.id))}
          />
        )}
      </div>
    </main>
  );
}
