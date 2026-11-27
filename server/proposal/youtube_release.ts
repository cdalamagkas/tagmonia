/**
 * YouTube as a source (D64, revising D55): the official Data API's facts about a playlist or video, shaped
 * as a provider release, so a proposal, its track mapping and a MusicBrainz submission are built from it
 * exactly as from a Deezer or Bandcamp album. Pure.
 *
 * Auto-generated uploads ("Provided to YouTube by …") carry the track's title and artists, the album, the ℗
 * line and the release date in their descriptions. Any other upload gives only its video title and channel.
 */
import type { HarmonizedRelease } from "../providers/harmony_adapter.ts";
import { parseYouTubeUrl, type YouTubeEvidence } from "../providers/youtube.ts";

type Credit = HarmonizedRelease["artists"];

/** "A", "A & B", "A, B & C". */
function credit(names: string[]): Credit {
  return names.map((name, i) => ({
    name,
    ...(i < names.length - 2 ? { joinPhrase: ", " } : i === names.length - 2 ? { joinPhrase: " & " } : {}),
  }));
}

/** An auto-generated channel is "<artist> - Topic". */
function topicArtist(channel: string | null): string | null {
  const m = channel ? /^(.+) - Topic$/.exec(channel.trim()) : null;
  return m ? m[1] : null;
}

/** The artists most tracks credit, as a list (ties: the first track's). */
function commonArtists(tracks: YouTubeEvidence["tracks"]): string[] {
  const counts = new Map<string, { names: string[]; n: number }>();
  for (const t of tracks) {
    if (!t.artists.length) continue;
    const k = JSON.stringify(t.artists);
    const c = counts.get(k);
    if (c) c.n++;
    else counts.set(k, { names: t.artists, n: 1 });
  }
  let best: { names: string[]; n: number } | null = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best?.names ?? [];
}

function releaseDate(date: string | null): HarmonizedRelease["releaseDate"] {
  const m = date ? /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(date) : null;
  if (!m) return undefined;
  return {
    date: { year: Number(m[1]), ...(m[2] ? { month: Number(m[2]) } : {}), ...(m[3] ? { day: Number(m[3]) } : {}) },
    quality: "assumed-valid",
  };
}

/** The album, named by the descriptions, else the playlist ("Album - <album>"), else the video. */
export function youtubeAlbumTitle(e: YouTubeEvidence): string {
  return e.album ?? e.title?.replace(/^Album - /, "").trim() ?? "Untitled";
}

export function youtubeRelease(e: YouTubeEvidence): HarmonizedRelease {
  const link = parseYouTubeUrl(new URL(e.url));
  const id = "error" in link ? e.url : link.id;
  // The album's artist: an auto-generated channel names it; else whom most tracks credit; else the channel.
  const topic = topicArtist(e.channel);
  const common = commonArtists(e.tracks);
  const albumArtists = topic ? [topic] : common.length ? common : e.channel ? [e.channel] : [];
  const date = releaseDate(e.date);
  return {
    title: youtubeAlbumTitle(e),
    artists: credit(albumArtists),
    externalLinks: [{ url: e.url, types: ["free streaming"] }],
    media: [{
      number: 1,
      format: "Digital Media",
      tracklist: e.tracks.map((t, i) => ({
        number: i + 1,
        title: t.name ?? t.title,
        ...(t.artists.length ? { artists: credit(t.artists) } : {}),
        ...(t.durationMs ? { length: t.durationMs } : {}),
      })),
    }],
    ...(date ? { releaseDate: date } : {}),
    ...(e.label ? { labels: [{ name: e.label }] } : {}),
    info: {
      providers: [{ name: "YouTube", internalName: "youtube", id, url: e.url, lookup: { method: "id", value: id } }],
      messages: [],
    },
  };
}
