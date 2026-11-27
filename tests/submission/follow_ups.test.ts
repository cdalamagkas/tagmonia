/** Follow-ups of an added release (D65): cover art and ISRCs, as MusicBrainz has them now. */
import { assertEquals } from "@std/assert";
import { followUpStatus } from "../../server/submission/follow_ups.ts";
import type { MbRelease } from "../../server/providers/musicbrainz/schema.ts";
import { BEETHOVEN_5, loadRelease } from "../identify/helpers.ts";

const known = await loadRelease(BEETHOVEN_5);
const withIsrcs = (r: MbRelease, isrcs: string[][]): MbRelease => ({
  ...r,
  media: [{
    ...r.media[0],
    tracks: r.media[0].tracks!.map((t, i) => ({ ...t, recording: { ...t.recording, isrcs: isrcs[i] ?? [] } })),
  }],
});

Deno.test("cover art: the Cover Art Archive's front image; ISRCs: every one given, on its own track", () => {
  const r = withIsrcs({ ...known, "cover-art-archive": { front: true } }, [["USAAA0000001"], [], ["usaaa0000003"]]);
  assertEquals(followUpStatus(r, ["USAAA0000001", "", "USAAA0000003"], 5), {
    coverArt: true,
    isrcs: true,
    checkedAt: 5,
  });
  assertEquals(followUpStatus(r, ["USAAA0000001", "USAAA0000002"], 5).isrcs, false, "the second is not there yet");
  assertEquals(followUpStatus(r, ["", ""], 5).isrcs, null, "none to submit");
  assertEquals(followUpStatus({ ...known, "cover-art-archive": { front: false } }, [], 5).coverArt, false);
  assertEquals(followUpStatus({ ...known, "cover-art-archive": undefined }, [], 5).coverArt, false);
});
