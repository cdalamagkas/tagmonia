/**
 * The library page's view (D75): which root and folder, which status, which order, what search. It lives in the URL
 * (`/?root=library&folder=Soundtracks&status=ready&sort=album&q=…`), so Back from a release returns to it and a view
 * can be bookmarked. Pure, so it is unit-tested without a browser.
 */
import type { ReleaseSort, ReleaseStatusFilter } from "../../../shared/types.ts";

export interface LibraryView {
  root: "library" | "inbox";
  /** Relative to the root; "" is all of it. */
  folder: string;
  status: ReleaseStatusFilter | null;
  sort: ReleaseSort;
  q: string;
}

export const DEFAULT_VIEW: LibraryView = { root: "library", folder: "", status: null, sort: "artist", q: "" };

export const STATUS_OPTIONS: { value: ReleaseStatusFilter; label: string }[] = [
  { value: "ready", label: "Changes ready" },
  { value: "choices", label: "Needs a choice" },
  { value: "stale", label: "Files changed" },
  { value: "unidentified", label: "Not identified" },
  { value: "nomatch", label: "No match" },
  { value: "complete", label: "Complete" },
];

export const SORT_OPTIONS: { value: ReleaseSort; label: string }[] = [
  { value: "artist", label: "Artist" },
  { value: "album", label: "Album" },
  { value: "folder", label: "Folder" },
  { value: "added", label: "Recently added" },
  { value: "changes", label: "Most changes" },
];

const STATUSES = new Set<string>(STATUS_OPTIONS.map((o) => o.value));
const SORTS = new Set<string>(SORT_OPTIONS.map((o) => o.value));

/** The view a URL's query names; anything unknown falls back to the default. */
export function parseView(search: string): LibraryView {
  const p = new URLSearchParams(search);
  const status = p.get("status");
  const sort = p.get("sort");
  return {
    root: p.get("root") === "inbox" ? "inbox" : "library",
    folder: (p.get("folder") ?? "").replace(/^\/+|\/+$/g, ""),
    status: status && STATUSES.has(status) ? status as ReleaseStatusFilter : null,
    sort: sort && SORTS.has(sort) ? sort as ReleaseSort : "artist",
    q: (p.get("q") ?? "").slice(0, 200),
  };
}

/** The query for a view, leaving out what is the default: "" for the whole library, sorted by artist. */
export function viewSearch(v: LibraryView): string {
  const p = new URLSearchParams();
  if (v.root !== "library") p.set("root", v.root);
  if (v.folder) p.set("folder", v.folder);
  if (v.status) p.set("status", v.status);
  if (v.sort !== "artist") p.set("sort", v.sort);
  if (v.q.trim()) p.set("q", v.q.trim());
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** "Library / Soundtracks / Dune": each step with the folder it selects. */
export function crumbs(v: Pick<LibraryView, "root" | "folder">): { label: string; folder: string }[] {
  const out = [{ label: v.root === "inbox" ? "Inbox" : "Library", folder: "" }];
  const parts = v.folder ? v.folder.split("/") : [];
  parts.forEach((name, i) => out.push({ label: name, folder: parts.slice(0, i + 1).join("/") }));
  return out;
}

/** The folders to open in the tree so the selected one shows: each ancestor, from the root down. */
export function ancestors(folder: string): string[] {
  const parts = folder ? folder.split("/") : [];
  return parts.map((_, i) => parts.slice(0, i).join("/"));
}
