/** Settings → Files & naming: whether written albums are renamed, and by which template (D57). */
import { useEffect, useState } from "preact/hooks";
import { api } from "../../api.ts";
import {
  activeTemplate,
  allTemplates,
  type FileNamingSettings,
  MAX_SAVED_TEMPLATES,
  renderPath,
  TEMPLATE_FIELDS,
  validateTemplate,
} from "../../../../shared/naming.ts";
import { Note, type NoteValue } from "./Note.tsx";

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
 * Settings → Files & naming (D57): which template names written albums. Built-in templates, the user's saved ones
 * (create, copy, edit, delete), each with an example.
 */
export function FilesNamingSection() {
  const [files, setFiles] = useState<FileNamingSettings | null>(null);
  /** The editor: a new template (id null), or a saved one being edited. */
  const [editing, setEditing] = useState<{ id: string | null; name: string; template: string } | null>(null);
  const [note, setNote] = useState<NoteValue>(null);
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
        <h2>File names</h2>
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
      <h2>File names</h2>
      <p class="tm-muted tm-section-note">
        How written albums are named, relative to the library. The release page shows the new names (Files → Location)
        before you write, and Undo puts the old ones back.
      </p>
      <label class="tm-check">
        <input
          type="checkbox"
          checked={files.renameLibrary}
          onChange={(e) =>
            save(
              { ...files, renameLibrary: e.currentTarget.checked },
              e.currentTarget.checked
                ? "Albums are renamed by the template in use when you write them."
                : "File names are left alone.",
            )}
        />
        <span>
          Rename albums in the library when writing them
          <br />
          <span class="tm-muted tm-small-note">
            Off: Tagmonia changes tags only. On: each write also renames the album's files and moves them into the
            template's folder, with the album's cover and booklet files; a name that is taken is never overwritten.
          </span>
        </span>
      </label>
      <h3>Template in use</h3>
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
      <Note note={note} />
    </section>
  );
}
