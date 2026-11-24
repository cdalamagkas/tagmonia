/**
 * Review and write (§10, §11.3): what each field would become, where the value
 * comes from, the user's decision per field, locks, and writing with undo.
 * Release-level fields are decided once for every file of the release.
 */
import { useEffect, useState } from "preact/hooks";
import type {
  FieldDecision,
  FieldProposalDto,
  HistoryResponse,
  LibraryFileDto,
  LockDto,
  ProposalDto,
  ProposalResponse,
  WriteBatchDto,
} from "../../../shared/types.ts";
import { api } from "../api.ts";
import { RELEASE_FIELDS, tagValue, when } from "../format.ts";

const PROVIDERS: Record<string, string> = {
  musicbrainz: "MusicBrainz",
  deezer: "Deezer",
  itunes: "iTunes",
  discogs: "Discogs",
};

/** "Also found on": where the release is on other providers, and why not when it is not (D47). */
function ProviderMatches({ matches }: { matches: ProposalDto["providers"] }) {
  if (matches.length === 0) return null;
  const label = (m: ProposalDto["providers"][number]) => {
    switch (m.status) {
      case "found":
        return m.via === "link" ? "found (linked from MusicBrainz)" : "found (by barcode)";
      case "different_edition":
        return `another edition: ${m.reason}`;
      case "not_found":
        return "not found";
      case "skipped":
        return m.reason ?? "skipped";
      case "error":
        return `could not check: ${m.reason ?? "error"}`;
    }
  };
  return (
    <p class="tm-section-note">
      <span class="tm-muted">Also on:</span> {matches.map((m, i) => (
        <span key={m.provider}>
          {i > 0 && " · "}
          <span
            class={`tm-badge tm-inline ${
              m.status === "found" ? "tm-badge-ok" : m.status === "different_edition" ? "tm-badge-warn" : ""
            }`}
            title={label(m)}
          >
            {m.url && (m.status === "found" || m.status === "different_edition")
              ? <a href={m.url} target="_blank" rel="noopener noreferrer">{PROVIDERS[m.provider]}</a>
              : PROVIDERS[m.provider]}
          </span>{" "}
          <span class="tm-muted">{label(m)}</span>
        </span>
      ))}
    </p>
  );
}
const RELEASE = new Set<string>(RELEASE_FIELDS);

/** One reviewable line: a release field across all files, or one field of one file. */
interface Group {
  key: string;
  field: FieldProposalDto["field"];
  rows: FieldProposalDto[];
}

/** A row that the write will change. */
function writes(r: FieldProposalDto): boolean {
  if (r.locked || r.decision === "kept_current") return false;
  return r.status !== "unchanged" || r.decision === "edited";
}

function distinct(values: unknown[]): string[] {
  return [...new Set(values.map((v) => tagValue(v)))];
}

function statusOf(g: Group): FieldProposalDto["status"] {
  if (g.rows.some((r) => r.status === "changed")) return "changed";
  if (g.rows.some((r) => r.status === "added")) return "added";
  return "unchanged";
}

/** Parses the edit box into the field's type, shaped like the proposed value. */
function parseEdit(text: string, like: unknown): unknown {
  if (Array.isArray(like)) return text.split("\n").map((s) => s.trim()).filter(Boolean);
  if (typeof like === "number") return Number(text);
  return text;
}

function editText(v: unknown): string {
  return Array.isArray(v) ? v.join("\n") : v === null || v === undefined ? "" : String(v);
}

function lockLabel(l: LockDto): string {
  return l.scope === "global_field"
    ? "locked everywhere"
    : l.scope === "release"
    ? "locked for this album"
    : "locked for this file";
}

interface RowProps {
  group: Group;
  locks: LockDto[];
  releaseId: number;
  busy: boolean;
  onDecide: (ids: number[], decision: FieldDecision, edited?: unknown) => Promise<void>;
  onLock: (field: Group["field"], scope: "release" | "global_field" | "file", target: string) => Promise<void>;
  onUnlock: (lockId: number) => Promise<void>;
}

