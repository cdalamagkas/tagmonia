/**
 * Jellyfin library refresh after writes (ARCHITECTURE.md §13, D44). Only the
 * configured server is ever called (§14.5), and the API key travels in the
 * Authorization header, never in a URL (CLAUDE.md safety rule 7).
 */
import { z } from "zod";

export interface JellyfinOptions {
  baseUrl: string;
  apiKey: string;
  /** Library to refresh, by name; every library when unset. */
  library?: string;
  userAgent: string;
  version: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Retrying cannot fix it: a rejected key or a library that does not exist. */
export class JellyfinConfigError extends Error {
  override name = "JellyfinConfigError";
}

export class JellyfinHttpError extends Error {
  override name = "JellyfinHttpError";
  constructor(readonly status: number) {
    super(`Jellyfin answered HTTP ${status}`);
  }
}

const foldersSchema = z.array(z.looseObject({
  Name: z.string(),
  ItemId: z.string(),
  CollectionType: z.string().nullable().optional(),
  Locations: z.array(z.string()).default([]),
}));

const itemsSchema = z.looseObject({
  Items: z.array(
    z.looseObject({ Id: z.string(), Name: z.string().optional(), Path: z.string().nullable().optional() }),
  ),
  TotalRecordCount: z.number().int(),
});

export interface FolderRefreshResult {
  /** Albums fully re-read from their files. */
  albums: string[];
  /** Folders Jellyfin has no album for yet (new albums): a library scan finds them. */
  unknown: string[];
  library: string | null;
}

/** Segment-wise suffix match, so "B" never matches ".../AB"; Windows paths and Unicode forms compared alike. */
export function pathEndsWithFolder(path: string, folder: string): boolean {
  const norm = (s: string) => s.normalize("NFC").replace(/\\/g, "/").replace(/\/+$/, "");
  const p = norm(path), f = norm(folder);
  return f !== "" && (p === f || p.endsWith(`/${f}`));
}

export interface JellyfinLibrary {
  name: string;
  itemId: string;
  collectionType: string | null;
  locations: string[];
}

export class JellyfinClient {
  readonly base: URL;

  constructor(private readonly opts: JellyfinOptions) {
    const base = new URL(opts.baseUrl);
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    if (base.username || base.password) throw new Error("TAGMONIA_JELLYFIN_URL must not contain credentials");
    this.base = base;
  }

  /** Jellyfin's own client header; an API key is accepted as its token. */
  #auth(): string {
    const v = this.opts.version.replace(/"/g, "");
    return `MediaBrowser Client="Tagmonia", Device="Tagmonia", DeviceId="tagmonia-server", Version="${v}", Token="${this.opts.apiKey}"`;
  }

  async #request(method: "GET" | "POST", path: string, query: Record<string, string> = {}, signal?: AbortSignal) {
    const url = new URL(path, this.base);
    // Paths are ours, but the check makes it impossible for any code path to call another host.
    if (url.origin !== this.base.origin) throw new Error("refusing a request outside the configured Jellyfin server");
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 30_000);
    const res = await (this.opts.fetch ?? fetch)(url, {
      method,
      headers: { Authorization: this.#auth(), Accept: "application/json", "User-Agent": this.opts.userAgent },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      throw new JellyfinConfigError("Jellyfin rejected the API key (TAGMONIA_JELLYFIN_KEY)");
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new JellyfinHttpError(res.status);
    }
    return res;
  }

  async libraries(signal?: AbortSignal): Promise<JellyfinLibrary[]> {
    const res = await this.#request("GET", "Library/VirtualFolders", {}, signal);
    const parsed = foldersSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error("unexpected response from Jellyfin's Library/VirtualFolders");
    return parsed.data.map((l) => ({
      name: l.Name,
      itemId: l.ItemId,
      collectionType: l.CollectionType ?? null,
      locations: l.Locations,
    }));
  }

  async #library(signal?: AbortSignal): Promise<JellyfinLibrary | null> {
    const name = this.opts.library;
    if (!name) return null;
    const lib = (await this.libraries(signal)).find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (!lib) throw new JellyfinConfigError(`Jellyfin has no library named "${name}" (TAGMONIA_JELLYFIN_LIBRARY)`);
    return lib;
  }

  /** Every album item (folder-based in Jellyfin) with its path, in pages. */
  async #albums(lib: JellyfinLibrary | null, signal?: AbortSignal): Promise<{ id: string; path: string }[]> {
    const out: { id: string; path: string }[] = [];
    for (let start = 0;; start += 500) {
      const q: Record<string, string> = {
        IncludeItemTypes: "MusicAlbum",
        Recursive: "true",
        Fields: "Path",
        StartIndex: String(start),
        Limit: "500",
      };
      if (lib) q.ParentId = lib.itemId;
      const page = itemsSchema.safeParse(await (await this.#request("GET", "Items", q, signal)).json());
      if (!page.success) throw new Error("unexpected response from Jellyfin's Items");
      for (const i of page.data.Items) if (i.Path) out.push({ id: i.Id, path: i.Path });
      if (page.data.Items.length < 500 || out.length >= page.data.TotalRecordCount) return out;
    }
  }

  /**
   * After a write: fully re-read exactly the albums Tagmonia changed. A plain
   * scan merges tags and keeps values a write removed, so an undo would never
   * show (checked against Jellyfin 10.11.3, D44). Replacing metadata only for
   * these albums keeps manual edits elsewhere in the library. Folders Jellyfin
   * does not know yet get a library scan so they are discovered.
   */
  async refreshFolders(folders: string[], signal?: AbortSignal): Promise<FolderRefreshResult> {
    const lib = await this.#library(signal);
    const albums = folders.length ? await this.#albums(lib, signal) : [];
    const matched = new Map<string, string>();
    const unknown: string[] = [];
    for (const folder of folders) {
      const hits = albums.filter((a) => pathEndsWithFolder(a.path, folder));
      if (hits.length === 0) unknown.push(folder);
      for (const h of hits) matched.set(h.id, folder);
    }
    for (const id of matched.keys()) {
      const res = await this.#request("POST", `Items/${encodeURIComponent(id)}/Refresh`, {
        Recursive: "true",
        MetadataRefreshMode: "FullRefresh",
        // A written or undone cover must replace the one Jellyfin extracted before (D49).
        ImageRefreshMode: "FullRefresh",
        ReplaceAllMetadata: "true",
        ReplaceAllImages: "true",
      }, signal);
      await res.body?.cancel();
    }
    if (unknown.length || folders.length === 0) await this.refresh(signal);
    return { albums: [...new Set(matched.values())], unknown, library: lib?.name ?? null };
  }

  /**
   * A plain scan of the named library (re-reading files whose modification
   * time changed), or of all libraries.
   */
  async refresh(signal?: AbortSignal): Promise<{ library: string | null }> {
    const lib = await this.#library(signal);
    if (!lib) {
      await (await this.#request("POST", "Library/Refresh", {}, signal)).body?.cancel();
      return { library: null };
    }
    const res = await this.#request("POST", `Items/${encodeURIComponent(lib.itemId)}/Refresh`, {
      Recursive: "true",
      MetadataRefreshMode: "Default",
      ImageRefreshMode: "Default",
      ReplaceAllMetadata: "false",
      ReplaceAllImages: "false",
    }, signal);
    await res.body?.cancel();
    return { library: lib.name };
  }
}
