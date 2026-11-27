/**
 * YouTube as an evidence provider (ARCHITECTURE.md §9.5, D55): the official YouTube Data API only, from a
 * video or playlist link the user pastes. No search (`search.list` has a small daily quota of its own);
 * `playlists`, `playlistItems` and `videos` cost one unit per call.
 *
 * Auto-generated "Topic" uploads carry the release in their description:
 *
 *     Provided to YouTube by <distributor>
 *
 *     <title> · <artist> · <artist>
 *
 *     <album>
 *
 *     ℗ 2021 <rights holder>
 *
 *     Released on: 2021-07-23
 *
 * YouTube values are evidence: they fill an empty date or label and corroborate the rest, never set the
 * tracklist or artists, and never cause a conflict. The API key travels in a header, so it never appears
 * in a URL, the snapshot cache or a log line.
 */
import { z } from "zod";
import { politeFetch, type PoliteFetchOptions, ProviderHttpError } from "./http.ts";
import type { SnapshotCache } from "./snapshots.ts";

export const PROVIDER_ID = "youtube";
export const API = "https://www.googleapis.com/youtube/v3";
const TTL_MS = 7 * 86_400_000;
/** A playlist longer than this is not an album; 4 pages of 50. */
export const MAX_TRACKS = 200;

export type YouTubeLink = { kind: "playlist"; id: string } | { kind: "video"; id: string };

const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,64}$/;

/** Hosts a pasted YouTube link may have; only the ID is taken from it, the link itself is never fetched. */
export function isYouTubeHost(hostname: string): boolean {
  return HOSTS.has(hostname) || hostname === "youtu.be";
}

/**
 * A video or playlist from a pasted link. A watch link inside a playlist means the playlist: an album is
 * the playlist, not one of its tracks.
 */
export function parseYouTubeUrl(url: URL): YouTubeLink | { error: string } {
  if (url.protocol !== "https:") return { error: "Links must start with https://" };
  if (url.hostname === "youtu.be") {
    const id = url.pathname.slice(1);
    return VIDEO_ID.test(id) ? { kind: "video", id } : { error: "That YouTube link has no video in it" };
  }
  if (!HOSTS.has(url.hostname)) return { error: "That is not a YouTube link" };
  const list = url.searchParams.get("list");
  if ((url.pathname === "/playlist" || url.pathname === "/watch") && list) {
    return PLAYLIST_ID.test(list) ? { kind: "playlist", id: list } : { error: "That YouTube playlist ID is not valid" };
  }
  const v = url.searchParams.get("v");
  if (url.pathname === "/watch" && v) {
    return VIDEO_ID.test(v) ? { kind: "video", id: v } : { error: "That YouTube video ID is not valid" };
  }
  if (url.pathname.startsWith("/browse/")) {
    return { error: "Open the album's playlist and paste that link instead (…/playlist?list=…)" };
  }
  return { error: "Paste a YouTube video or playlist link" };
}

export function canonicalUrl(link: YouTubeLink): string {
  return link.kind === "playlist"
    ? `https://www.youtube.com/playlist?list=${link.id}`
    : `https://www.youtube.com/watch?v=${link.id}`;
}

/** ISO 8601 durations as the API gives them ("PT4M46S", "PT1H2M", "P0D"), in ms. */
export function parseDuration(iso: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m) return null;
  const [d, h, min, s] = m.slice(1).map((x) => Number(x ?? 0));
  const ms = (((d * 24 + h) * 60 + min) * 60 + s) * 1000;
  return ms > 0 ? ms : null;
}

export interface DescriptionFacts {
  providedBy: string | null;
  /** From the "<title> · <artist> · <artist>" line (D64). */
  track: { title: string; artists: string[] } | null;
  album: string | null;
  /** From the ℗ line: the rights holder, or whom the release is licensed to. */
  label: string | null;
  date: string | null;
}

