import type { LibrarySummary } from "../../../shared/types.ts";
import { when } from "../format.ts";

export function scanActive(s: LibrarySummary | null): boolean {
  return !!s?.scan && (s.scan.state === "queued" || s.scan.state === "running");
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
