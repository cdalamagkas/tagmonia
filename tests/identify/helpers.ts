/** Builders for identification tests, based on recorded MusicBrainz responses (never the live API). */
import { join } from "node:path";
import { readSnap } from "../helpers/replay_fetch.ts";
import { fileURLToPath } from "node:url";
import type { Cited, ReleaseQuery } from "../../server/providers/musicbrainz/client.ts";
import { MusicBrainzResponseError } from "../../server/providers/musicbrainz/client.ts";
import {
  type MbBrowseRelease,
  type MbRelease,
  type MbReleaseExtras,
  type MbSearchRelease,
  type MbWork,
  releaseSchema,
  releaseSearchSchema,
  workSchema,
} from "../../server/providers/musicbrainz/schema.ts";
import type { MbSource } from "../../server/identify/identify.ts";
import type { CandidateEvidence, FileEvidence } from "../../server/identify/types.ts";

/** Karajan / Berlin Phil, Beethoven Symphony no. 5, DG 2542 105 (12" vinyl, 4 tracks). */
export const BEETHOVEN_5 = "f390ab14-095d-42aa-ade3-fbbafe093f9d";

const RELEASE_DIR = new URL("../fixtures/snaps/musicbrainz.org/ws/2/release/", import.meta.url);

export async function loadRelease(mbid: string): Promise<MbRelease> {
  for await (const e of Deno.readDir(RELEASE_DIR)) {
    if (!e.name.startsWith(`${mbid}__sha256-`) || e.name.includes(".404.")) continue;
    // Corpus recordings are gzipped (D38); readSnap reads either form.
    const bytes = await readSnap(join(fileURLToPath(RELEASE_DIR), e.name.replace(/\.gz$/, "")));
    if (bytes) return releaseSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  }
  throw new Error(`no recorded release ${mbid}`);
}

/** Another edition (or a different release, with `releaseGroup`) derived from a recorded one. */
export function variant(
  base: MbRelease,
  id: string,
  opts: {
    releaseGroup?: string;
    country?: string;
    barcode?: string;
    format?: string;
    /** Added to every track length, in ms. */
    shiftMs?: number;
    title?: string;
  } = {},
): MbRelease {
  const r = structuredClone(base);
  r.id = id;
  if (opts.releaseGroup) r["release-group"] = { ...r["release-group"]!, id: opts.releaseGroup };
  if (opts.country) r.country = opts.country;
  if (opts.barcode !== undefined) r.barcode = opts.barcode;
  if (opts.title) r.title = opts.title;
  for (const m of r.media) {
    if (opts.format) m.format = opts.format;
    for (const t of m.tracks ?? []) {
      if (t.length != null) t.length += opts.shiftMs ?? 0;
      t.id = crypto.randomUUID();
    }
  }
  return r;
}

export function asSearchHit(r: MbRelease, score = 100): MbSearchRelease {
  return releaseSearchSchema.parse({
    count: 1,
    offset: 0,
    releases: [{
      id: r.id,
      score,
      title: r.title,
      status: r.status,
      country: r.country,
      barcode: r.barcode,
      "artist-credit": r["artist-credit"],
      "release-group": r["release-group"],
      "label-info": r["label-info"],
      "track-count": r.media.reduce((n, m) => n + m["track-count"], 0),
      media: r.media.map((m) => ({ format: m.format, "track-count": m["track-count"] })),
    }],
  }).releases[0];
}

/** In-memory MusicBrainz: lookups by id, searches answered by a function; records every call. */
export class FakeMb implements MbSource {
  readonly calls: string[] = [];
  readonly releases = new Map<string, MbRelease>();
  /** Old MBID -> current one, as MusicBrainz serves merged releases. */
  readonly merged = new Map<string, string>();
  readonly truncated = new Set<string>();
  search: (q: ReleaseQuery) => MbRelease[] = () => [];
  /** Genre lookups by release id (§10.3). */
  readonly genres = new Map<string, MbReleaseExtras>();
  /** Work lookups by id (parent works, §6.3). */
  readonly works = new Map<string, MbWork>();

