/**
 * Manual lookup (§8 order 5): the user pastes a MusicBrainz release URL. Only
 * MusicBrainz's own hosts are accepted (§14.5), and only the MBID is taken from
 * the URL; the request itself is built by Tagmonia's client.
 */
import { mbidSchema } from "../providers/musicbrainz/schema.ts";

const HOSTS = new Set(["musicbrainz.org", "beta.musicbrainz.org"]);

/** The release MBID from a MusicBrainz release URL or a bare MBID, else null. */
export function releaseMbidFromInput(input: string): string | null {
  const s = input.trim();
  const bare = mbidSchema.safeParse(s.toLowerCase());
  if (bare.success) return bare.data;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !HOSTS.has(url.hostname) || url.username || url.password || url.port) return null;
  const m = /^\/release\/([0-9a-fA-F-]{36})(?:\/[\w-]*)?\/?$/.exec(url.pathname);
  if (!m) return null;
  const id = mbidSchema.safeParse(m[1].toLowerCase());
  return id.success ? id.data : null;
}
