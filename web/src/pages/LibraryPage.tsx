import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { LibrarySummary, ReleaseSummary } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { scanActive, ScanStatus } from "../components/ScanStatus.tsx";
import { onLinkClick } from "../router.ts";
import { StatusBadge } from "../components/Identification.tsx";

const PAGE = 50;

export function LibraryPage() {
  const [summary, setSummary] = useState<LibrarySummary | null>(null);
  const [items, setItems] = useState<ReleaseSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const wasActive = useRef(false);

  const load = useCallback(async (query: string, offset: number) => {
    try {
      const page = await api.releases(query, offset, PAGE);
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
    const t = setTimeout(() => load(q, 0), 250);
    return () => clearTimeout(t);
  }, [q]);

  // Poll while a scan runs; reload the list when it finishes.
  useEffect(() => {
    const active = scanActive(summary);
    if (wasActive.current && !active) load(q, 0);
    wasActive.current = active;
    if (!active) return;
    const t = setTimeout(refreshSummary, 1000);
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
                    <th>Album artist</th>
                    <th>Album</th>
                    <th class="tm-num">Tracks</th>
                    <th>Status</th>
                    <th>Format</th>
                    <th class="tm-hide-sm">Folder</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => (
                    <tr key={r.id}>
                      <td>{r.artist ?? <span class="tm-muted">–</span>}</td>
                      <td>
                        <a href={`/releases/${r.id}`} onClick={onLinkClick}>
                          {r.album ?? <span class="tm-muted">Loose files</span>}
                        </a>
                        {r.errorCount > 0 && <span class="tm-badge tm-badge-error">{r.errorCount} unreadable</span>}
                        {r.mbid && <span class="tm-badge" title={r.mbid}>MBID</span>}
                      </td>
                      <td class="tm-num">{r.trackCount}</td>
                      <td>
                        <StatusBadge status={r.status} />
                      </td>
                      <td>{r.formats.join(", ")}</td>
                      <td class="tm-path tm-hide-sm">{r.folder || "/"}</td>
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
