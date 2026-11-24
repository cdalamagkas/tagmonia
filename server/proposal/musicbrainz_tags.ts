/**
 * MusicBrainz release → canonical tags, following what Picard writes, so files
 * tagged by Tagmonia read the same in Picard, Jellyfin and Navidrome (§6.2,
 * §6.3, §10.3). Pure: lookups happen in the propose job.
 */
import type {
  MbArtistCredit,
  MbRelation,
  MbRelease,
  MbReleaseGenres,
  MbWork,
} from "../providers/musicbrainz/schema.ts";
import type { CanonicalTags } from "../tagio/types.ts";

export interface ProposedTags {
  /** Release-level tags, written to every track. */
  release: CanonicalTags;
  /** Track-level tags per release-track MBID. */
  tracks: Map<string, CanonicalTags>;
}

export interface MusicBrainzTagInput {
  release: MbRelease;
  genres?: MbReleaseGenres | null;
  /** Parent works by MBID, for movement totals and the top-level work (§6.3). */
  parentWorks?: ReadonlyMap<string, MbWork>;
  /** §10.3: up to 5 genres by vote count. */
  maxGenres?: number;
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];

function credit(c: MbArtistCredit | undefined) {
  const list = c ?? [];
  return {
    display: list.map((a) => a.name + a.joinphrase).join(""),
    names: list.map((a) => a.name),
    sort: list.map((a) => (a.artist["sort-name"] ?? a.name) + a.joinphrase).join(""),
    ids: list.map((a) => a.artist.id),
  };
}

/** Drops empty strings and lists so the proposal never suggests writing nothing. */
function compact(t: CanonicalTags): CanonicalTags {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    out[k] = v;
  }
  return out as CanonicalTags;
}

/** Release and release-group genres merged by vote count (§10.3, D27). */
export function mergeGenres(g: MbReleaseGenres | null | undefined, max = 5): string[] {
  if (!g) return [];
  const votes = new Map<string, number>();
  for (const x of [...g.genres, ...(g["release-group"]?.genres ?? [])]) {
    votes.set(x.name, (votes.get(x.name) ?? 0) + Math.max(1, x.count));
  }
  return [...votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([n]) => n);
}

export function releaseTags(r: MbRelease, genres: string[]): CanonicalTags {
  const ac = credit(r["artist-credit"]);
  const rg = r["release-group"];
  const labels = r["label-info"] ?? [];
  return compact({
    album: r.title,
    albumartist: ac.display,
    albumartists: ac.names,
    albumartistsort: ac.sort,
    musicbrainz_albumartistid: ac.ids,
    date: r.date,
    originaldate: rg?.["first-release-date"],
    label: uniq(labels.map((l) => l.label?.name).filter((x): x is string => !!x)),
    // MusicBrainz writes "[none]" for releases without one; that is not a catalog number.
    catalognumber: uniq(
      labels.map((l) => l["catalog-number"]).filter((x): x is string => !!x && x.toLowerCase() !== "[none]"),
    ),
    barcode: r.barcode ?? undefined,
    releasecountry: r.country ?? undefined,
    releasestatus: r.status?.toLowerCase(),
    releasetype: [rg?.["primary-type"], ...(rg?.["secondary-types"] ?? [])]
      .filter((x): x is string => !!x)
      .map((x) => x.toLowerCase()),
    script: r["text-representation"]?.script ?? undefined,
    language: r["text-representation"]?.language ?? undefined,
    genre: genres,
    musicbrainz_albumid: r.id,
    musicbrainz_releasegroupid: rg?.id,
  });
}

/** Instrument and vocal modifiers Picard puts before the role ("additional piano"). */
const MODIFIERS = new Set(["additional", "guest", "solo", "minor", "co"]);
const ARRANGER_TYPES = new Set(["arranger", "instrument arranger", "vocal arranger", "orchestrator"]);

/** Performer roles as Picard writes them: "piano", "soprano vocals", "orchestra" (§6.3). */
export function performerRoles(rel: MbRelation): string[] {
  const mods = rel.attributes.filter((a) => MODIFIERS.has(a));
  const main = rel.attributes.filter((a) => !MODIFIERS.has(a));
  const prefix = mods.length ? `${mods.join(" ")} ` : "";
  switch (rel.type) {
    case "instrument":
      return (main.length ? main : ["instruments"]).map((i) => prefix + i);
    case "vocal":
      return (main.length ? main.map((v) => (/vocals?$/.test(v) ? v : `${v} vocals`)) : ["vocals"]).map((v) =>
        prefix + v
      );
    case "performing orchestra":
      return ["orchestra"];
    case "performer":
      return [prefix + (main.join(" ") || "performer")];
    case "chorus master":
    case "concertmaster":
      return [rel.type];
    default:
      return [];
  }
}