/** The release facts of an auto-generated upload's description; nulls for any other description. */
export function parseDescription(text: string): DescriptionFacts {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const none = { providedBy: null, track: null, album: null, label: null, date: null };
  const provided = lines.findIndex((l) => /^Provided to YouTube by /i.test(l));
  if (provided < 0) return none;
  const providedBy = lines[provided].replace(/^Provided to YouTube by /i, "").trim() || null;
  // The non-empty lines after it: "<title> · <artists>", then the album.
  const after = lines.slice(provided + 1).filter(Boolean);
  const album = after[0]?.includes(" · ") && after[1] && !/^(℗|©|Released on:)/.test(after[1]) ? after[1] : null;
  const parts = after[0]?.includes(" · ") ? after[0].split(" · ").map((x) => x.trim()).filter(Boolean) : [];
  const track = parts.length >= 2 ? { title: parts[0], artists: parts.slice(1) } : null;
  const p = lines.find((l) => l.startsWith("℗"));
  let label: string | null = null;
  if (p) {
    let holder = p.replace(/^℗\s*(\d{4}\s*)?/, "").trim();
    const licensed = /\bunder (?:exclusive )?licen[cs]e to (.+)$/i.exec(holder);
    if (licensed) holder = licensed[1];
    holder = holder.replace(/,\s*a division of .*$/i, "").replace(/[.\s]+$/, "").trim();
    label = holder || null;
  }
  const released = lines.map((l) => /^Released on:\s*(\d{4}(?:-\d{2}(?:-\d{2})?)?)/i.exec(l)?.[1]).find(Boolean);
  return { providedBy, track, album, label, date: released ?? null };
}

export interface YouTubeEvidence {
  kind: YouTubeLink["kind"];
  url: string;
  /** The playlist's title (an album playlist is named "Album - <album>"), or the video's. */
  title: string | null;
  channel: string | null;
  /**
   * `title` is the video's; `name` and `artists` come from an auto-generated description (D64), and are
   * null and empty for any other upload.
   */
  tracks: { videoId: string; title: string; durationMs: number | null; name: string | null; artists: string[] }[];
  /** Agreed by most of the uploads that state one. */
  label: string | null;
  date: string | null;
  album: string | null;
  providedBy: string | null;
}

/** The value most uploads state (ties: the first track's); uploads that state none do not vote. */
function consensus(values: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  for (const [v, n] of counts) if (best === null || n > counts.get(best)!) best = v;
  return best;
}

const errorSchema = z.object({
  error: z.object({
    code: z.number(),
    message: z.string(),
    errors: z.array(z.looseObject({ reason: z.string().optional() })).optional(),
  }),
});
const playlistSchema = z.object({
  items: z.array(z.looseObject({ snippet: z.looseObject({ title: z.string(), channelTitle: z.string().optional() }) })),
});
const itemsSchema = z.object({
  nextPageToken: z.string().optional(),
  items: z.array(z.looseObject({ contentDetails: z.looseObject({ videoId: z.string() }) })),
});
const videosSchema = z.object({
  items: z.array(z.looseObject({
    id: z.string(),
    snippet: z.looseObject({
      title: z.string(),
      description: z.string().default(""),
      channelTitle: z.string().optional(),
    }),
    contentDetails: z.looseObject({ duration: z.string().optional() }),
  })),
});

export class YouTubeError extends Error {
  override name = "YouTubeError";
}

/** The key was refused, or the day's quota is used up: no other request can succeed either. */
export class YouTubeKeyError extends YouTubeError {
  override name = "YouTubeKeyError";
}

export interface YouTubeClientOptions {
  apiKey: string;
  http: PoliteFetchOptions;
  cache: SnapshotCache;
}

export class YouTubeClient {
  readonly #http: PoliteFetchOptions;

  constructor(private readonly opts: YouTubeClientOptions) {
    this.#http = { ...opts.http, headers: { ...opts.http.headers, "X-Goog-Api-Key": opts.apiKey } };
  }

  async #get<T>(path: string, params: Record<string, string>, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const url = new URL(`${API}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    // The key is in a header, so the URL identifies the request without it.
    const cached = await this.opts.cache.get(PROVIDER_ID, url.href, TTL_MS);
    let body = cached?.body;
    if (body === undefined) {
      const res = await politeFetch(url, this.#http, signal);
      const text = await res.text();
      if (!res.ok) throw apiError(res.status, text, url);
      await this.opts.cache.put(PROVIDER_ID, url.href, res.status, text);
      body = text;
    }
    const parsed = schema.safeParse(JSON.parse(body));
    if (!parsed.success) throw new YouTubeError(`unexpected response from YouTube (${path})`);
    return parsed.data;
  }

