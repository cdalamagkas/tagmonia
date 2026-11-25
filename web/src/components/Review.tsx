/**
 * The Changes tab (§10; docs/proposals/release-page-restructure.md, PR 2): only what a write would
 * change, as one line per change with a checkbox ("include in the write"), grouped as Needs your
 * choice, Cover, Album and Tracks. Clicking a new value edits it; the ⋯ menu holds the rest. The
 * write bar below says how many changes are selected. Grouping and counting: release/changes.ts.
 */
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type {
  CoverProposalDto,
  CurrentCoverDto,
  DecisionRequest,
  FieldDecision,
  FieldProposalDto,
  LibraryFileDto,
  LockDto,
  ProposalDto,
  ProposalResponse,
} from "../../../shared/types.ts";
import { api } from "../api.ts";
import { tagValue } from "../format.ts";
import {
  alreadyRightView,
  buildChanges,
  type ChangeItem,
  coverProposes,
  locksOf,
  type RightField,
} from "../release/changes.ts";
import { isOpen } from "../release/status.ts";

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

/** Parses the edit box into the field's type, shaped like the proposed value. */
function parseEdit(text: string, like: unknown): unknown {
  if (Array.isArray(like)) return text.split("\n").map((s) => s.trim()).filter(Boolean);
  if (typeof like === "number") return Number(text);
  return text;
}

function editText(v: unknown): string {
  return Array.isArray(v) ? v.join("\n") : v === null || v === undefined ? "" : String(v);
}

/** What a lock means, in the words the ⋯ menu uses to set it. */
function lockLabel(l: LockDto): string {
  return l.scope === "global_field"
    ? "never changes on any album"
    : l.scope === "release"
    ? "never changes on this album"
    : "never changes on this track";
}

function shown(v: unknown): ComponentChildren {
  const t = tagValue(v);
  return t === "" ? <span class="tm-muted">(not set)</span> : t;
}

/** Each source's value once, for choosing between disagreeing ones (D48). */
function sourceChoices(item: ChangeItem): { provider: string; value: unknown }[] {
  const seen = new Map<string, unknown>();
  for (const r of item.rows) for (const s of r.sources) if (!seen.has(s.provider)) seen.set(s.provider, s.value);
  return [...seen].map(([provider, value]) => ({ provider, value }));
}

interface Actions {
  releaseId: number;
  locks: LockDto[];
  busy: boolean;
  onDecide: (ids: number[], decision: FieldDecision, edited?: unknown) => Promise<void>;
  onPick: (ids: number[], source: NonNullable<DecisionRequest["source"]>) => Promise<void>;
  onLock: (
    field: FieldProposalDto["field"],
    scope: "release" | "global_field" | "file",
    target: string,
  ) => Promise<void>;
  onUnlock: (lockId: number) => Promise<void>;
}

/** The include checkbox; "mixed" when some files write the value and some keep theirs. */
function Include({ item, a, label }: { item: ChangeItem; a: Actions; label: string }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={item.included}
      ref={(el) => {
        if (el) el.indeterminate = item.mixed;
      }}
      disabled={a.busy || item.locked}
      title={item.locked ? "Locked: unlock it in the ⋯ menu" : undefined}
      onChange={() => a.onDecide(item.ids, item.included ? "kept_current" : "accepted")}
    />
  );
}

