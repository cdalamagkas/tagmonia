/**
 * A release found on Deezer, iTunes, Discogs or Bandcamp but not on MusicBrainz
 * (§10.4, D51), as canonical tags. Pure. The input is Harmony's merge of the
 * providers that have the release, with the one the user pointed at first: it
 * supplies everything it has, the others only fill gaps, and Harmony's
 * `sourceMap` says which provider each value came from ("filled by").
 *
 * No MusicBrainz identifiers are proposed: there are none yet. They are added
 * once the release is on MusicBrainz (§12).
 */
import { formatString } from "../identify/release.ts";
import type { ReleaseTrack, ReleaseView } from "../identify/types.ts";
import type { HarmonizedRelease, MergedRelease } from "../providers/harmony_adapter.ts";
import type { CanonicalField, CanonicalTags } from "../tagio/types.ts";
import { type FieldProvenance, harmonyDate, harmonyLabels, type SourceId } from "./merge.ts";
import type { ProposedTags } from "./musicbrainz_tags.ts";

/** Track keys for a provider release: no MusicBrainz track ids exist, so medium and position stand in. */
export function providerTrackId(medium: number, position: number): string {
  return `p${medium}-${position}`;
}

type Credit = HarmonizedRelease["artists"];

export function creditText(c: Credit | undefined): string {
  return (c ?? []).map((a, i, all) => (a.creditedName || a.name) + (a.joinPhrase ?? (i < all.length - 1 ? ", " : "")))
    .join("");
}

function creditNames(c: Credit | undefined): string[] {
  // Credited names, as MusicBrainz tags carry them (D40).
  return (c ?? []).map((a) => a.creditedName || a.name).filter(Boolean);
}

/** Media in order, numbered 1… when the provider gives no number. */
function media(r: HarmonizedRelease) {
  return r.media.map((m, i) => ({ number: m.number ?? i + 1, medium: m }));
}

/** The release as identification scores it, so files map onto its tracks like onto a MusicBrainz release. */
export function providerReleaseView(r: HarmonizedRelease, id: string): ReleaseView {
  const tracks: ReleaseTrack[] = media(r).flatMap(({ number, medium }) =>
    medium.tracklist.map((t, i) => ({
      medium: number,
      position: i + 1,
      title: t.title,
      lengthMs: t.length ?? null,
      trackId: providerTrackId(number, i + 1),
      recordingId: providerTrackId(number, i + 1),
    }))
  );
  const { label, catalognumber } = harmonyLabels(r);
  return {
    id,
    releaseGroupId: null,
    summary: {
      title: r.title,
      artist: creditText(r.artists),
      date: harmonyDate(r) ?? null,
      country: null,
      labels: label ?? [],
      catalogNumbers: catalognumber ?? [],
      barcode: r.gtin ? String(r.gtin) : null,
      format: formatString(r.media.map((m) => m.format ?? "Digital Media")),
      trackCount: tracks.length,
      status: r.status ?? null,
    },
    tracks,
  };
}

/** Harmony's property names, by the canonical fields they produce. */
const SOURCE_PROPERTY: Partial<Record<CanonicalField, string>> = {
  album: "title",
  albumartist: "artists",
  albumartists: "artists",
  date: "releaseDate",
  label: "labels",
  catalognumber: "labels",
  barcode: "gtin",
  releasestatus: "status",
  isrc: "isrc",
};

export interface ProviderTags extends ProposedTags {
  provenance: Map<string, FieldProvenance>;
}

/**
 * Canonical tags and their provenance. `primary` is the provider the user
 * pointed at; a value Harmony took from another provider is that provider's.
 */
export function tagsFromProviders(r: MergedRelease, primary: SourceId): ProviderTags {
  // sourceMap names providers by display name ("Deezer"); Tagmonia uses the internal one ("deezer").
  const internal = new Map(r.info.providers.map((p) => [p.name, p.internalName as SourceId]));
  const sourceOf = (field: CanonicalField): SourceId => {
    const prop = SOURCE_PROPERTY[field];
    const name = prop ? (r.info.sourceMap as Record<string, string | undefined>)[prop] : undefined;
    return (name && internal.get(name)) || primary;
  };
  const provenance = new Map<string, FieldProvenance>();
  const note = (key: string, field: CanonicalField, value: unknown) => {
    const origin = sourceOf(field);
    provenance.set(key, { origin, sources: [{ provider: origin, value }], conflict: false });
  };

  const release: CanonicalTags = {
    album: r.title,
    albumartist: creditText(r.artists),
    albumartists: creditNames(r.artists),
  };
  const date = harmonyDate(r);
  if (date) release.date = date;
  const { label, catalognumber } = harmonyLabels(r);
  if (label) release.label = label;
  if (catalognumber) release.catalognumber = catalognumber;
  if (r.gtin) release.barcode = String(r.gtin);
  if (r.status) release.releasestatus = r.status.toLowerCase();
  if (r.types?.length) release.releasetype = r.types.map((t) => t.toLowerCase());
  for (const p of r.info.providers) {
    if (p.internalName === "deezer" && p.id) release.deezer_album_id = p.id;
    if (p.internalName === "discogs" && p.id) release.discogs_release_id = p.id;
  }
  for (const [field, value] of Object.entries(release) as [CanonicalField, unknown][]) {
    if (field === "deezer_album_id") {
      provenance.set(field, { origin: "deezer", sources: [{ provider: "deezer", value }], conflict: false });
    } else if (field === "discogs_release_id") {
      provenance.set(field, { origin: "discogs", sources: [{ provider: "discogs", value }], conflict: false });
    } else note(field, field, value);
  }

  const tracks = new Map<string, CanonicalTags>();
  const all = media(r);
  for (const { number, medium } of all) {
    medium.tracklist.forEach((t, i) => {
      const id = providerTrackId(number, i + 1);
      const credit = t.artists?.length ? t.artists : r.artists;
      const tags: CanonicalTags = {
        title: t.title,
        artist: creditText(credit),
        artists: creditNames(credit),
        tracknumber: i + 1,
        totaltracks: medium.tracklist.length,
        discnumber: number,
        totaldiscs: all.length,
      };
      if (medium.format) tags.media = medium.format;
      if (t.isrc) tags.isrc = [t.isrc];
      tracks.set(id, tags);
      for (const [field, value] of Object.entries(tags) as [CanonicalField, unknown][]) {
        note(`${id}:${field}`, field, value);
      }
    });
  }
  return { release, tracks, provenance };
}
