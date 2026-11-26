/**
 * Settings → Providers (§9.2, §14.3, D46): credentials (secrets are never shown
 * again once saved), on/off switches and a health check per provider; and how
 * cover art is written (D49).
 */
import { useEffect, useState } from "preact/hooks";
import type { CredentialFieldDto, ProviderDto, SettingsDto } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { when } from "../format.ts";
import {
  activeTemplate,
  allTemplates,
  type FileNamingSettings,
  MAX_SAVED_TEMPLATES,
  renderPath,
  TEMPLATE_FIELDS,
  validateTemplate,
} from "../../../shared/naming.ts";

const TIER: Record<ProviderDto["tier"], string> = {
  core: "core",
  enrichment: "enrichment",
  music_server: "music server",
};

function FieldInput(
  { f, value, onInput }: { f: CredentialFieldDto; value: string; onInput: (v: string) => void },
) {
  if (f.source === "environment") {
    return (
      <p class="tm-muted tm-field-env">
        {f.secret ? "Set" : f.value} — managed by an environment variable, so it can't be changed here.
      </p>
    );
  }
  return (
    <input
      type={f.secret ? "password" : f.kind === "url" ? "url" : "text"}
      autocomplete="off"
      placeholder={f.secret && f.set ? "saved — type to replace" : f.optional ? "optional" : ""}
      value={value}
      onInput={(e) => onInput(e.currentTarget.value)}
    />
  );
}

