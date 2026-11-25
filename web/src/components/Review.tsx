/**
 * Review (§10): what each field would become, where the value comes from, the
 * user's decision per field, and locks. Release-level fields are decided once for
 * every file of the release. Writing and undo are the release page's (D53).
 */
import { useState } from "preact/hooks";
import type {
  CoverImageDto,
  CoverProposalDto,
  DecisionRequest,
  FieldDecision,
  FieldProposalDto,
  LibraryFileDto,
  LockDto,
  ProposalDto,
  ProposalResponse,
} from "../../../shared/types.ts";
import { api } from "../api.ts";
import { RELEASE_FIELDS, tagValue } from "../format.ts";
import { isOpen, sourceName, writes } from "../release/status.ts";

const PROVIDERS: Record<string, string> = {
  musicbrainz: "MusicBrainz",
  deezer: "Deezer",
  itunes: "iTunes",
  discogs: "Discogs",
  bandcamp: "Bandcamp",
};

/** "Also found on": where the release is on other providers, and why not when it is not (D47). */
function ProviderMatches({ matches, fromLink }: { matches: ProposalDto["providers"]; fromLink: boolean }) {
  if (matches.length === 0) return null;
  const label = (m: ProposalDto["providers"][number]) => {
    switch (m.status) {
      case "found":
        return m.via !== "link"
          ? "found (by barcode)"
          : fromLink
          ? "found (the album you linked)"
          : "found (linked from MusicBrainz)";
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
const COVER_SOURCES: Record<string, string> = { coverartarchive: "Cover Art Archive", ...PROVIDERS };

const MODES: Record<CoverProposalDto["mode"], string> = {
  embed_1200: "embedded at about 1200 px",
  embed_full: "embedded at full size",
  folder: "saved as a folder image only",
  both: "embedded at about 1200 px and saved full size as a folder image",
};

function kb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function imageLine(i: CoverImageDto): string {
  return `${i.width} × ${i.height} ${i.mime === "image/png" ? "PNG" : "JPEG"}, ${kb(i.size)}`;
}

function statusBadge(s: CoverProposalDto["embedStatus"]) {
  if (!s || s === "unchanged") return <span class="tm-badge tm-inline">already there</span>;
  return <span class={`tm-badge tm-inline ${s === "added" ? "tm-badge-ok" : "tm-badge-warn"}`}>{s}</span>;
}

/** The release's front cover (D49): what is proposed, where from, what the files have now. */
function CoverPanel(
  { cover, busy, onDecide }: {
    cover: CoverProposalDto;
    busy: boolean;
    onDecide: (d: "accepted" | "kept_current") => Promise<void>;
  },
) {
  const shown = cover.embed ?? cover.folder;
  const kept = cover.decision === "kept_current";
  const now = cover.current.withFront === 0
    ? "No file has a front cover now."
    : `Now: ${cover.current.withFront} of ${cover.current.files} files have a front cover (${
      cover.current.sizes.map(kb).join(", ")
    }).`;
  return (
    <div class="tm-cover">
      {shown
        ? <img src={shown.preview} alt="Proposed front cover" width={160} height={160} loading="lazy" />
        : <div class="tm-cover-none tm-muted">No cover</div>}
      <div>
        {cover.source
          ? (
            <>
              <p>
                From <strong>{COVER_SOURCES[cover.source] ?? cover.source}</strong>, {MODES[cover.mode]}{" "}
                <span class="tm-muted">(Settings → Cover art)</span>
              </p>
              <ul class="tm-values">
                {cover.embed && (
                  <li>
                    Embedded in each file: {imageLine(cover.embed)} {statusBadge(cover.embedStatus)}
                  </li>
                )}
                {cover.folder && (
                  <li>
                    <code>{cover.folderPath}</code>: {imageLine(cover.folder)} {statusBadge(cover.folderStatus)}
                  </li>
                )}
              </ul>
            </>
          )
          : <p class="tm-muted">No cover found on the Cover Art Archive or the other providers.</p>}
        <p class="tm-muted">{now}</p>
        {cover.skipped.length > 0 && (
          <p class="tm-muted tm-small-note">
            Passed over: {cover.skipped.map((s) => `${COVER_SOURCES[s.source] ?? s.source} (${s.reason})`).join("; ")}
          </p>
        )}
        {cover.source && (cover.embed || cover.folder) && (
          <div class="tm-seg" role="group" aria-label="Decision for the cover">
            <button
              type="button"
              class={kept ? "" : "tm-on"}
              disabled={busy}
              onClick={() =>
                onDecide("accepted")}
            >
              Use this cover
            </button>
            <button
              type="button"
              class={kept ? "tm-on" : ""}
              disabled={busy}
              onClick={() =>
                onDecide("kept_current")}
            >
              Keep current
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const RELEASE = new Set<string>(RELEASE_FIELDS);

/** One reviewable line: a release field across all files, or one field of one file. */
interface Group {
  key: string;
  field: FieldProposalDto["field"];
  rows: FieldProposalDto[];
}

/** Shown without "show unchanged": it changes something, or its sources disagree. */
function visible(r: FieldProposalDto): boolean {
  return r.status !== "unchanged" || r.decision === "edited" || r.conflict;
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
  /** The proposal's own source; values from any other are marked "filled by". */
  primary: string;
  locks: LockDto[];
  releaseId: number;
  busy: boolean;
  onDecide: (ids: number[], decision: FieldDecision, edited?: unknown) => Promise<void>;
  /** Settle the rows with one source's value (D48). */
  onPick: (ids: number[], source: NonNullable<DecisionRequest["source"]>) => Promise<void>;
  onLock: (field: Group["field"], scope: "release" | "global_field" | "file", target: string) => Promise<void>;
  onUnlock: (lockId: number) => Promise<void>;
}

/** Each source's value once, for choosing between conflicting ones. */
function sourceChoices(group: Group): { provider: string; value: unknown }[] {
  const seen = new Map<string, unknown>();
  for (const r of group.rows) for (const s of r.sources) if (!seen.has(s.provider)) seen.set(s.provider, s.value);
  return [...seen].map(([provider, value]) => ({ provider, value }));
}

function FieldRow({ group, primary, locks, releaseId, busy, onDecide, onPick, onLock, onUnlock }: RowProps) {
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
  const origins = [...new Set(group.rows.map((r) => r.origin).filter((o) => o !== primary))];
  const conflict = group.rows.some((r) => r.conflict);
  const unresolved = group.rows.some((r) => r.conflict && r.decision === "auto" && !r.locked);
  const picked = first.resolvedFrom;

  return (
    <tr class={unresolved ? "tm-row-conflict" : writes(first) ? "" : "tm-row-quiet"}>
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
              {decision === "edited" && !picked && <span class="tm-badge tm-inline">your value</span>}
              {origins.map((o) => (
                <span key={o} class="tm-badge tm-inline tm-badge-info" title="MusicBrainz has no value here">
                  filled by {PROVIDERS[o] ?? o}
                </span>
              ))}
              {sources.map((s) => <span key={s} class="tm-badge tm-chip">{PROVIDERS[s] ?? s}</span>)}
              {conflict && (
                <div class="tm-conflict">
                  <span class={`tm-badge tm-inline ${unresolved ? "tm-badge-error" : ""}`}>
                    {unresolved
                      ? "sources disagree: choose one"
                      : picked
                      ? `settled: ${PROVIDERS[picked] ?? picked}`
                      : "sources disagree: decided"}
                  </span>
                  <ul class="tm-values">
                    {sourceChoices(group).map((c) => (
                      <li key={c.provider}>
                        <span class="tm-muted">{PROVIDERS[c.provider] ?? c.provider}:</span> {tagValue(c.value)}{" "}
                        {!locked && (
                          <button
                            type="button"
                            class="tm-linklike tm-small-link"
                            disabled={busy || picked === c.provider}
                            onClick={() => onPick(ids, c.provider as NonNullable<DecisionRequest["source"]>)}
                          >
                            {picked === c.provider ? "using" : "use this"}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
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
                  class={(decision === "auto" && !unresolved) || (decision === "accepted" && !picked) ? "tm-on" : ""}
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

/**
 * The proposed changes (the Changes tab, D53). Writing, building again and the proposal's state are the
 * page header's; this card is what would change and the per-field decisions.
 */
export function Review(
  { releaseId, data, files, live, onReload }: {
    releaseId: number;
    /** Loaded and kept live by the release page. */
    data: ProposalResponse;
    files: LibraryFileDto[];
    /** A job for the release runs: no decisions meanwhile. */
    live: boolean;
    onReload: () => Promise<void>;
  },
) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const load = onReload;

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

  const p = data.proposal;
  if (!p) {
    return (
      <section class="tm-card">
        <p class="tm-muted">
          {data.job ? "Preparing the changes…" : "No changes proposed yet: choose a release in the Match tab."}
        </p>
      </section>
    );
  }

  const open = isOpen(p);
  const conflicts = p.counts.conflicts;
  const fileName = new Map(files.map((f) => [f.id, f.tags.title ?? f.path.split("/").pop() ?? f.path]));
  const relGroups: Group[] = RELEASE_FIELDS
    .map((field) => ({ key: field, field, rows: p.fields.filter((f) => f.field === field) }))
    .filter((g) => g.rows.length && (showUnchanged || g.rows.some(visible)));
  const byFile = new Map<number, Group[]>();
  for (const f of p.fields) {
    if (RELEASE.has(f.field)) continue;
    if (!showUnchanged && !visible(f)) continue;
    const list = byFile.get(f.fileId) ?? [];
    list.push({ key: `${f.fileId}:${f.field}`, field: f.field, rows: [f] });
    byFile.set(f.fileId, list);
  }
  const rowProps = {
    primary: p.primarySource ?? "musicbrainz",
    locks: data.locks,
    releaseId,
    busy: busy || live || !open,
    onDecide: (ids: number[], decision: FieldDecision, edited?: unknown) =>
      act(() => api.decide(p.id, { fieldIds: ids, decision, ...(edited !== undefined ? { edited } : {}) })),
    onPick: (ids: number[], source: NonNullable<DecisionRequest["source"]>) =>
      act(() => api.decide(p.id, { fieldIds: ids, decision: "accepted", source })),
    onLock: (field: Group["field"], scope: "release" | "global_field" | "file", target: string) =>
      act(() => api.lock({ scope, target, field })),
    onUnlock: (lockId: number) => act(() => api.unlock(lockId)),
  };

  return (
    <>
      <section class="tm-card">
        <div class="tm-toolbar">
          <div>
            <h2>Proposed changes</h2>
            <p class="tm-muted tm-section-note">
              From {p.releaseMbid
                ? (
                  <>
                    <a
                      href={`${p.mbServer ?? "https://musicbrainz.org"}/release/${p.releaseMbid}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      this MusicBrainz release
                    </a>
                    {p.mbServer && (
                      <span
                        class="tm-badge tm-badge-warn tm-inline"
                        title="These identifiers exist only on the test server"
                      >
                        {new URL(p.mbServer).host}
                      </span>
                    )}
                  </>
                )
                : (
                  <>
                    <a href={p.sourceUrl ?? undefined} target="_blank" rel="noopener noreferrer">
                      this {sourceName(p.sourceUrl)} album
                    </a>{" "}
                    <span class="tm-badge tm-badge-warn tm-inline" title="No MusicBrainz identifiers are written">
                      not on MusicBrainz
                    </span>
                  </>
                )}
              {p.chosenBy === "user" ? ", chosen by you" : ", matched automatically"} · {p.counts.changed} changed,{" "}
              {p.counts.added} added, {p.counts.unchanged} already right
              {p.counts.locked > 0 && `, ${p.counts.locked} locked`}
              {p.counts.filled > 0 && `, ${p.counts.filled} filled by other providers`}
            </p>
          </div>
          <div class="tm-actions">
            {open && (
              <button
                type="button"
                class="tm-button tm-secondary"
                disabled={busy || live}
                onClick={() => act(() => api.discard(p.id))}
              >
                Discard
              </button>
            )}
          </div>
        </div>
        <ProviderMatches matches={p.providers} fromLink={!p.releaseMbid} />
        {conflicts > 0 && open && (
          <p id="tm-conflicts">
            <span class="tm-badge tm-badge-error tm-inline">
              {conflicts} field{conflicts === 1 ? "" : "s"} where MusicBrainz and another provider disagree
            </span>{" "}
            <span class="tm-muted">Pick a value (or keep, edit or lock the field) before writing.</span>
          </p>
        )}
        {data.readOnly && (
          <p class="tm-badge tm-badge-warn tm-inline">Read-only mode: you can review, but nothing is written.</p>
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

        {p.cover && (
          <>
            <h3>Cover</h3>
            <CoverPanel
              cover={p.cover}
              busy={busy || !open}
              onDecide={(decision) => act(() => api.coverDecision(p.id, { decision }))}
            />
          </>
        )}

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
    </>
  );
}