/** The ⋯ menu: edit, back to the proposed value, and the standing "never change" rules (locks). */
function Menu({ item, a, onEdit }: { item: ChangeItem; a: Actions; onEdit: (() => void) | null }) {
  const locks = locksOf(item, a.locks, a.releaseId);
  const fileTarget = item.scope === "track" && item.fileId !== null ? String(item.fileId) : null;
  const ref = useRef<HTMLDetailsElement>(null);
  // A menu closes when one of its items is chosen, and when the user clicks or presses Escape elsewhere.
  useEffect(() => {
    const close = (e: Event) => {
      const d = ref.current;
      if (!d?.open) return;
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !d.contains(e.target as Node)) d.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);
  return (
    <details
      class="tm-menu"
      ref={ref}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("[role=menuitem]")) ref.current!.open = false;
      }}
    >
      <summary aria-label={`More for ${item.field}`} title="More">⋯</summary>
      <div class="tm-menu-list" role="menu">
        {onEdit && !item.locked && (
          <button type="button" role="menuitem" disabled={a.busy} onClick={onEdit}>Edit the value…</button>
        )}
        {item.edited && !item.locked && (
          <button
            type="button"
            role="menuitem"
            disabled={a.busy}
            onClick={() => a.onDecide(item.ids, "accepted")}
          >
            Use the proposed value
          </button>
        )}
        {item.locked
          ? locks.map((l) => (
            <button
              key={l.id}
              type="button"
              role="menuitem"
              disabled={a.busy}
              onClick={() => a.onUnlock(l.id)}
            >
              Allow changes again ({lockLabel(l)})
            </button>
          ))
          : (
            <>
              {fileTarget
                ? (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={a.busy}
                    onClick={() => a.onLock(item.field, "file", fileTarget)}
                  >
                    Never change on this track
                  </button>
                )
                : (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={a.busy}
                    onClick={() => a.onLock(item.field, "release", String(a.releaseId))}
                  >
                    Never change on this album
                  </button>
                )}
              <button
                type="button"
                role="menuitem"
                disabled={a.busy}
                onClick={() => a.onLock(item.field, "global_field", "")}
              >
                Never change on any album
              </button>
            </>
          )}
      </div>
    </details>
  );
}

/** The edit box in place of the value. */
function EditBox({ item, a, onDone }: { item: ChangeItem; a: Actions; onDone: () => void }) {
  const [text, setText] = useState(editText(item.value));
  const like = item.rows[0].proposed;
  return (
    <form
      class="tm-edit"
      onSubmit={async (e) => {
        e.preventDefault();
        await a.onDecide(item.ids, "edited", parseEdit(text, like));
        onDone();
      }}
    >
      {Array.isArray(like)
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
            type={typeof like === "number" ? "number" : "text"}
            value={text}
            onInput={(e) => setText(e.currentTarget.value)}
            aria-label={`New value for ${item.field}`}
          />
        )}
      <button type="submit" class="tm-button tm-small" disabled={a.busy}>Save</button>
      <button type="button" class="tm-button tm-secondary tm-small" onClick={onDone}>Cancel</button>
    </form>
  );
}

function editable(item: ChangeItem): boolean {
  const v = item.rows[0].proposed;
  return typeof v !== "object" || v === null || Array.isArray(v);
}

/** Small marks after a value: where it comes from, the user's own value, a lock, a settled disagreement. */
function Marks({ item, a }: { item: ChangeItem; a: Actions }) {
  const locks = item.locked ? locksOf(item, a.locks, a.releaseId) : [];
  const settled = item.rows.find((r) => r.resolvedFrom)?.resolvedFrom;
  return (
    <>
      {item.filledBy && <span class="tm-badge tm-chip">filled by {PROVIDERS[item.filledBy] ?? item.filledBy}</span>}
      {item.edited && !settled && <span class="tm-badge tm-chip">your value</span>}
      {settled && <span class="tm-badge tm-chip">chosen: {PROVIDERS[settled] ?? settled}</span>}
      {locks.length > 0 && <span class="tm-badge tm-chip">🔒 {lockLabel(locks[0])}</span>}
    </>
  );
}

