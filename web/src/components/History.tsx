/** Writes and undos of one release (§11.3), each expandable to its files; the latest write can be undone. */
import { useState } from "preact/hooks";
import type { HistoryResponse, WriteBatchDto } from "../../../shared/types.ts";
import { when } from "../format.ts";

export function History(
  { data, readOnly, onUndo }: { data: HistoryResponse; readOnly: boolean; onUndo: (b: WriteBatchDto) => void },
) {
  const [open, setOpen] = useState<number | null>(null);
  if (data.batches.length === 0) {
    return (
      <section class="tm-card">
        <p class="tm-muted">Nothing written to these files yet.</p>
      </section>
    );
  }
  return (
    <section class="tm-card">
      <h2>History</h2>
      <div class="tm-table-wrap">
        <table class="tm-table">
          <thead>
            <tr>
              <th>When</th>
              <th>What</th>
              <th>Result</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.batches.map((b) => (
              <>
                <tr key={b.id} class="tm-clickable" onClick={() => setOpen(open === b.id ? null : b.id)}>
                  <td>{when(b.finishedAt ?? b.startedAt)}</td>
                  <td>{b.kind === "write" ? "Wrote tags" : "Undid a write"}</td>
                  <td>
                    <span
                      class={`tm-badge tm-inline ${
                        b.status === "done" ? "tm-badge-ok" : b.status === "undone" ? "" : "tm-badge-warn"
                      }`}
                    >
                      {b.status}
                    </span>{" "}
                    {b.counts.written} written
                    {b.counts.skipped > 0 && `, ${b.counts.skipped} skipped`}
                    {b.counts.failed > 0 && `, ${b.counts.failed} failed`}
                  </td>
                  <td>
                    {b.undoable && !readOnly && (
                      <button
                        type="button"
                        class="tm-button tm-secondary tm-small"
                        onClick={(e) => {
                          e.stopPropagation();
                          onUndo(b);
                        }}
                      >
                        Undo
                      </button>
                    )}
                  </td>
                </tr>
                {open === b.id && (
                  <tr key={`${b.id}-files`} class="tm-detail-row">
                    <td colSpan={4}>
                      <ul class="tm-values">
                        {b.files.map((f) => (
                          <li key={f.path}>
                            <span class="tm-path">{f.path}</span> — {f.status.replace("_", " ")}
                            {f.error && <span class="tm-muted">: {f.error}</span>}
                          </li>
                        ))}
                      </ul>
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
