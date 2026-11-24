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

/**
 * A recording as plain JSON, or gzipped next to where the JSON would be
 * (`<name>.json.gz`): the identification corpus is stored compressed (D38).
 */
export async function readSnap(path: string): Promise<Uint8Array<ArrayBuffer> | null> {
  for (const [file, gz] of [[path, false], [`${path}.gz`, true]] as const) {
    try {
      const bytes = await Deno.readFile(file);
      if (!gz) return bytes;
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  return null;
}

export async function writeSnapGz(path: string, body: string): Promise<void> {
  const stream = new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"));
  await Deno.writeFile(`${path}.gz`, new Uint8Array(await new Response(stream).arrayBuffer()));
}

async function replay(url: URL): Promise<Response> {
  const path = snapPath(url);
  for (const [file, status] of [[path, 200], [notFoundPath(path), 404]] as const) {
    const bytes = await readSnap(file);
    if (bytes) return new Response(bytes, { status, headers: { "content-type": "application/json" } });
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
