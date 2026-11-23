/** Runtime schemas for data crossing the TagIO boundary (sidecar output, stored JSON). */
import { z } from "zod";
import type { CanonicalTags } from "./types.ts";

const multi = z.array(z.string());

export const canonicalTagsSchema = z.object({
  title: z.string(),
  artist: z.string(),
  artists: multi,
  artistsort: z.string(),
  tracknumber: z.number().int(),
  totaltracks: z.number().int(),
  discnumber: z.number().int(),
  totaldiscs: z.number().int(),
  isrc: multi,
  composer: multi,
  lyricist: multi,
  conductor: multi,
  performer: z.record(z.string(), multi),
  work: z.string(),
  musicbrainz_recordingid: z.string(),
  musicbrainz_trackid: z.string(),
  musicbrainz_artistid: multi,
  musicbrainz_workid: multi,
  acoustid_id: z.string(),
  album: z.string(),
  albumartist: z.string(),
  albumartists: multi,
  albumartistsort: z.string(),
  date: z.string(),
  originaldate: z.string(),
  label: multi,
  catalognumber: multi,
  barcode: z.string(),
  media: z.string(),
  releasecountry: z.string(),
  releasestatus: z.string(),
  releasetype: multi,
  script: z.string(),
  language: z.string(),
  genre: multi,
  musicbrainz_albumid: z.string(),
  musicbrainz_releasegroupid: z.string(),
  musicbrainz_albumartistid: multi,
  discogs_release_id: z.string(),
  deezer_album_id: z.string(),
}).partial().strict() satisfies z.ZodType<CanonicalTags>;

const base64Bytes = z.base64().transform((s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

export const pictureWireSchema = z.object({
  type: z.enum(["front", "back", "other"]),
  // Files in the wild carry GIF/BMP covers too; they must survive a backup/undo cycle.
  mime: z.string().regex(/^image\/[\w.+-]+$/),
  data: base64Bytes,
  description: z.string().optional(),
});

export const readResultWireSchema = z.object({
  tags: canonicalTagsSchema,
  pictures: z.array(pictureWireSchema),
  audio: z.object({
    format: z.enum(["flac", "ogg", "opus", "mp3", "m4a"]),
    durationMs: z.number().int().nonnegative(),
    sampleRate: z.number().int().optional(),
    channels: z.number().int().optional(),
    bitrateKbps: z.number().int().optional(),
  }),
  raw: z.record(z.string(), z.array(z.string())),
});