/** "current → new", the new value clickable to edit it. */
function Values({ item, a, onEdit }: { item: ChangeItem; a: Actions; onEdit: (() => void) | null }) {
  const current = item.current.length > 1
    ? (
      <span
        class="tm-badge tm-badge-warn tm-inline"
        title={item.current.map((v) => tagValue(v) || "(not set)").join("\n")}
      >
        differs across files
      </span>
    )
    : shown(item.current[0]);
  return (
    <span class="tm-change-values">
      {/* Nothing to strike out when the files have no value. */}
      <span class={(item.included || item.mixed) && tagValue(item.current[0]) !== "" ? "tm-diff-old" : ""}>
        {current}
      </span>
      <span class="tm-muted" aria-hidden="true">→</span>
      {onEdit && !item.locked
        ? (
          <button type="button" class="tm-linklike tm-change-new" title="Edit" disabled={a.busy} onClick={onEdit}>
            {shown(item.value)}
          </button>
        )
        : <span class="tm-change-new">{shown(item.value)}</span>}
    </span>
  );
}

/** One change line: [✓] field  current → new  marks  ⋯ */
function ChangeLine({ item, a, label }: { item: ChangeItem; a: Actions; label?: ComponentChildren }) {
  const [editing, setEditing] = useState(false);
  const onEdit = editable(item) ? () => setEditing(true) : null;
  return (
    <div class={`tm-change${item.included || item.mixed ? "" : " tm-change-off"}`}>
      <Include item={item} a={a} label={`Write ${item.field}`} />
      <span class="tm-change-field">{label ?? item.field}</span>
      {editing
        ? <EditBox item={item} a={a} onDone={() => setEditing(false)} />
        : <Values item={item} a={a} onEdit={onEdit} />}
      <span class="tm-change-marks">
        <Marks item={item} a={a} />
      </span>
      <Menu item={item} a={a} onEdit={onEdit} />
    </div>
  );
}

/** A field whose sources disagree (D48): each source's value with "Use this", or keep or edit it. */
function ChoiceLine({ item, a, trackName }: { item: ChangeItem; a: Actions; trackName: string | null }) {
  const [editing, setEditing] = useState(false);
  return (
    <div class="tm-choice">
      <div class="tm-change">
        <span class="tm-change-field">{item.field}{trackName && <span class="tm-muted">· {trackName}</span>}</span>
        <span class="tm-change-values">
          <span class="tm-muted">now</span> {shown(item.current[0])}
        </span>
        <Menu item={item} a={a} onEdit={editable(item) ? () => setEditing(true) : null} />
      </div>
      {editing && <EditBox item={item} a={a} onDone={() => setEditing(false)} />}
      <ul class="tm-choice-list">
        {sourceChoices(item).map((c) => (
          <li key={c.provider}>
            <span class="tm-muted">{PROVIDERS[c.provider] ?? c.provider}:</span> {shown(c.value)}{" "}
            <button
              type="button"
              class="tm-button tm-secondary tm-small"
              disabled={a.busy}
              onClick={() => a.onPick(item.ids, c.provider as NonNullable<DecisionRequest["source"]>)}
            >
              Use this
            </button>
          </li>
        ))}
        <li>
          <button
            type="button"
            class="tm-linklike tm-small-link"
            disabled={a.busy}
            onClick={() => a.onDecide(item.ids, "kept_current")}
          >
            Keep the current value
          </button>
        </li>
      </ul>
    </div>
  );
}

function imageText(i: { width: number | null; height: number | null; mime: string; size: number }): string {
  const dims = i.width && i.height ? `${i.width} × ${i.height} ` : "";
  return `${dims}${i.mime === "image/png" ? "PNG" : i.mime === "image/jpeg" ? "JPEG" : i.mime}, ${kb(i.size)}`;
}