function FieldRow({ group, locks, releaseId, busy, onDecide, onLock, onUnlock }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const ids = group.rows.map((r) => r.id);
  const first = group.rows[0];
  const status = statusOf(group);
  const decisions = new Set(group.rows.map((r) => r.decision));
  const decision = decisions.size === 1 ? first.decision : "mixed";
  const locked = group.rows.every((r) => r.locked);
  const editable = typeof first.proposed !== "object" || Array.isArray(first.proposed);
  const fileIds = new Set(group.rows.map((r) => String(r.fileId)));
  const myLocks = locks.filter((l) =>
    l.field === group.field &&
    (l.scope === "global_field" || (l.scope === "release" && l.target === String(releaseId)) ||
      (l.scope === "file" && fileIds.has(l.target)))
  );
  const currents = distinct(group.rows.map((r) => r.current));
  const target = decision === "edited" ? first.edited : first.proposed;
  const sources = [...new Set(group.rows.flatMap((r) => r.sources.map((s) => s.provider)))];

  return (
    <tr class={writes(first) ? "" : "tm-row-quiet"}>
      <th>{group.field}</th>
      <td>
        {currents.length === 1
          ? (currents[0]
            ? <span class={writes(first) ? "tm-diff-old" : ""}>{currents[0]}</span>
            : <span class="tm-muted">(not set)</span>)
          : (
            <>
              <span class="tm-badge tm-badge-warn tm-inline">differs across files</span>
              <ul class="tm-values">
                {currents.map((v) => <li key={v}>{v || <span class="tm-muted">(not set)</span>}</li>)}
              </ul>
            </>
          )}
      </td>
      <td>
        {editing
          ? (
            <form
              class="tm-edit"
              onSubmit={async (e) => {
                e.preventDefault();
                await onDecide(ids, "edited", parseEdit(text, first.proposed));
                setEditing(false);
              }}
            >
              {Array.isArray(first.proposed)
                ? (
                  <textarea
                    rows={3}
                    value={text}
                    onInput={(e) => setText(e.currentTarget.value)}
                    aria-label="One value per line"
                  />
                )
                : (
                  <input
                    type={typeof first.proposed === "number" ? "number" : "text"}
                    value={text}
                    onInput={(e) => setText(e.currentTarget.value)}
                  />
                )}
              <button type="submit" class="tm-button tm-small" disabled={busy}>Save</button>
              <button type="button" class="tm-button tm-secondary tm-small" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </form>
          )
          : (
            <>
              <span class={writes(first) ? "tm-diff-new" : ""}>{tagValue(target)}</span>{" "}
              {status !== "unchanged" && (
                <span class={`tm-badge tm-inline ${status === "added" ? "tm-badge-ok" : "tm-badge-warn"}`}>
                  {status}
                </span>
              )}
              {decision === "edited" && <span class="tm-badge tm-inline">your value</span>}
              {sources.map((s) => <span key={s} class="tm-badge tm-chip">{PROVIDERS[s] ?? s}</span>)}
            </>
          )}
      </td>
      <td class="tm-decide">
        {locked
          ? (
            <>
              {myLocks.map((l) => (
                <span key={l.id}>
                  <span class="tm-badge tm-inline">{lockLabel(l)}</span>{" "}
                  <button
                    type="button"
                    class="tm-linklike tm-small-link"
                    disabled={busy}
                    onClick={() => onUnlock(l.id)}
                  >
                    unlock
                  </button>
                </span>
              ))}
            </>
          )
          : !editing && (
            <>
              <div class="tm-seg" role="group" aria-label={`Decision for ${group.field}`}>
                <button
                  type="button"
                  class={decision === "auto" || decision === "accepted" ? "tm-on" : ""}
                  disabled={busy}
                  onClick={() => onDecide(ids, "accepted")}
                >
                  Use proposed
                </button>
                <button
                  type="button"
                  class={decision === "kept_current" ? "tm-on" : ""}
                  disabled={busy}
                  onClick={() => onDecide(ids, "kept_current")}
                >
                  Keep current
                </button>
                {editable && (
                  <button
                    type="button"
                    class={decision === "edited" ? "tm-on" : ""}
                    disabled={busy}
                    onClick={() => {
                      setText(editText(decision === "edited" ? first.edited : first.proposed));
                      setEditing(true);
                    }}
                  >
                    Edit…
                  </button>
                )}
              </div>
              <div class="tm-lock-links">
                {RELEASE.has(group.field)
                  ? (
                    <button
                      type="button"
                      class="tm-linklike tm-small-link"
                      disabled={busy}
                      onClick={() => onLock(group.field, "release", String(releaseId))}
                    >
                      lock for this album
                    </button>
                  )
                  : (
                    <button
                      type="button"
                      class="tm-linklike tm-small-link"
                      disabled={busy}
                      onClick={() => onLock(group.field, "file", String(first.fileId))}
                    >
                      lock for this file
                    </button>
                  )}
                {" · "}
                <button
                  type="button"
                  class="tm-linklike tm-small-link"
                  disabled={busy}
                  onClick={() => onLock(group.field, "global_field", "")}
                >
                  lock everywhere
                </button>
              </div>
            </>
          )}
      </td>
    </tr>
  );
}

