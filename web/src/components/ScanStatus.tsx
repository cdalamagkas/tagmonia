import type { LibrarySummary } from "../../../shared/types.ts";
import { when } from "../format.ts";

export function scanActive(s: LibrarySummary | null): boolean {
  return !!s?.scan && (s.scan.state === "queued" || s.scan.state === "running");
}

/** The watcher's inbox scan (D60) is queued or running. */
export function inboxScanActive(s: LibrarySummary | null): boolean {
  const j = s?.inbox?.lastScan;
  return !!j && (j.state === "queued" || j.state === "running");
}

export function ScanStatus({ summary }: { summary: LibrarySummary }) {
  const scan = summary.scan;
  if (!scan) return <span class="tm-muted">Never scanned</span>;
  if (scan.state === "queued") return <span class="tm-muted">Scan queued…</span>;
  if (scan.state === "running") {
    const p = scan.progress;
    return (
      <span class="tm-muted" aria-live="polite">
        Scanning… {p ? `${p.seen} files found, ${p.read} read${p.phase === "grouping" ? ", grouping" : ""}` : ""}
      </span>
    );
  }
  if (scan.state === "failed") return <span class="tm-error">Last scan failed: {scan.error}</span>;
  if (scan.state === "cancelled") return <span class="tm-muted">Last scan cancelled</span>;
  const r = scan.result;
  const notes = r
    ? [
      `${r.added} added`,
      `${r.updated} updated`,
      `${r.removed} removed`,
      r.unreadable ? `${r.unreadable} unreadable` : "",
      r.skippedSymlinks ? `${r.skippedSymlinks} symlinks skipped` : "",
    ].filter(Boolean).join(", ")
    : "";
  return <span class="tm-muted">Scanned {when(scan.finishedAt)}{notes && ` · ${notes}`}</span>;
}

/** "Jellyfin: refreshed MusicTest at …" under the scan status (§13). */
export function MusicServerStatus({ summary }: { summary: LibrarySummary }) {
  const m = summary.musicServer;
  if (!m) return null;
  const where = m.library ? `the ${m.library} library` : "all libraries";
  const j = m.lastRefresh;
  let text = `Jellyfin: ${where} is refreshed after each write`;
  if (j?.state === "queued") text = `Jellyfin: refresh of ${where} queued`;
  else if (j?.state === "running") text = `Jellyfin: refreshing ${where}…`;
  else if (j?.state === "done") text = `Jellyfin: ${where} refreshed ${when(j.finishedAt)}`;
  else if (j?.state === "failed") {
    return <p class="tm-error">Jellyfin refresh failed: {j.error}</p>;
  }
  return <p class="tm-muted">{text}</p>;
}