/** The cover as one change: the current and the proposed picture side by side (D49, D50). */
function CoverLine(
  { cover, current, releaseId, filesVersion, busy, onDecide }: {
    cover: CoverProposalDto;
    current: CurrentCoverDto | null;
    releaseId: number;
    filesVersion: number;
    busy: boolean;
    onDecide: (d: "accepted" | "kept_current") => void;
  },
) {
  const proposed = cover.embed ?? cover.folder;
  if (!proposed || !cover.source) return null;
  const included = cover.decision !== "kept_current";
  const where = [
    cover.embed && cover.embedStatus !== "unchanged" ? "embedded in each file" : null,
    cover.folder && cover.folderStatus !== "unchanged" ? `saved as ${cover.folderPath?.split("/").pop()}` : null,
  ].filter(Boolean).join(" and ");
  return (
    <div class={`tm-change tm-change-cover${included ? "" : " tm-change-off"}`}>
      <input
        type="checkbox"
        aria-label="Write the cover"
        checked={included}
        disabled={busy}
        onChange={() => onDecide(included ? "kept_current" : "accepted")}
      />
      <span class="tm-change-field">cover</span>
      <span class="tm-cover-pair">
        <figure>
          {current
            ? <img src={api.coverUrl(releaseId, "thumb", filesVersion)} alt="Current cover" width={72} height={72} />
            : <span class="tm-cover-thumb tm-cover-empty" style={{ width: "72px", height: "72px" }}>♪</span>}
          <figcaption class="tm-muted">{current ? imageText(current) : "none"}</figcaption>
        </figure>
        <span class="tm-muted" aria-hidden="true">→</span>
        <figure>
          <img src={proposed.preview} alt="Proposed cover" width={72} height={72} loading="lazy" />
          <figcaption>{imageText(proposed)}</figcaption>
        </figure>
      </span>
      <span class="tm-change-marks tm-muted tm-small-note">
        {COVER_SOURCES[cover.source] ?? cover.source}, {where || MODES[cover.mode]}{" "}
        <a href="/settings" title="Settings → Cover art">(how covers are written)</a>
      </span>
    </div>
  );
}

