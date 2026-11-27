import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { LibrarySummary, ReleaseSummary } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { folderLabel } from "../format.ts";
import { inboxScanActive, MusicServerStatus, scanActive, ScanStatus } from "../components/ScanStatus.tsx";
import { onLinkClick } from "../router.ts";
import { StatusBadge } from "../components/Identification.tsx";
import { CoverImage } from "../components/CoverImage.tsx";
import { ChangesBadge } from "../components/ChangesBadge.tsx";

const PAGE = 50;

export function LibraryPage() {
  const [summary, setSummary] = useState<LibrarySummary | null>(null);
  const [items, setItems] = useState<ReleaseSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  /** All, only the library, or only the inbox (D57). */
  const [where, setWhere] = useState<"inbox" | "library" | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const wasActive = useRef(false);

  const load = useCallback(async (query: string, offset: number, w = where) => {
    try {
      const page = await api.releases(query, offset, PAGE, w);
      setTotal(page.total);
      setItems((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
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
  }, []);

  // Debounced search.
  useEffect(() => {
    const t = setTimeout(() => load(q, 0, where), 250);
    return () => clearTimeout(t);
  }, [q, where]);

  // Poll while a scan runs; reload the list when it finishes. With an inbox, look now and then too: the
  // watcher scans new albums by itself (D60), and the list should show them without a reload.
  const lastInboxScan = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    const active = scanActive(summary) || inboxScanActive(summary);
    const inboxScan = summary?.inbox?.lastScan?.finishedAt ?? null;
    const inboxChanged = lastInboxScan.current !== undefined && inboxScan !== lastInboxScan.current;
    if (summary) lastInboxScan.current = inboxScan;
    if ((wasActive.current && !active) || inboxChanged) load(q, 0, where);
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

  const active = scanActive(summary);
  return (
    <main>
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

      <section class="tm-card">
        <input
          class="tm-search"
          type="search"
          placeholder="Search artist, album or folder"
          aria-label="Search releases"
          value={q}
          onInput={(e) => setQ(e.currentTarget.value)}
        />
        {summary?.inbox && (
          <div class="tm-filter" role="group" aria-label="Show">
            {([[undefined, "All"], ["library", "Library"], ["inbox", `Inbox (${summary.inbox.releases})`]] as const)
              .map((
                [w, label],
              ) => (
                <button
                  key={label}
                  type="button"
                  class={`tm-linklike${where === w ? " tm-on" : ""}`}
                  aria-pressed={where === w}
                  onClick={() => setWhere(w)}
                >
                  {label}
                </button>
              ))}
          </div>
        )}
        {items.length === 0
          ? (
            <p class="tm-muted">
              {q
                ? "No releases match."
                : summary?.scan
                ? "No releases found."
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
                    <th>Format</th>
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
                        {r.inInbox && (
                          <span class="tm-badge tm-badge-warn" title="Written, it moves into the library">inbox</span>
                        )}
                      </td>
                      <td class="tm-num">{r.trackCount}</td>
                      <td>
                        <StatusBadge status={r.status} />
                      </td>
                      <td>
                        <ChangesBadge changes={r.changes} />
                      </td>
                      <td>{r.formats.join(", ")}</td>
                      <td class="tm-path tm-hide-sm">{folderLabel(r.folder)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        {items.length < total && (
          <button
            type="button"
            class="tm-button tm-secondary tm-more"
            onClick={() => load(q, items.length)}
          >
            Show more ({total - items.length} left)
          </button>
        )}
      </section>
    </main>
  );
}
