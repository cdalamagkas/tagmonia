/**
 * The library (docs/proposals/library-and-settings.md, D75): the folder tree beside the releases of the selected
 * folder and below, searched, filtered by status and sorted. The view lives in the URL, so Back from a release
 * returns to it.
 */
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { LibrarySummary, ReleaseList, ReleaseSummary } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { folderLabel } from "../format.ts";
import { inboxScanActive, MusicServerStatus, scanActive, ScanStatus } from "../components/ScanStatus.tsx";
import { onLinkClick } from "../router.ts";
import { StatusBadge } from "../components/Identification.tsx";
import { CoverImage } from "../components/CoverImage.tsx";
import { ChangesBadge } from "../components/ChangesBadge.tsx";
import { FolderTree } from "../components/FolderTree.tsx";
import { crumbs, type LibraryView, parseView, SORT_OPTIONS, STATUS_OPTIONS, viewSearch } from "../library/view.ts";

const PAGE = 50;

export function LibraryPage() {
  const [summary, setSummary] = useState<LibrarySummary | null>(null);
  const [view, setView] = useState<LibraryView>(() => parseView(location.search));
  const [list, setList] = useState<{ items: ReleaseSummary[]; total: number; counts: ReleaseList["counts"] } | null>(
    null,
  );
  const [search, setSearch] = useState(view.q);
  const [error, setError] = useState<string | null>(null);
  /** The tree drawer on narrow screens. */
  const [drawer, setDrawer] = useState(false);
  /** Bumped when the library changed (a scan finished), so the tree loads again. */
  const [changed, setChanged] = useState(0);
  const wasActive = useRef(false);

  const load = useCallback(async (v: LibraryView, offset: number) => {
    try {
      const page = await api.releases(v, offset, PAGE);
      setList((prev) => ({
        items: offset === 0 || !prev ? page.items : [...prev.items, ...page.items],
        total: page.total,
        counts: page.counts,
      }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const refreshSummary = useCallback(async () => {
    try {
      setSummary(await api.summary());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refreshSummary();
    // Back and Forward between views of this page.
    const onPop = () => {
      const v = parseView(location.search);
      setView(v);
      setSearch(v.q);
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  // The view goes to the URL (replacing, not adding, history entries) and the list loads for it.
  useEffect(() => {
    const target = `/${viewSearch(view)}`;
    if (location.pathname + location.search !== target) history.replaceState(null, "", target);
    load(view, 0);
  }, [view]);

  // Typing searches after a pause.
  useEffect(() => {
    if (search === view.q) return;
    const t = setTimeout(() => setView((v) => ({ ...v, q: search })), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Poll while a scan runs; reload when it finishes. With an inbox, look now and then too: the watcher scans new
  // albums by itself (D60), and the list should show them without a reload.
  const lastInboxScan = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    const active = scanActive(summary) || inboxScanActive(summary);
    const inboxScan = summary?.inbox?.lastScan?.finishedAt ?? null;
    const inboxChanged = lastInboxScan.current !== undefined && inboxScan !== lastInboxScan.current;
    if (summary) lastInboxScan.current = inboxScan;
    if ((wasActive.current && !active) || inboxChanged) {
      load(view, 0);
      setChanged((n) => n + 1);
    }
    wasActive.current = active;
    if (!active && !summary?.inbox) return;
    const t = setTimeout(refreshSummary, active ? 1000 : 30_000);
    return () => clearTimeout(t);
  }, [summary]);

  const startScan = async () => {
    try {
      await api.scan();
      await refreshSummary();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const cancelScan = async () => {
    if (summary?.scan) await api.cancelJob(summary.scan.id).catch(() => {});
    await refreshSummary();
  };

  const select = (root: LibraryView["root"], folder: string) => {
    setView((v) => ({ ...v, root, folder }));
    setDrawer(false);
  };

  const active = scanActive(summary);
  const roots: LibraryView["root"][] = summary?.inbox ? ["library", "inbox"] : ["library"];
  const trail = crumbs(view);
  const here = trail[trail.length - 1].label;
  const counts = list?.counts;
  const items = list?.items ?? [];
  const total = list?.total ?? 0;

  return (
    <main class="tm-wide">
      <section class="tm-card tm-toolbar">
        <div>
          <h1>Library</h1>
          {summary && (
            <p class="tm-muted tm-stats">
              {summary.releases} releases · {summary.files} files
              {summary.unreadable > 0 && (
                <>
                  · <span class="tm-error">{summary.unreadable} unreadable</span>
                </>
              )}
              {summary.readOnly && (
                <>
                  · <span class="tm-badge">read-only mode</span>
                </>
              )}
            </p>
          )}
          {summary && <ScanStatus summary={summary} />}
          {summary?.inbox && (
            <p class="tm-muted tm-small-note">
              {inboxScanActive(summary)
                ? "New music arrived in the inbox: scanning it…"
                : "The inbox is watched: new albums appear here by themselves once they finish copying."}
            </p>
          )}
          {summary && <MusicServerStatus summary={summary} />}
        </div>
        <div class="tm-actions">
          {active
            ? <button type="button" class="tm-button tm-secondary" onClick={cancelScan}>Cancel scan</button>
            : <button type="button" class="tm-button" onClick={startScan}>Scan library</button>}
        </div>
      </section>

      {error && <p class="tm-error" role="alert">{error}</p>}

      <div class={`tm-library${drawer ? " tm-drawer-open" : ""}`}>
        <aside class="tm-card tm-library-tree">
          <FolderTree roots={roots} selected={view} refresh={changed} onSelect={select} />
        </aside>

        <section class="tm-card tm-library-list">
          <button
            type="button"
            class="tm-button tm-secondary tm-small tm-drawer-toggle"
            aria-expanded={drawer}
            onClick={() => setDrawer(!drawer)}
          >
            {drawer ? "Close folders" : `Folders: ${here}`}
          </button>
          <nav class="tm-crumbs tm-library-crumbs" aria-label="Folder">
            {trail.map((c, i) => (
              <span key={c.folder}>
                {i > 0 && <span class="tm-muted">/</span>}
                {i === trail.length - 1
                  ? <strong>{c.label}</strong>
                  : (
                    <button type="button" class="tm-linklike tm-crumb" onClick={() => select(view.root, c.folder)}>
                      {c.label}
                    </button>
                  )}
              </span>
            ))}
          </nav>
          <div class="tm-library-controls">
            <input
              class="tm-search"
              type="search"
              placeholder={view.folder ? `Search in ${here}` : "Search artist, album, folder or file"}
              aria-label="Search releases"
              value={search}
              onInput={(e) => setSearch(e.currentTarget.value)}
            />
            <label class="tm-inline-field">
              <span>Status</span>
              <select
                value={view.status ?? ""}
                onChange={(e) =>
                  setView((v) => ({ ...v, status: (e.currentTarget.value || null) as LibraryView["status"] }))}
              >
                <option value="">All{counts ? ` (${counts.all})` : ""}</option>
                {STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                    {counts ? ` (${counts[o.value]})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label class="tm-inline-field">
              <span>Sort</span>
              <select
                value={view.sort}
                onChange={(e) => setView((v) => ({ ...v, sort: e.currentTarget.value as LibraryView["sort"] }))}
              >
                {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </div>

          {list && items.length === 0
            ? (
              <p class="tm-muted">
                {view.q || view.status
                  ? "No releases match."
                  : summary?.scan
                  ? "No releases here."
                  : "Scan the library to see your releases."}
              </p>
            )
            : (
              <div class="tm-table-wrap">
                <table class="tm-table">
                  <thead>
                    <tr>
                      <th class="tm-col-cover">
                        <span class="tm-sr">Cover</span>
                      </th>
                      <th>Album artist</th>
                      <th>Album</th>
                      <th class="tm-num">Tracks</th>
                      <th title="Identification on MusicBrainz">MusicBrainz</th>
                      <th title="What the prepared changes would add or change in the files">Changes</th>
                      <th class="tm-hide-sm">Format</th>
                      <th class="tm-hide-sm">Folder</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((r) => (
                      <tr key={r.id}>
                        <td class="tm-col-cover">
                          <a href={`/releases/${r.id}`} onClick={onLinkClick} tabIndex={-1} aria-hidden="true">
                            <CoverImage releaseId={r.id} size="thumb" px={48} alt="" />
                          </a>
                        </td>
                        <td>{r.artist ?? <span class="tm-muted">–</span>}</td>
                        <td>
                          <a href={`/releases/${r.id}`} onClick={onLinkClick}>
                            {r.album ?? r.single ?? <span class="tm-muted">Loose files</span>}
                          </a>
                          {r.errorCount > 0 && <span class="tm-badge tm-badge-error">{r.errorCount} unreadable</span>}
                          {r.mbid && <span class="tm-badge" title={r.mbid}>MBID</span>}
                        </td>
                        <td class="tm-num">{r.trackCount}</td>
                        <td>
                          <StatusBadge status={r.status} />
                        </td>
                        <td>
                          <ChangesBadge changes={r.changes} />
                        </td>
                        <td class="tm-hide-sm">{r.formats.join(", ")}</td>
                        <td class="tm-path tm-hide-sm">{folderLabel(r.folder)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          {list && (
            <p class="tm-muted tm-small-note">
              {view.status && counts ? `${total} of ${counts.all}` : total} release
              {(view.status && counts ? counts.all : total) === 1 ? "" : "s"}
              {view.folder ? ` in ${here}` : ""}
            </p>
          )}
          {items.length < total && (
            <button
              type="button"
              class="tm-button tm-secondary tm-more"
              onClick={() => load(view, items.length)}
            >
              Show more ({total - items.length} left)
            </button>
          )}
        </section>
      </div>
    </main>
  );
}
