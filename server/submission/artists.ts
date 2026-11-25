/**
 * The release's artists on MusicBrainz, before the release editor opens (§12.3, D52).
 * The editor links an artist only when the seed carries its MBID, so each artist is
 * looked for by its provider pages (a Deezer artist page linked on MusicBrainz is
 * unambiguous), then by an MBID the user chose. One that is not found gets name
 * suggestions and a link that opens MusicBrainz's "Add artist" form filled in with the
 * name and the provider pages, so the next check finds it by those pages.
 */
import type { MergedRelease } from "../providers/harmony_adapter.ts";
import type { MusicBrainzClient } from "../providers/musicbrainz/client.ts";

type Credit = MergedRelease["artists"];
type CreditName = Credit[number];

export interface ArtistLink {
  url: string;
  linkTypeIds: number[];
}

export interface ArtistSuggestion {
  mbid: string;
  name: string;
  disambiguation: string | null;
  country: string | null;
  score: number | null;
}

export interface ArtistResolution {
  /** As the providers credit the artist. */
  name: string;
  links: ArtistLink[];
  mbid: string | null;
  /** How the MBID was found: by a provider page linked on MusicBrainz, or the user's choice. */
  via: "link" | "chosen" | null;
  /** When not found: artists with this name, for the user to check. */
  suggestions: ArtistSuggestion[];
  /** When not found: MusicBrainz's "Add artist" form, filled in. */
  createUrl: string | null;
  /**
   * When chosen by the user (so not linked to these provider pages on MusicBrainz): the artist's
   * edit form with the pages filled in, so future releases find the artist by them.
   */
  addLinksUrl: string | null;
}

/** Every artist credited on the release or a track, once, with all its provider pages. */
export function collectArtists(
  release: MergedRelease,
  linksOf: (a: CreditName) => ArtistLink[],
): { name: string; links: ArtistLink[] }[] {
  const credits: Credit = [
    ...release.artists,
    ...release.media.flatMap((m) => m.tracklist.flatMap((t) => t.artists ?? [])),
  ];
  const out = new Map<string, { name: string; links: ArtistLink[] }>();
  for (const a of credits) {
    if (!a.name) continue;
    const entry = out.get(a.name) ?? { name: a.name, links: [] };
    for (const l of linksOf(a)) if (!entry.links.some((x) => x.url === l.url)) entry.links.push(l);
    out.set(a.name, entry);
  }
  return [...out.values()];
}

function seedLinks(q: URLSearchParams, links: ArtistLink[]): void {
  let i = 0;
  for (const l of links) {
    for (const type of l.linkTypeIds.length ? l.linkTypeIds : [null]) {
      q.set(`edit-artist.url.${i}.text`, l.url);
      if (type !== null) q.set(`edit-artist.url.${i}.link_type_id`, String(type));
      i++;
    }
  }
}

/** MusicBrainz's "Add artist" form, seeded by GET as Harmony seeds artist edits (`edit-artist.*`). */
export function artistCreateUrl(
  server: string,
  artist: { name: string; links: ArtistLink[] },
  releaseUrl: string,
): string {
  const q = new URLSearchParams({ "edit-artist.name": artist.name });
  seedLinks(q, artist.links);
  q.set("edit-artist.edit_note", `Artist of ${releaseUrl}, added while importing that release with Tagmonia.`);
  return `${server}/artist/create?${q}`;
}

/** An existing artist's edit form with its provider pages filled in, as Harmony seeds them. */
export function artistAddLinksUrl(
  server: string,
  mbid: string,
  links: ArtistLink[],
  releaseUrl: string,
): string | null {
  if (links.length === 0) return null;
  const q = new URLSearchParams();
  seedLinks(q, links);
  q.set("edit-artist.edit_note", `Matched artist while importing ${releaseUrl} with Tagmonia.`);
  return `${server}/artist/${mbid}/edit?${q}`;
}

export async function resolveArtists(
  mb: Pick<MusicBrainzClient, "artistsForUrl" | "searchArtists" | "lookupArtist">,
  artists: { name: string; links: ArtistLink[] }[],
  opts: {
    server: string;
    releaseUrl: string;
    chosen: Record<string, string>;
    /**
     * The test server's search index misses artists its database has (seen: 0 hits for an artist
     * musicbrainz.org finds at score 100, same MBID). Its database is a copy of musicbrainz.org's, so
     * musicbrainz.org's search is asked too, keeping only artists that exist on the server.
     */
    fallbackSearch?: Pick<MusicBrainzClient, "searchArtists">;
    signal?: AbortSignal;
  },
): Promise<ArtistResolution[]> {
  const fresh = { signal: opts.signal, maxAgeMs: 0 };
  const out: ArtistResolution[] = [];
  for (const a of artists) {
    let mbid: string | null = null;
    let via: ArtistResolution["via"] = null;
    for (const l of a.links) {
      const found = (await mb.artistsForUrl(l.url, fresh)).value;
      // A page linked to two artists is ambiguous: leave the choice to the user.
      if (found.length === 1) {
        mbid = found[0].id;
        via = "link";
        break;
      }
    }
    if (!mbid && opts.chosen[a.name]) {
      mbid = opts.chosen[a.name];
      via = "chosen";
    }
    let suggestions: ArtistSuggestion[] = [];
    if (!mbid) {
      const toSuggestion = (h: Awaited<ReturnType<typeof mb.searchArtists>>["value"][number]) => ({
        mbid: h.id,
        name: h.name,
        disambiguation: h.disambiguation || null,
        country: h.country ?? null,
        score: h.score ?? null,
      });
      const good = (hits: Awaited<ReturnType<typeof mb.searchArtists>>["value"]) =>
        hits.filter((h) => (h.score ?? 0) >= 80).slice(0, 3);
      suggestions = good((await mb.searchArtists(a.name, { ...fresh, limit: 5 })).value).map(toSuggestion);
      if (suggestions.length === 0 && opts.fallbackSearch) {
        for (const h of good((await opts.fallbackSearch.searchArtists(a.name, { ...fresh, limit: 5 })).value)) {
          if (await mb.lookupArtist(h.id, fresh)) suggestions.push(toSuggestion(h));
        }
      }
    }
    out.push({
      name: a.name,
      links: a.links,
      mbid,
      via,
      suggestions,
      createUrl: mbid ? null : artistCreateUrl(opts.server, a, opts.releaseUrl),
      addLinksUrl: via === "chosen" && mbid ? artistAddLinksUrl(opts.server, mbid, a.links, opts.releaseUrl) : null,
    });
  }
  return out;
}

/** The release with the found MBIDs on its artist credits, so the seed links them (Harmony's convertArtistCredit). */
export function withArtistMbids(release: MergedRelease, artists: ArtistResolution[]): MergedRelease {
  const mbids = new Map(artists.filter((a) => a.mbid).map((a) => [a.name, a.mbid!]));
  const credit = (c: Credit | undefined) => c?.map((a) => (mbids.has(a.name) ? { ...a, mbid: mbids.get(a.name) } : a));
  return {
    ...release,
    artists: credit(release.artists)!,
    media: release.media.map((m) => ({
      ...m,
      tracklist: m.tracklist.map((t) => (t.artists ? { ...t, artists: credit(t.artists) } : t)),
    })),
  };
}
