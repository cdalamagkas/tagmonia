/**
 * Follow-ups of an added release (§12.2, D65): Tagmonia never uploads cover art or submits ISRCs, but it can
 * tell whether MusicBrainz has them yet, from one fresh lookup of the release. Pure.
 */
import type { MbRelease } from "../providers/musicbrainz/schema.ts";

export interface FollowUpStatus {
  /** The Cover Art Archive has a front image for the release. */
  coverArt: boolean;
  /** Every ISRC the providers gave is on its track's recording; null when there were none to submit. */
  isrcs: boolean | null;
  checkedAt: number;
}

/** `isrcs`: the providers' ISRCs in track order ("" where a track has none). */
export function followUpStatus(release: MbRelease, isrcs: string[], now: number): FollowUpStatus {
  const tracks = release.media.flatMap((m) => m.tracks ?? []);
  const wanted = isrcs.map((isrc, i) => ({ isrc: isrc.toUpperCase(), i })).filter((x) => x.isrc);
  return {
    coverArt: release["cover-art-archive"]?.front === true,
    isrcs: wanted.length === 0
      ? null
      : wanted.every(({ isrc, i }) => (tracks[i]?.recording?.isrcs ?? []).some((x) => x.toUpperCase() === isrc)),
    checkedAt: now,
  };
}