function artistsOf(rels: MbRelation[] | undefined, types: Set<string>) {
  const hits = (rels ?? []).filter((r) => types.has(r.type) && r.artist);
  return {
    names: uniq(hits.map((r) => r.artist!.name)),
    sort: uniq(hits.map((r) => r.artist!["sort-name"] ?? r.artist!.name)),
  };
}

function parentOf(w: MbWork): { id: string; title: string; order?: number } | undefined {
  const rel = (w.relations ?? []).find((r) => r.type === "parts" && r.direction === "backward" && r.work);
  return rel ? { id: rel.work!.id, title: rel.work!.title, order: rel["ordering-key"] } : undefined;
}

/** Works the proposal must look up: parents of performed works, and their parents in turn. */
export function missingParentWorks(r: MbRelease, known: ReadonlyMap<string, MbWork>): string[] {
  const out = new Set<string>();
  const visit = (w: MbWork) => {
    const p = parentOf(w);
    if (!p) return;
    const full = known.get(p.id);
    if (full) visit(full);
    else out.add(p.id);
  };
  for (const m of r.media) {
    for (const t of m.tracks ?? []) {
      for (const rel of t.recording.relations ?? []) if (rel.type === "performance" && rel.work) visit(rel.work);
    }
  }
  return [...out];
}

/** §6.3: composer, lyricist, arranger from the work; work = top-level parent; movement from the part's order. */
function workTags(rels: MbRelation[] | undefined, parents: ReadonlyMap<string, MbWork>): CanonicalTags {
  const works = (rels ?? []).filter((r) => r.type === "performance" && r.work).map((r) => r.work!);
  if (works.length === 0) return {};
  const workRels = works.flatMap((w) => w.relations ?? []);
  const composers = artistsOf(workRels, new Set(["composer"]));
  const tags: CanonicalTags = {
    composer: composers.names,
    composersort: composers.sort,
    lyricist: artistsOf(workRels, new Set(["lyricist", "librettist"])).names,
    musicbrainz_workid: works.map((w) => w.id),
  };
  const performed = works[0];
  const parent = parentOf(performed);
  if (!parent) {
    tags.work = performed.title;
    return tags;
  }
  // Climb to the top-level work: "Symphony no. 5", not an intermediate act or section.
  let top = parent;
  for (let depth = 0; depth < 5; depth++) {
    const full = parents.get(top.id);
    const up = full && parentOf(full);
    if (!up) break;
    top = up;
  }
  tags.work = top.title;
  // "Symphony no. 5 in C minor, op. 67: I. Allegro con brio" → "I. Allegro con brio".
  const prefix = `${parent.title}: `;
  tags.movement = performed.title.startsWith(prefix) ? performed.title.slice(prefix.length) : performed.title;
  if (parent.order !== undefined) {
    tags.movementnumber = parent.order;
    const full = parents.get(parent.id);
    const total = full?.relations?.filter((r) => r.type === "parts" && r.direction === "forward").length;
    if (total) tags.movementtotal = total;
    tags.showmovement = 1;
  }
  return tags;
}

export function tagsFromMusicBrainz(input: MusicBrainzTagInput): ProposedTags {
  const r = input.release;
  const parents = input.parentWorks ?? new Map();
  const release = releaseTags(r, mergeGenres(input.genres, input.maxGenres ?? 5));
  const releaseCredit = r["artist-credit"];
  const tracks = new Map<string, CanonicalTags>();
  for (const m of r.media) {
    for (const t of m.tracks ?? []) {
      const ac = credit(t["artist-credit"] ?? t.recording["artist-credit"] ?? releaseCredit);
      const rels = t.recording.relations;
      const performers: Record<string, string[]> = {};
      for (const rel of rels ?? []) {
        if (!rel.artist) continue;
        for (const role of performerRoles(rel)) {
          performers[role] = uniq([...(performers[role] ?? []), rel.artist.name]);
        }
      }
      const work = workTags(rels, parents);
      const workRels = (rels ?? []).filter((x) => x.type === "performance").flatMap((x) => x.work?.relations ?? []);
      tracks.set(
        t.id,
        compact({
          title: t.title,
          artist: ac.display,
          artists: ac.names,
          artistsort: ac.sort,
          musicbrainz_artistid: ac.ids,
          tracknumber: t.position,
          totaltracks: m["track-count"],
          discnumber: m.position,
          totaldiscs: r.media.length,
          // Per medium: a CD + DVD set has two.
          media: m.format ?? undefined,
          isrc: t.recording.isrcs,
          musicbrainz_recordingid: t.recording.id,
          musicbrainz_trackid: t.id,
          conductor: artistsOf(rels, new Set(["conductor"])).names,
          arranger: uniq([
            ...artistsOf(rels, ARRANGER_TYPES).names,
            ...artistsOf(workRels, ARRANGER_TYPES).names,
          ]),
          performer: performers,
          ...work,
        }),
      );
    }
  }
  return { release, tracks };
}