function ProviderCard({ p, onChanged }: { p: ProviderDto; onChanged: () => Promise<void> }) {
  const editable = p.fields.filter((f) => f.source !== "environment");
  const initial = () => Object.fromEntries(editable.map((f) => [f.key, f.secret ? "" : f.value ?? ""]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);
  useEffect(() => setValues(initial()), [p]);

  const act = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setNote(null);
    try {
      const text = await fn();
      if (text) setNote({ error: false, text });
      await onChanged();
    } catch (e) {
      setNote({ error: true, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  // Only what the user typed: an empty secret box means "keep the saved one".
  const changed = Object.fromEntries(
    editable
      .filter((f) => (f.secret ? values[f.key] !== "" : values[f.key] !== (f.value ?? "")))
      .map((f) => [f.key, values[f.key] === "" ? null : values[f.key]]),
  );
  const health = p.health;

  return (
    <section class="tm-card tm-provider">
      <div class="tm-toolbar">
        <div>
          <h2>
            {p.name} <span class="tm-badge tm-inline">{TIER[p.tier]}</span>
          </h2>
          <p class="tm-muted tm-section-note">{p.help}</p>
        </div>
        {p.enabled !== null && (
          <label class="tm-check">
            <input
              type="checkbox"
              checked={p.enabled}
              disabled={busy}
              onChange={(e) => {
                const enabled = e.currentTarget.checked;
                act(async () => {
                  await api.updateSettings({ providers: { [p.id]: { enabled } } });
                  return null;
                });
              }}
            />
            Use {p.name}
          </label>
        )}
      </div>

      {p.fields.length > 0 && (
        <form
          class="tm-form tm-cred-form"
          onSubmit={(e) => {
            e.preventDefault();
            act(async () => {
              const r = await api.saveCredentials(p.id, { values: changed });
              return r.restartRequired ? `Saved. ${p.name} uses new credentials after Tagmonia restarts.` : "Saved.";
            });
          }}
        >
          {p.fields.map((f) => (
            <label key={f.key}>
              <span>
                {f.label}
                {f.set && f.source === "app" && !f.error && <span class="tm-badge tm-badge-ok tm-inline">saved</span>}
                {f.error && <span class="tm-badge tm-badge-error tm-inline" title={f.error}>unreadable</span>}
              </span>
              <FieldInput f={f} value={values[f.key] ?? ""} onInput={(v) => setValues({ ...values, [f.key]: v })} />
              {f.error && <span class="tm-error">{f.error}</span>}
            </label>
          ))}
          {editable.length > 0 && (
            <div class="tm-actions">
              <button type="submit" class="tm-button" disabled={busy || Object.keys(changed).length === 0}>Save</button>
              {editable.some((f) => f.set) && (
                <button
                  type="button"
                  class="tm-button tm-secondary"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await api.saveCredentials(p.id, {
                        values: Object.fromEntries(editable.filter((f) => f.set).map((f) => [f.key, null])),
                      });
                      return "Removed.";
                    })}
                >
                  Remove saved values
                </button>
              )}
            </div>
          )}
        </form>
      )}

      <p class="tm-provider-health">
        {p.test ? <span class="tm-muted">Checking…</span> : health
          ? (
            <span>
              <span class={`tm-badge tm-inline ${health.ok ? "tm-badge-ok" : "tm-badge-error"}`}>
                {health.ok ? "working" : "problem"}
              </span>{" "}
              {health.message} <span class="tm-muted">({when(health.checkedAt)})</span>
            </span>
          )
          : <span class="tm-muted">{p.configured ? "Not checked yet." : "Not set up."}</span>}{" "}
        <button
          type="button"
          class="tm-button tm-secondary tm-small"
          disabled={busy || !!p.test}
          onClick={() =>
            act(async () => {
              await api.testProvider(p.id);
              return null;
            })}
        >
          Test
        </button>
      </p>
      {note && <p class={note.error ? "tm-error" : "tm-muted"} role={note.error ? "alert" : undefined}>{note.text}</p>}
    </section>
  );
}

type CoverMode = SettingsDto["covers"]["mode"];

const COVER_MODES: { mode: CoverMode; label: string; note: string }[] = [
  {
    mode: "embed_full",
    label: "Embed full size",
    note: "The largest image available, in every file. Best quality; each file carries the whole image.",
  },
  {
    mode: "embed_1200",
    label: "Embed about 1200 px",
    note: "Sharp on any screen without making each file much bigger.",
  },
  {
    mode: "folder",
    label: "Folder image only",
    note: "Save cover.jpg next to the tracks and leave the files' pictures alone. Jellyfin and Navidrome read it.",
  },
  {
    mode: "both",
    label: "Both",
    note: "Embed about 1200 px and also save the full-size image as cover.jpg in the folder.",
  },
];

/** Settings → Cover art (D49): how a release's cover is written. Applies to proposals built after the change. */
function CoverSettings() {
  const [mode, setMode] = useState<CoverMode | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  useEffect(() => {
    api.settings().then((s) => setMode(s.covers.mode)).catch((e) => setNote({ text: e.message, error: true }));
  }, []);
  const choose = async (m: CoverMode) => {
    const previous = mode;
    setMode(m);
    try {
      await api.updateSettings({ covers: { mode: m } });
      setNote({ text: "Saved. Proposals built from now on use it; build a release again to apply it there." });
    } catch (e) {
      setMode(previous);
      setNote({ text: (e as Error).message, error: true });
    }
  };
  return (
    <section class="tm-card">
      <h2>Cover art</h2>
      <p class="tm-muted tm-section-note">
        The front cover comes from the Cover Art Archive, or else the largest image Deezer, iTunes or Discogs has for
        the same release. It is shown in the review before anything is written.
      </p>
      {mode && (
        <div class="tm-radio-list" role="radiogroup" aria-label="How covers are written">
          {COVER_MODES.map((m) => (
            <label key={m.mode} class="tm-check">
              <input type="radio" name="cover-mode" checked={mode === m.mode} onChange={() => choose(m.mode)} />
              <span>
                <strong>{m.label}</strong>
                {m.mode === "embed_full" && <span class="tm-muted">(default)</span>}
                <br />
                <span class="tm-muted">{m.note}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      {note && <p class={note.error ? "tm-error" : "tm-muted"} role={note.error ? "alert" : undefined}>{note.text}</p>}
    </section>
  );
}

type SubmitServer = SettingsDto["submission"]["server"];

/** Two albums to show the template on: a two-disc classical release and a single-disc one. */
const EXAMPLES: { tags: Record<string, unknown>; ext: string }[] = [
  {
    tags: {
      album: "Lukas Sternath plays Franz Schubert and Franz Liszt",
      albumartist: "Lukas Sternath",
      artist: "Franz Schubert & Franz Liszt",
      composer: ["Franz Schubert"],
      title: "Der Wanderer S 558/11 (after D 489)",
      date: "2026-10-23",
      tracknumber: 1,
      discnumber: 1,
      totaldiscs: 2,
      label: ["NO SILENCE"],
    },
    ext: "flac",
  },
  {
    tags: {
      album: "Is This It",
      albumartist: "The Strokes",
      artist: "The Strokes",
      title: "Last Nite",
      date: "2001-07-30",
      tracknumber: 7,
      discnumber: 1,
      totaldiscs: 1,
      label: ["Rough Trade"],
    },
    ext: "MP3",
  },
];

/** The editor for a new or saved template: a name, the template, its live examples. */
function TemplateEditor(
  { initial, taken, onSave, onCancel }: {
    initial: { name: string; template: string };
    /** Names already in use (lower case), except this template's own. */
    taken: Set<string>;
    onSave: (name: string, template: string) => Promise<void>;
    onCancel: () => void;
  },
) {
  const [name, setName] = useState(initial.name);
  const [text, setText] = useState(initial.template);
  const problem = !name.trim()
    ? "Give the template a name"
    : taken.has(name.trim().toLowerCase())
    ? `A template is already called "${name.trim()}"`
    : validateTemplate(text);
  return (
    <form
      class="tm-template-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) onSave(name.trim(), text.trim());
      }}
    >
      <label>
        Name
        <input type="text" value={name} maxLength={80} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <label>
        Template
        <input
          type="text"
          class="tm-mono"
          value={text}
          spellcheck={false}
          onInput={(e) => setText(e.currentTarget.value)}
        />
      </label>
      {problem ? <p class="tm-error" role="alert">{problem}</p> : <Examples template={text} />}
      <p>
        <button type="submit" class="tm-button" disabled={!!problem}>Save template</button>{" "}
        <button type="button" class="tm-button tm-secondary" onClick={onCancel}>Cancel</button>
      </p>
    </form>
  );
}

function Examples({ template }: { template: string }) {
  if (validateTemplate(template)) return null;
  return (
    <div class="tm-template-examples">
      {EXAMPLES.map((x) => <code key={x.tags.title as string}>{renderPath(template, x.tags, x.ext)}</code>)}
    </div>
  );
}

/**
 * Settings → Files (D57): which template names written albums. Built-in templates, the user's saved ones
 * (create, copy, edit, delete), each with an example.
 */
function FileSettings() {
  const [files, setFiles] = useState<FileNamingSettings | null>(null);
  /** The editor: a new template (id null), or a saved one being edited. */
  const [editing, setEditing] = useState<{ id: string | null; name: string; template: string } | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  useEffect(() => {
    api.settings().then((s) => setFiles(s.files)).catch((e) => setNote({ text: e.message, error: true }));
  }, []);
  const save = async (next: FileNamingSettings, done: string) => {
    try {
      const r = await api.updateSettings({ files: next });
      setFiles(r.settings.files);
      setEditing(null);
      setNote({ text: done });
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
    }
  };
  if (!files) {
    return (
      <section class="tm-card">
        <h2>Files</h2>
        {note && <p class="tm-error" role="alert">{note.text}</p>}
      </section>
    );
  }
  const all = allTemplates(files);
  const saved = new Set(files.templates.map((t) => t.id));
  const takenExcept = (id: string | null) =>
    new Set(all.filter((t) => t.id !== id).map((t) => t.name.trim().toLowerCase()));
  return (
    <section class="tm-card">
      <h2>Files</h2>
      <p class="tm-muted tm-section-note">
        How written albums are named, relative to the library. Moving albums from an inbox and renaming albums already
        in the library use the template chosen here; both are still to come (D57), so nothing is renamed yet.
      </p>
      <div class="tm-radio-list tm-template-list" role="radiogroup" aria-label="Template in use">
        {all.map((t) => (
          <div key={t.id} class="tm-template-item">
            <label class="tm-check">
              <input
                type="radio"
                name="naming-template"
                checked={files.active === t.id}
                onChange={() => save({ ...files, active: t.id }, `Using "${t.name}".`)}
              />
              <span>
                <strong>{t.name}</strong>
                {!saved.has(t.id) && <span class="tm-muted tm-built-in">(built in)</span>}
                <br />
                <code class="tm-mono tm-small-note">{t.template}</code>
                <br />
                <span class="tm-muted tm-small-note">
                  {renderPath(t.template, EXAMPLES[0].tags, EXAMPLES[0].ext)}
                </span>
              </span>
            </label>
            <span class="tm-template-actions">
              <button
                type="button"
                class="tm-linklike tm-small-link"
                onClick={() => setEditing({ id: null, name: `${t.name} (copy)`, template: t.template })}
              >
                copy
              </button>
              {saved.has(t.id) && (
                <>
                  <button
                    type="button"
                    class="tm-linklike tm-small-link"
                    onClick={() => setEditing({ id: t.id, name: t.name, template: t.template })}
                  >
                    edit
                  </button>
                  <button
                    type="button"
                    class="tm-linklike tm-small-link"
                    disabled={files.active === t.id}
                    title={files.active === t.id ? "In use: choose another template first" : undefined}
                    onClick={() =>
                      save(
                        { ...files, templates: files.templates.filter((x) => x.id !== t.id) },
                        `Deleted "${t.name}".`,
                      )}
                  >
                    delete
                  </button>
                </>
              )}
            </span>
          </div>
        ))}
      </div>
      {editing
        ? (
          <>
            <h3>{editing.id ? `Edit "${editing.name}"` : "New template"}</h3>
            <TemplateEditor
              key={editing.id ?? `new:${editing.name}`}
              initial={editing}
              taken={takenExcept(editing.id)}
              onCancel={() => setEditing(null)}
              onSave={(name, template) => {
                if (editing.id) {
                  return save({
                    ...files,
                    templates: files.templates.map((x) => x.id === editing.id ? { ...x, name, template } : x),
                  }, `Saved "${name}".`);
                }
                const id = `custom-${Date.now().toString(36)}`;
                return save(
                  { ...files, templates: [...files.templates, { id, name, template }] },
                  `Saved "${name}". Choose it above to use it.`,
                );
              }}
            />
          </>
        )
        : (
          <p>
            <button
              type="button"
              class="tm-button tm-secondary"
              disabled={files.templates.length >= MAX_SAVED_TEMPLATES}
              onClick={() => setEditing({ id: null, name: "", template: activeTemplate(files).template })}
            >
              New template
            </button>
          </p>
        )}
      <details class="tm-fold">
        <summary>How templates work</summary>
        <ul class="tm-small-note">
          <li>
            <code>{"{field}"}</code> is a tag as it will be after writing; <code>/</code> separates folders.
          </li>
          <li>
            <code>{"{date:4}"}</code> keeps the first 4 characters; <code>{"{tracknumber:02}"}</code>{" "}
            pads with zeros to 2 digits.
          </li>
          <li>
            <code>{"{albumartist|artist}"}</code> takes the first that has a value; <code>{"{disc-}"}</code>{" "}
            gives "2-" only on releases with more than one disc.
          </li>
          <li>
            Characters that some systems refuse (<code>{'/ \\ : * ? " < > |'}</code>) become{" "}
            <code>_</code>; a missing value becomes "[unknown …]".
          </li>
          <li>Fields: {TEMPLATE_FIELDS.join(", ")}.</li>
        </ul>
      </details>
      {note && <p class={note.error ? "tm-error" : "tm-muted"} role={note.error ? "alert" : undefined}>{note.text}</p>}
    </section>
  );
}

/** Settings → MusicBrainz submissions (D52): where releases missing from MusicBrainz are added. */
function SubmissionSettings() {
  const [server, setServer] = useState<SubmitServer | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  useEffect(() => {
    api.settings().then((s) => setServer(s.submission.server)).catch((e) => setNote({ text: e.message, error: true }));
  }, []);
  const choose = async (v: SubmitServer) => {
    const previous = server;
    setServer(v);
    try {
      await api.updateSettings({ submission: { server: v } });
      setNote({ text: "Saved. It applies to submissions prepared from now on." });
    } catch (e) {
      setServer(previous);
      setNote({ text: (e as Error).message, error: true });
    }
  };
  const options: { value: SubmitServer; label: string; note: string }[] = [
    {
      value: "https://musicbrainz.org",
      label: "musicbrainz.org",
      note: "The real database. What you submit there is public and is how Jellyfin and others will know the release.",
    },
    {
      value: "https://test.musicbrainz.org",
      label: "test.musicbrainz.org",
      note:
        "For trying submissions out, with a separate test account. Releases added there exist only there, and its identifiers mean nothing on musicbrainz.org.",
    },
  ];
  return (
    <section class="tm-card">
      <h2>MusicBrainz submissions</h2>
      <p class="tm-muted tm-section-note">
        For releases MusicBrainz does not have yet: Tagmonia opens the release editor filled in, and you submit it from
        your own account.
      </p>
      {server && (
        <div class="tm-radio-list" role="radiogroup" aria-label="Where releases are added">
          {options.map((o) => (
            <label key={o.value} class="tm-check">
              <input type="radio" name="submit-server" checked={server === o.value} onChange={() => choose(o.value)} />
              <span>
                <strong>{o.label}</strong>
                {o.value === "https://musicbrainz.org" && <span class="tm-muted">(default)</span>}
                <br />
                <span class="tm-muted">{o.note}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      {note && <p class={note.error ? "tm-error" : "tm-muted"} role={note.error ? "alert" : undefined}>{note.text}</p>}
    </section>
  );
}

export function SettingsPage() {
  const [providers, setProviders] = useState<ProviderDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    try {
      setProviders((await api.providers()).providers);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    load();
  }, []);
  // Poll while a health check runs.
  useEffect(() => {
    if (!providers?.some((p) => p.test)) return;
    const t = setTimeout(load, 1500);
    return () => clearTimeout(t);
  }, [providers]);

  return (
    <main>
      <section class="tm-card">
        <h1>Providers</h1>
        <p class="tm-muted tm-section-note">
          Where Tagmonia looks up music, and the music server it tells about changes. Secrets are stored encrypted and
          never shown again once saved; values set through environment variables take precedence.
        </p>
      </section>
      {error && <p class="tm-error" role="alert">{error}</p>}
      {providers?.map((p) => <ProviderCard key={p.id} p={p} onChanged={load} />)}
      <CoverSettings />
      <SubmissionSettings />
      <FileSettings />
    </main>
  );
}
