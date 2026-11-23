/**
 * Replaces globalThis.fetch with a replayer of tests/fixtures/snaps. Any URL
 * without a recording throws, so tests cannot silently hit a live API.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SNAPS = fileURLToPath(new URL("../fixtures/snaps/", import.meta.url));

export function snapPath(url: URL): string {
  const query = url.search ? "__" + encodeURIComponent(url.search.slice(1)) : "";
  return join(SNAPS, url.hostname, `${url.pathname.replace(/\/$/, "")}${query}.json`);
}

export interface ReplayHandle {
  requests: URL[];
  restore(): void;
}

export function installReplayFetch(): ReplayHandle {
  const original = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = async (input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(url);
    const path = snapPath(url);
    try {
      return new Response(await Deno.readFile(path), { headers: { "content-type": "application/json" } });
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        throw new Error(`Unrecorded request ${url.href} (expected ${path})`);
      }
      throw e;
    }
  };
  return { requests, restore: () => void (globalThis.fetch = original) };
}
