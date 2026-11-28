/**
 * The library's folder tree (D75): the library and, when there is one, the inbox, built from the releases the scan
 * found. Folders open one level at a time; each shows how many releases it holds (with those below) and, in blue,
 * how many have changes ready or need a choice. Selecting one scopes the release list to it and below.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { FolderNodeDto, FolderTreeDto } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { ancestors } from "../library/view.ts";

type Root = "library" | "inbox";
const key = (root: Root, path: string) => `${root}:${path}`;

export function FolderTree(
  { roots, selected, refresh, onSelect }: {
    roots: Root[];
    selected: { root: Root; folder: string };
    /** Changes when the library changed (a scan finished): the open levels load again. */
    refresh: number;
    onSelect: (root: Root, folder: string) => void;
  },
) {
  const [levels, setLevels] = useState<Map<string, FolderTreeDto>>(new Map());
  const [open, setOpen] = useState<Set<string>>(() => new Set(roots.map((r) => key(r, ""))));
  const [error, setError] = useState<string | null>(null);

  const load = async (root: Root, path: string) => {
    try {
      const level = await api.tree(root, path);
      setLevels((m) => new Map(m).set(key(root, path), level));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // The roots, and the selected folder's ancestors so it shows (a bookmarked or restored view).
  useEffect(() => {
    const want = [
      ...roots.map((r) => key(r, "")),
      ...ancestors(selected.folder).map((p) => key(selected.root, p)),
    ];
    setOpen((o) => new Set([...o, ...want]));
  }, [selected.root, selected.folder, roots.join()]);

  // Every open level, loaded once; all of them again when the library changed.
  const seen = useRef(refresh);
  useEffect(() => {
    const changed = seen.current !== refresh;
    seen.current = refresh;
    for (const k of open) {
      const [root, ...rest] = k.split(":");
      if (changed || !levels.has(k)) load(root as Root, rest.join(":"));
    }
  }, [open, refresh]);

  const toggle = (root: Root, path: string) =>
    setOpen((o) => {
      const n = new Set(o);
      const k = key(root, path);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const isSelected = (root: Root, path: string) => selected.root === root && selected.folder === path;

  const node = (root: Root, n: FolderNodeDto, depth: number) => {
    const k = key(root, n.path);
    const expanded = open.has(k);
    const level = levels.get(k);
    return (
      <li key={k}>
        <div
          class={`tm-tree-row${isSelected(root, n.path) ? " tm-on" : ""}`}
          style={{ paddingLeft: `${depth * 14}px` }}
        >
          {n.hasChildren
            ? (
              <button
                type="button"
                class="tm-tree-toggle"
                aria-expanded={expanded}
                aria-label={`${expanded ? "Close" : "Open"} ${n.name}`}
                onClick={() => toggle(root, n.path)}
              >
                {expanded ? "▾" : "▸"}
              </button>
            )
            : <span class="tm-tree-toggle" aria-hidden="true"></span>}
          <button
            type="button"
            class="tm-tree-name"
            aria-current={isSelected(root, n.path) ? "true" : undefined}
            onClick={() => onSelect(root, n.path)}
            title={n.path}
          >
            {n.name}
          </button>
          <Counts releases={n.releases} withChanges={n.withChanges} />
        </div>
        {expanded && level && level.children.length > 0 && (
          <ul>{level.children.map((c) => node(root, c, depth + 1))}</ul>
        )}
      </li>
    );
  };

  return (
    <nav class="tm-tree" aria-label="Folders">
      {error && <p class="tm-error" role="alert">{error}</p>}
      <ul>
        {roots.map((root) => {
          const level = levels.get(key(root, ""));
          const expanded = open.has(key(root, ""));
          return (
            <li key={root}>
              <div class={`tm-tree-row tm-tree-root${isSelected(root, "") ? " tm-on" : ""}`}>
                <button
                  type="button"
                  class="tm-tree-toggle"
                  aria-expanded={expanded}
                  aria-label={`${expanded ? "Close" : "Open"} ${root === "inbox" ? "Inbox" : "Library"}`}
                  onClick={() => toggle(root, "")}
                >
                  {expanded ? "▾" : "▸"}
                </button>
                <button
                  type="button"
                  class="tm-tree-name"
                  aria-current={isSelected(root, "") ? "true" : undefined}
                  onClick={() => onSelect(root, "")}
                >
                  {root === "inbox" ? "Inbox" : "Library"}
                </button>
                {level && <Counts releases={level.releases} withChanges={level.withChanges} />}
              </div>
              {expanded && level && <ul>{level.children.map((c) => node(root, c, 1))}</ul>}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function Counts({ releases, withChanges }: { releases: number; withChanges: number }) {
  return (
    <span class="tm-tree-counts">
      {withChanges > 0 && (
        <span class="tm-badge tm-inline tm-badge-info" title={`${withChanges} with changes ready or a choice to make`}>
          {withChanges}
        </span>
      )}
      <span class="tm-muted" title={`${releases} release${releases === 1 ? "" : "s"}`}>{releases}</span>
    </span>
  );
}