function FieldTable({ groups, ...props }: { groups: Group[] } & Omit<RowProps, "group">) {
  return (
    <div class="tm-table-wrap">
      <table class="tm-table tm-review">
        <thead>
          <tr>
            <th>Field</th>
            <th>In the files now</th>
            <th>Proposed</th>
            <th>Decision</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => <FieldRow key={g.key} group={g} {...props} />)}
        </tbody>
      </table>
    </div>
  );
}

function History(
  { data, readOnly, onUndo }: { data: HistoryResponse; readOnly: boolean; onUndo: (b: WriteBatchDto) => void },
) {
  const [open, setOpen] = useState<number | null>(null);
  if (data.batches.length === 0) return null;
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

export function Review(
  { releaseId, files, version, onFilesChanged }: {
    releaseId: number;
    files: LibraryFileDto[];
    /** Bumped by the page when the user picks a release, so the panel reloads. */
    version: number;
    onFilesChanged: () => void;
  },
) {
  const [data, setData] = useState<ProposalResponse | null>(null);
  const [hist, setHist] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showUnchanged, setShowUnchanged] = useState(false);

  const load = async () => {
    try {
      const [p, h] = await Promise.all([api.proposal(releaseId), api.history(releaseId)]);
      // A batch that finished since the last load changed the files on disk.
      if (hist && hist.job && !h.job) onFilesChanged();
      setData(p);
      setHist(h);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    load();
  }, [releaseId, version]);

  // Poll while a proposal is being built or a write/undo runs.
  const live = !!data?.job || !!hist?.job;
  useEffect(() => {
    if (!live) return;
    const t = setTimeout(load, 1500);
    return () => clearTimeout(t);
  }, [data, hist]);

  /** Runs an action, then reloads; errors (409 etc.) are shown, not thrown. */
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

  if (!data || !hist) return null;
  const p = data.proposal;
  if (!p) {
    return data.job
      ? (
        <section class="tm-card">
          <h2>Proposed tags</h2>
          <p class="tm-muted">Building the proposal…</p>
        </section>
      )
      : <History data={hist} readOnly={data.readOnly} onUndo={(b) => act(() => api.undo(b.id))} />;
  }

  const open = p.state === "needs_review" || p.state === "approved" || p.state === "draft";
  const toWrite = p.fields.filter(writes).length;
  const fileName = new Map(files.map((f) => [f.id, f.tags.title ?? f.path.split("/").pop() ?? f.path]));
  const relGroups: Group[] = RELEASE_FIELDS
    .map((field) => ({ key: field, field, rows: p.fields.filter((f) => f.field === field) }))
    .filter((g) =>
      g.rows.length && (showUnchanged || g.rows.some((r) => r.status !== "unchanged" || r.decision === "edited"))
    );
  const byFile = new Map<number, Group[]>();
  for (const f of p.fields) {
    if (RELEASE.has(f.field)) continue;
    if (!showUnchanged && f.status === "unchanged" && f.decision !== "edited") continue;
    const list = byFile.get(f.fileId) ?? [];
    list.push({ key: `${f.fileId}:${f.field}`, field: f.field, rows: [f] });
    byFile.set(f.fileId, list);
  }
  const rowProps = {
    locks: data.locks,
    releaseId,
    busy: busy || !open,
    onDecide: (ids: number[], decision: FieldDecision, edited?: unknown) =>
      act(() => api.decide(p.id, { fieldIds: ids, decision, ...(edited !== undefined ? { edited } : {}) })),
    onLock: (field: Group["field"], scope: "release" | "global_field" | "file", target: string) =>
      act(() => api.lock({ scope, target, field })),
    onUnlock: (lockId: number) => act(() => api.unlock(lockId)),
  };

  return (
    <>
      <section class="tm-card">
        <div class="tm-toolbar">
          <div>
            <h2>
              Proposed tags{" "}
              <span class={`tm-badge tm-inline ${p.state === "written" ? "tm-badge-ok" : ""}`}>
                {p.state.replace("_", " ")}
              </span>
            </h2>
            <p class="tm-muted tm-section-note">
              From{" "}
              <a href={`https://musicbrainz.org/release/${p.releaseMbid}`} target="_blank" rel="noopener noreferrer">
                this MusicBrainz release
              </a>
              {p.chosenBy === "user" ? ", chosen by you" : ", matched automatically"} · {p.counts.changed} changed,{" "}
              {p.counts.added} added, {p.counts.unchanged} already right
              {p.counts.locked > 0 && `, ${p.counts.locked} locked`}
            </p>
          </div>
          <div class="tm-actions">
            {open && (
              <button
                type="button"
                class="tm-button tm-secondary"
                disabled={busy}
                onClick={() => act(() => api.discard(p.id))}
              >
                Discard
              </button>
            )}
            {open && (
              <button
                type="button"
                class="tm-button"
                disabled={busy || live || data.readOnly || p.stale || toWrite === 0}
                title={data.readOnly ? "Read-only mode: nothing is written" : undefined}
                onClick={() => act(() => api.write(p.id))}
              >
                {hist.job ? "Writing…" : `Write ${toWrite} change${toWrite === 1 ? "" : "s"} to files`}
              </button>
            )}
          </div>
        </div>
        <ProviderMatches matches={p.providers} />
        {data.readOnly && (
          <p class="tm-badge tm-badge-warn tm-inline">Read-only mode: you can review, but nothing is written.</p>
        )}
        {p.stale && open && (
          <p>
            <span class="tm-badge tm-badge-warn tm-inline">The files changed since this proposal was built.</span>{" "}
            <button
              type="button"
              class="tm-button tm-secondary tm-small"
              disabled={busy || live}
              onClick={() => act(() => api.propose(releaseId, { releaseMbid: p.releaseMbid! }))}
            >
              Build again
            </button>
          </p>
        )}
        {p.state === "discarded" && (
          <p class="tm-muted">
            Discarded.{" "}
            <button
              type="button"
              class="tm-button tm-secondary tm-small"
              disabled={busy || live}
              onClick={() => act(() => api.propose(releaseId, { releaseMbid: p.releaseMbid! }))}
            >
              Build again
            </button>
          </p>
        )}
        {error && <p class="tm-error" role="alert">{error}</p>}
        {p.unmappedFiles.length > 0 && (
          <p>
            <span class="tm-badge tm-badge-warn tm-inline">left untouched</span>{" "}
            {p.unmappedFiles.map((id) => fileName.get(id) ?? `file ${id}`).join(", ")} (no track on this release)
          </p>
        )}
        <label class="tm-check">
          <input type="checkbox" checked={showUnchanged} onChange={(e) => setShowUnchanged(e.currentTarget.checked)} />
          Show fields that are already right
        </label>

        <h3>Album</h3>
        {relGroups.length
          ? <FieldTable groups={relGroups} {...rowProps} />
          : <p class="tm-muted">Nothing to change.</p>}

        <h3>Tracks</h3>
        {byFile.size === 0 && <p class="tm-muted">Nothing to change.</p>}
        {[...byFile].map(([fileId, groups]) => (
          <div key={fileId} class="tm-file-review">
            <h4>{fileName.get(fileId) ?? `file ${fileId}`}</h4>
            <FieldTable groups={groups} {...rowProps} />
          </div>
        ))}
      </section>
      <History data={hist} readOnly={data.readOnly} onUndo={(b) => act(() => api.undo(b.id))} />
    </>
  );
}
