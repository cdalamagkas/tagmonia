/**
 * Replaces globalThis.fetch with a replayer of tests/fixtures/snaps. Any URL
 * without a recording throws, so tests cannot silently hit a live API.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SNAPS = fileURLToPath(new URL("../fixtures/snaps/", import.meta.url));

/** File names are capped at 255 bytes; long queries (Lucene searches) are hashed instead of spelled out. */
const MAX_QUERY_NAME = 160;

export function snapPath(url: URL, root = SNAPS): string {
  let query = url.search ? "__" + encodeURIComponent(url.search.slice(1)) : "";
  if (query.length > MAX_QUERY_NAME) {
    query = "__sha256-" + createHash("sha256").update(url.search.slice(1)).digest("hex");
  }
  return join(root, url.hostname, `${url.pathname.replace(/\/$/, "")}${query}.json`);
}

export interface ReplayHandle {
  requests: URL[];
  restore(): void;
}

/** A recorded 404 is stored next to where the 200 would be, as `<name>.404.json`. */
export function notFoundPath(path: string): string {
  return path.replace(/\.json$/, ".404.json");
}

async function replay(url: URL): Promise<Response> {
  const path = snapPath(url);
  for (const [file, status] of [[path, 200], [notFoundPath(path), 404]] as const) {
    try {
      return new Response(await Deno.readFile(file), { status, headers: { "content-type": "application/json" } });
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  throw new Error(`Unrecorded request ${url.href} (expected ${path})`);
}

/** A fetch that only replays recordings, for clients that accept an injected fetch. */
export function replayFetch(requests: URL[] = []): typeof fetch {
  return (input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(url);
    return replay(url);
  };
}

export function installReplayFetch(): ReplayHandle {
  const original = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = replayFetch(requests);
  return { requests, restore: () => void (globalThis.fetch = original) };
}