function RightTable({ fields }: { fields: RightField[] }) {
  return (
    <table class="tm-table tm-kv">
      <tbody>
        {fields.map((f) => (
          <tr key={f.field}>
            <th>{f.field}</th>
            <td>{shown(f.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Everything already as proposed, organised like the changes above it: the album's fields, the track
 * fields that are the same on every track (once), then one closed line per track with its own fields.
 */
function AlreadyRight(
  { p, fileOrder, trackLabel }: { p: ProposalDto; fileOrder: number[]; trackLabel: (id: number) => string },
) {
  const v = alreadyRightView(p, fileOrder);
  return (
    <div class="tm-right">
      {v.album.length > 0 && (
        <>
          <h4>Album</h4>
          <RightTable fields={v.album} />
        </>
      )}
      {v.everyTrack.length > 0 && (
        <>
          <h4>The same on every track</h4>
          <RightTable fields={v.everyTrack} />
        </>
      )}
      {v.tracks.length > 0 && (
        <>
          <h4>Each track</h4>
          {v.tracks.map((t) => (
            <details key={t.fileId} class="tm-fold tm-right-track">
              <summary>
                {trackLabel(t.fileId)}{" "}
                <span class="tm-muted">· {t.fields.length} field{t.fields.length === 1 ? "" : "s"}</span>
              </summary>
              <RightTable fields={t.fields} />
            </details>
          ))}
        </>
      )}
    </div>
  );
}

export function Review(
  { releaseId, data, files, live, currentCover, filesVersion, onReload }: {
    releaseId: number;
    /** Loaded and kept live by the release page. */
    data: ProposalResponse;
    files: LibraryFileDto[];
    /** A job for the release runs: no decisions meanwhile. */
    live: boolean;
    /** The cover the files have now (D50), shown next to a proposed one. */
    currentCover: CurrentCoverDto | null;
    filesVersion: number;
    onReload: () => Promise<void>;
  },
) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);

  /** Runs an action, then reloads; errors (409 etc.) are shown, not thrown. */
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onReload();
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
  const m = buildChanges(p, files.map((f) => f.id));
  const titles = new Map(files.map((f) => [f.id, f.tags.title ?? f.path.split("/").pop() ?? f.path]));
  const numbers = new Map(files.map((f) => [f.id, f.tags.tracknumber ?? null]));
  const trackName = (id: number) => titles.get(id) ?? `file ${id}`;
  const multiDisc = new Set(files.map((f) => f.tags.discnumber ?? 1)).size > 1;
  const a: Actions = {
    releaseId,
    locks: data.locks,
    busy: busy || live || !open,
    onDecide: (ids, decision, edited) =>
      act(() => api.decide(p.id, { fieldIds: ids, decision, ...(edited !== undefined ? { edited } : {}) })),
    onPick: (ids, source) => act(() => api.decide(p.id, { fieldIds: ids, decision: "accepted", source })),
    onLock: (field, scope, target) => act(() => api.lock({ scope, target, field })),
    onUnlock: (lockId) => act(() => api.unlock(lockId)),
  };
  const unresolved = m.needsChoice.length;
  const showCover = !!p.cover && coverProposes(p);
  const nothing = m.total === 0;
  const blocked = data.readOnly
    ? "Read-only mode: nothing is written"
    : p.stale
    ? "The files changed since these changes were prepared: build them again (above)"
    : unresolved > 0
    ? "Choose a value for each field that needs your choice first"
    : m.selected === 0
    ? "Nothing selected"
    : undefined;

  /** The grid column's checkbox: all of that field's cells in or out. */
  const column = (field: FieldProposalDto["field"]) => {
    const items = m.grid.map((r) => r.cells[field]).filter((i): i is ChangeItem => !!i && !i.locked);
    const all = items.length > 0 && items.every((i) => i.included);
    return (
      <input
        type="checkbox"
        aria-label={`Write ${field} on every track`}
        checked={all}
        ref={(el) => {
          if (el) el.indeterminate = !all && items.some((i) => i.included);
        }}
        disabled={a.busy || items.length === 0}
        onChange={() => a.onDecide(items.flatMap((i) => i.ids), all ? "kept_current" : "accepted")}
      />
    );
  };

  return (
    <>
      <section class="tm-card tm-changes">
        <ProviderMatches matches={p.providers} fromLink={!p.releaseMbid} />
        {p.unmappedFiles.length > 0 && (
          <p>
            <span class="tm-badge tm-badge-warn tm-inline">left untouched</span>{" "}
            {p.unmappedFiles.map((id) => trackName(id)).join(", ")} (no track on this release)
          </p>
        )}
        {!open && p.state === "written" && (
          <p class="tm-muted">These changes were written. They are listed as they were proposed.</p>
        )}
        {error && <p class="tm-error" role="alert">{error}</p>}

        {unresolved > 0 && (
          <div class="tm-change-section" id="tm-conflicts">
            <h3>
              Needs your choice <span class="tm-badge tm-badge-error tm-inline">{unresolved}</span>
            </h3>
            <p class="tm-muted tm-small-note">
              The sources disagree. Choose a value, keep the current one, or edit it.
            </p>
            {m.needsChoice.map((it) => (
              <ChoiceLine key={it.key} item={it} a={a} trackName={it.fileId !== null ? trackName(it.fileId) : null} />
            ))}
          </div>
        )}

        {showCover && (
          <div class="tm-change-section">
            <h3>Cover</h3>
            <CoverLine
              cover={p.cover!}
              current={currentCover}
              releaseId={releaseId}
              filesVersion={filesVersion}
              busy={a.busy}
              onDecide={(decision) => act(() => api.coverDecision(p.id, { decision }))}
            />
          </div>
        )}

        {m.album.length > 0 && (
          <div class="tm-change-section">
            <h3>Album</h3>
            {m.album.map((it) => <ChangeLine key={it.key} item={it} a={a} />)}
          </div>
        )}

        {(m.allTracks.length > 0 || m.grid.length > 0) && (
          <div class="tm-change-section">
            <h3>Tracks</h3>
            {m.allTracks.map((it) => (
              <ChangeLine
                key={it.key}
                item={it}
                a={a}
                label={
                  <>
                    {it.field} <span class="tm-muted">· all {it.rows.length} tracks</span>
                  </>
                }
              />
            ))}
            {m.grid.length > 0 && (
              <div class="tm-table-wrap">
                <table class="tm-table tm-track-grid">
                  <thead>
                    <tr>
                      <th class="tm-num tm-col-narrow">#</th>
                      <th>Track</th>
                      {m.gridFields.map((f) => (
                        <th key={f}>
                          <label class="tm-grid-head">{column(f)} {f}</label>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {m.grid.map((row) => (
                      <tr key={row.fileId}>
                        <td class="tm-num tm-col-narrow">{numbers.get(row.fileId) ?? ""}</td>
                        <td>{trackName(row.fileId)}</td>
                        {m.gridFields.map((f) => {
                          const it = row.cells[f];
                          return (
                            <td key={f} class={it && !it.included ? "tm-change-off" : ""}>
                              {it ? <GridCell item={it} a={a} /> : <span class="tm-muted">=</span>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {nothing && <p class="tm-muted">Nothing to change: the files already have these tags.</p>}

        {m.alreadyRight > 0 && (
          <div class="tm-change-section">
            <button type="button" class="tm-linklike" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
              {showAll ? "▾" : "▸"} {m.alreadyRight} field{m.alreadyRight === 1 ? "" : "s"} already right
            </button>
            {showAll && (
              <AlreadyRight
                p={p}
                fileOrder={files.map((f) => f.id)}
                trackLabel={(id) => {
                  const f = files.find((x) => x.id === id);
                  const n = f?.tags.tracknumber;
                  const disc = multiDisc && f?.tags.discnumber ? `${f.tags.discnumber}-` : "";
                  return `${n ? `${disc}${n} · ` : ""}${trackName(id)}`;
                }}
              />
            )}
          </div>
        )}
      </section>

      {open && !nothing && (
        <div class="tm-write-bar" role="region" aria-label="Write">
          <span>
            <strong>{m.selected}</strong> of {m.total} change{m.total === 1 ? "" : "s"} selected
            {unresolved > 0 && (
              <span class="tm-muted">{` · ${unresolved} need${unresolved === 1 ? "s" : ""} your choice`}</span>
            )}
          </span>
          <span class="tm-write-bar-actions">
            <button
              type="button"
              class="tm-linklike tm-small-link"
              disabled={a.busy}
              onClick={() => act(() => api.discard(p.id))}
            >
              Discard these changes
            </button>
            <button
              type="button"
              class="tm-button"
              disabled={a.busy || !!blocked}
              title={blocked}
              onClick={() => act(() => api.write(p.id))}
            >
              Write {m.selected} change{m.selected === 1 ? "" : "s"}
            </button>
          </span>
        </div>
      )}
    </>
  );
}

/** One cell of the track grid: the checkbox, the new value (the current one on hover), the ⋯ menu. */
function GridCell({ item, a }: { item: ChangeItem; a: Actions }) {
  const [editing, setEditing] = useState(false);
  const onEdit = editable(item) ? () => setEditing(true) : null;
  if (editing) return <EditBox item={item} a={a} onDone={() => setEditing(false)} />;
  const was = tagValue(item.current[0]) || "(not set)";
  return (
    <span class="tm-grid-cell">
      <Include item={item} a={a} label={`Write ${item.field}`} />
      {onEdit && !item.locked
        ? (
          <button
            type="button"
            class="tm-linklike tm-change-new"
            title={`Now: ${was}. Click to edit.`}
            onClick={onEdit}
          >
            {shown(item.value)}
          </button>
        )
        : <span class="tm-change-new" title={`Now: ${was}`}>{shown(item.value)}</span>}
      <Marks item={item} a={a} />
      <Menu item={item} a={a} onEdit={onEdit} />
    </span>
  );
}
