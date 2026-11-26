/**
 * Choosing where an album goes in the library (D59): browse the library's folders, or name new ones,
 * which are made only when the album is written. The choice is any folder; Tagmonia has no opinion on
 * how a library is organised (by artist, by film, by label…).
 */
import { useEffect, useState } from "preact/hooks";
import { sanitizeName, validateDestination } from "../../../shared/naming.ts";
import type { FolderListDto } from "../../../shared/types.ts";
import { api } from "../api.ts";

const join = (parts: string[]) => parts.join("/");
const split = (p: string) => (p ? p.split("/") : []);

export function FolderPicker(
  { initial, busy, onChoose, onCancel }: {
    initial: string | null;
    busy: boolean;
    onChoose: (folder: string) => void;
    onCancel: () => void;
  },
) {
  // Existing folders, then new ones below them (made on write).
  const [path, setPath] = useState<string[]>(split(initial ?? ""));
  const [fresh, setFresh] = useState<string[]>([]);
  const [list, setList] = useState<FolderListDto | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setList(null);
    api.folders(join(path)).then((l) => {
      if (!live) return;
      setList(l);
      setRecent(l.recent);
    }).catch((e) => {
      if (!live) return;
      // Not on disk (yet): a folder chosen before and made only on write, or gone since. Show it as new
      // below the deepest folder that exists.
      if (path.length > 0) {
        setFresh((f) => [path[path.length - 1], ...f]);
        setPath(path.slice(0, -1));
      } else setError((e as Error).message);
    });
    return () => {
      live = false;
    };
  }, [join(path)]);

  const all = [...path, ...fresh];
  const go = (parts: string[]) => {
    setPath(parts);
    setFresh([]);
    setFilter("");
    setError(null);
  };
  const crumbs = [
    { label: "Library", to: () => go([]) },
    ...all.map((seg, i) => ({
      label: seg,
      to: () => (i < path.length ? go(path.slice(0, i + 1)) : setFresh(fresh.slice(0, i - path.length + 1))),
    })),
  ];

  const addFolder = (e: Event) => {
    e.preventDefault();
    const n = sanitizeName(name);
    if (!n) return;
    // An existing folder of that name (any case, as Windows and SMB see it): go into it instead.
    const same = fresh.length === 0 ? list?.folders.find((f) => f.toLowerCase() === n.toLowerCase()) : undefined;
    if (same) {
      go([...path, same]);
    } else {
      const why = validateDestination(join([...all, n]));
      if (why) return setError(why);
      setFresh([...fresh, n]);
      setError(null);
    }
    setName("");
  };

  const shown = (list?.folders ?? []).filter((f) => f.toLowerCase().includes(filter.trim().toLowerCase()));
  const target = join(all);

  return (
    <div class="tm-folder-picker">
      {recent.length > 0 && (
        <p class="tm-folder-recent">
          <span class="tm-muted">Used before:</span>
          {recent.map((r) => (
            <button
              key={r}
              type="button"
              class="tm-button tm-secondary tm-small"
              disabled={busy}
              onClick={() => onChoose(r)}
            >
              {r}
            </button>
          ))}
        </p>
      )}
      <nav class="tm-crumbs" aria-label="Folder">
        {crumbs.map((c, i) => (
          <span key={i}>
            {i > 0 && <span class="tm-muted">/</span>}
            {i === crumbs.length - 1
              ? <strong>{c.label}</strong>
              : <button type="button" class="tm-linklike tm-crumb" onClick={c.to}>{c.label}</button>}
          </span>
        ))}
        {fresh.length > 0 && <span class="tm-badge">new: made when you write</span>}
      </nav>

      {fresh.length === 0 && (
        <div class="tm-folder-list">
          {list === null && !error && <p class="tm-muted">Loading…</p>}
          {list && list.folders.length > 12 && (
            <input
              type="search"
              class="tm-folder-filter"
              placeholder="Filter folders"
              aria-label="Filter folders"
              value={filter}
              onInput={(e) => setFilter(e.currentTarget.value)}
            />
          )}
          {list && list.folders.length === 0 && <p class="tm-muted">No folders here.</p>}
          {list && list.folders.length > 0 && shown.length === 0 && <p class="tm-muted">No folder matches.</p>}
          <ul>
            {shown.map((f) => (
              <li key={f}>
                <button type="button" class="tm-linklike" onClick={() => go([...path, f])}>{f}</button>
              </li>
            ))}
          </ul>
          {list?.truncated && (
            <p class="tm-muted">Only the first folders are listed: filter, or name the folder below.</p>
          )}
        </div>
      )}

      <form class="tm-folder-new" onSubmit={addFolder}>
        <input
          type="text"
          placeholder="New folder, e.g. a film or a series"
          aria-label="New folder name"
          maxLength={200}
          value={name}
          onInput={(e) => setName(e.currentTarget.value)}
        />
        <button type="submit" class="tm-button tm-secondary tm-small" disabled={!sanitizeName(name)}>
          New folder
        </button>
      </form>
      {sanitizeName(name) && sanitizeName(name) !== name.trim() && (
        <p class="tm-muted">
          It will be named{" "}
          <span class="tm-path">{sanitizeName(name)}</span>: some characters cannot be in folder names on Windows or
          network shares.
        </p>
      )}
      {error && <p class="tm-error">{error}</p>}

      <div class="tm-actions">
        <button type="button" class="tm-button tm-small" disabled={busy} onClick={() => onChoose(target)}>
          Put the album in {target ? <span class="tm-path tm-on-button">{target}</span> : "the top of the library"}
        </button>
        <button type="button" class="tm-button tm-secondary tm-small" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