  /** One cheap request, for the providers page's test button. */
  async check(signal?: AbortSignal): Promise<void> {
    // "Me at the zoo", the first YouTube video: it will not go away. Not cached: the key is what is tested.
    const url = new URL(`${API}/videos`);
    url.searchParams.set("part", "id");
    url.searchParams.set("id", "jNQXAC9IVRw");
    const res = await politeFetch(url, this.#http, signal);
    const text = await res.text();
    if (!res.ok) throw apiError(res.status, text, url);
  }

  async evidence(link: YouTubeLink, signal?: AbortSignal): Promise<YouTubeEvidence> {
    let ids: string[];
    let title: string | null = null;
    let channel: string | null = null;
    if (link.kind === "playlist") {
      const pl = await this.#get("playlists", { part: "snippet", id: link.id }, playlistSchema, signal);
      if (pl.items.length === 0) throw new YouTubeError("YouTube has no such playlist, or it is private");
      title = pl.items[0].snippet.title;
      channel = pl.items[0].snippet.channelTitle ?? null;
      ids = [];
      let pageToken: string | undefined;
      do {
        const page = await this.#get(
          "playlistItems",
          {
            part: "contentDetails",
            playlistId: link.id,
            maxResults: "50",
            ...(pageToken ? { pageToken } : {}),
          },
          itemsSchema,
          signal,
        );
        ids.push(...page.items.map((i) => i.contentDetails.videoId));
        pageToken = page.nextPageToken;
      } while (pageToken && ids.length < MAX_TRACKS);
      if (ids.length > MAX_TRACKS) throw new YouTubeError(`the playlist has more than ${MAX_TRACKS} videos`);
    } else {
      ids = [link.id];
    }

    const videos = new Map<string, z.infer<typeof videosSchema>["items"][number]>();
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const res = await this.#get(
        "videos",
        { part: "snippet,contentDetails", id: batch.join(",") },
        videosSchema,
        signal,
      );
      for (const v of res.items) videos.set(v.id, v);
    }
    if (link.kind === "video") {
      const v = videos.get(link.id);
      if (!v) throw new YouTubeError("YouTube has no such video, or it is private");
      title = v.snippet.title;
      channel = v.snippet.channelTitle ?? null;
    }
    // Deleted and private videos stay in a playlist but are not returned: they still hold a track's place.
    const tracks = ids.map((id) => {
      const v = videos.get(id);
      const facts = v ? parseDescription(v.snippet.description).track : null;
      return {
        videoId: id,
        title: v?.snippet.title ?? "(unavailable video)",
        durationMs: v?.contentDetails.duration ? parseDuration(v.contentDetails.duration) : null,
        name: facts?.title ?? null,
        artists: facts?.artists ?? [],
      };
    });
    const facts = ids.map((id) => videos.get(id)).filter((v) => !!v).map((v) =>
      parseDescription(v.snippet.description)
    );
    return {
      kind: link.kind,
      url: canonicalUrl(link),
      title,
      channel,
      tracks,
      label: consensus(facts.map((f) => f.label)),
      date: consensus(facts.map((f) => f.date)),
      album: consensus(facts.map((f) => f.album)),
      providedBy: consensus(facts.map((f) => f.providedBy)),
    };
  }
}

/** The API's own reason, without the request URL's parameters or anything from the request headers. */
function apiError(status: number, body: string, url: URL): YouTubeError {
  let reason = "";
  let message = "";
  try {
    const e = errorSchema.parse(JSON.parse(body)).error;
    reason = e.errors?.[0]?.reason ?? "";
    message = e.message.replace(/<[^>]+>/g, "");
  } catch {
    // Not the API's error format.
  }
  if (/keyInvalid|API_KEY_INVALID|accessNotConfigured/i.test(reason) || /API key not valid/i.test(message)) {
    return new YouTubeKeyError("YouTube refused the API key (is the YouTube Data API v3 enabled for it?)");
  }
  if (/quotaExceeded|dailyLimitExceeded/i.test(reason)) {
    return new YouTubeKeyError("The YouTube API key's daily quota is used up; try again tomorrow");
  }
  if (status === 404) return new YouTubeError("YouTube has no such video or playlist");
  if (status >= 500) return new YouTubeError(new ProviderHttpError(status, url.href).message);
  return new YouTubeError(`YouTube answered HTTP ${status}${message ? `: ${message.slice(0, 200)}` : ""}`);
}