  lookupReleaseExtras(mbid: string): Promise<Cited<MbReleaseExtras> | null> {
    this.calls.push(`genres ${mbid}`);
    const g = this.genres.get(mbid);
    return Promise.resolve(g ? { value: g, snapshotId: 4 } : null);
  }

  lookupWork(mbid: string): Promise<Cited<MbWork> | null> {
    this.calls.push(`work ${mbid}`);
    const w = this.works.get(mbid);
    return Promise.resolve(w ? { value: w, snapshotId: 5 } : null);
  }

  /** Release-group browse; unset = the source does not support browsing. */
  browse?: (releaseGroupId: string) => MbRelease[];

  constructor(releases: MbRelease[] = []) {
    for (const r of releases) this.releases.set(r.id, r);
  }

  searchReleases(q: ReleaseQuery): Promise<Cited<MbSearchRelease[]>> {
    this.calls.push(`search ${JSON.stringify(q)}`);
    return Promise.resolve({ value: this.search(q).map((r) => asSearchHit(r)), snapshotId: 1 });
  }

  get browseReleaseGroup() {
    const browse = this.browse;
    if (!browse) return undefined;
    return (id: string) => {
      this.calls.push(`browse ${id}`);
      return Promise.resolve({ value: browse(id).map((r) => asSearchHit(r) as MbBrowseRelease), snapshotId: 3 });
    };
  }

  lookupRelease(mbid: string): Promise<Cited<MbRelease> | null> {
    this.calls.push(`lookup ${mbid}`);
    if (this.truncated.has(mbid)) return Promise.reject(new MusicBrainzResponseError(`release ${mbid} truncated`));
    const r = this.releases.get(this.merged.get(mbid) ?? mbid);
    return Promise.resolve(r ? { value: r, snapshotId: 2 } : null);
  }
}

/** Files as a well-tagged rip of `release` would look; `jitterMs` shifts each duration. */
export function filesFor(
  release: MbRelease,
  opts: { jitterMs?: number; tagged?: boolean; firstId?: number } = {},
): FileEvidence[] {
  const out: FileEvidence[] = [];
  let id = opts.firstId ?? 1;
  for (const m of release.media) {
    for (const t of m.tracks ?? []) {
      const n = String(t.position).padStart(2, "0");
      out.push({
        fileId: id++,
        path: `Album/${n}.flac`,
        durationMs: (t.length ?? 0) + (opts.jitterMs ?? 0),
        ...(opts.tagged === false ? {} : { title: t.title, tracknumber: t.position, discnumber: m.position }),
      });
    }
  }
  return out;
}

export function evidenceFor(release: MbRelease, extra: Partial<CandidateEvidence> = {}): CandidateEvidence {
  return {
    files: filesFor(release, { jitterMs: 1200 }),
    album: release.title,
    albumArtist: "Beethoven; Berlin Philharmonic Orchestra, Herbert von Karajan",
    ...extra,
  };
}

/** The recorded parent work of the Beethoven 5 movements (Symphony no. 5, 4 ordered parts). */
export const SYMPHONY_5 = "d03bff61-26fc-301b-98ac-4d8e85771cbc";

export async function loadWork(mbid: string): Promise<MbWork> {
  const dir = new URL("../fixtures/snaps/musicbrainz.org/ws/2/work/", import.meta.url);
  for await (const e of Deno.readDir(dir)) {
    if (e.name.startsWith(mbid)) {
      // join, not new URL(): the file name holds percent-escapes that a URL would decode.
      return workSchema.parse(JSON.parse(await Deno.readTextFile(join(fileURLToPath(dir), e.name))));
    }
  }
  throw new Error(`no recorded work ${mbid}`);
}
