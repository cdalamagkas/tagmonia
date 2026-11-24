/**
 * Phase 2 "Done when": the labelled corpus meets the D26 target (as clarified
 * in D38), replayed from recorded MusicBrainz responses. Re-record with
 * scripts/build_identify_corpus.ts after changing identification code.
 */
import { assert, assertEquals } from "@std/assert";
import { openMigratedDb } from "../../server/db/db.ts";
import { MusicBrainzClient } from "../../server/providers/musicbrainz/client.ts";
import { RateLimiter } from "../../server/providers/ratelimit.ts";
import { SnapshotCache } from "../../server/providers/snapshots.ts";
import { DEFAULT_SETTINGS, identifyConfig } from "../../server/settings.ts";
import { USER_AGENT } from "../../server/version.ts";
import { FakeClock } from "../helpers/fake_clock.ts";
import { replayFetch } from "../helpers/replay_fetch.ts";
import { type CaseOutcome, type ManifestCase, runCase, summarize, table } from "./corpus/evaluate.ts";
import { DAMAGE } from "./corpus/synth.ts";

const manifest: { cases: ManifestCase[] } = JSON.parse(
  await Deno.readTextFile(new URL("./corpus/manifest.json", import.meta.url)),
);

Deno.test({
  name: "labelled corpus meets D26: no wrong auto-match, ≥ 90% ranked first, ≥ 98% shown",
  sanitizeResources: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "tagmonia-accuracy-" });
    const db = await openMigratedDb(":memory:");
    const clock = new FakeClock();
    const client = new MusicBrainzClient({
      cache: new SnapshotCache(db, dir),
      http: {
        userAgent: USER_AGENT,
        clock,
        // Replays only: unrecorded requests throw, so nothing reaches the network.
        fetch: replayFetch(),
        limiter: new RateLimiter({ requests: 1, perMs: 1000 }, clock),
        maxRetries: 0,
      },
    });
    const outcomes: CaseOutcome[] = [];
    try {
      for (const c of manifest.cases) outcomes.push(await runCase(c, client, identifyConfig(DEFAULT_SETTINGS)));
    } finally {
      db.close();
      await Deno.remove(dir, { recursive: true });
    }
    const s = summarize(outcomes);
    const report = `${table(outcomes)}\n${JSON.stringify(s)}`;

    assert(s.identifiable >= 50, `D26 needs at least 50 identifiable releases, have ${s.identifiable}`);
    assertEquals(s.wrongAutoMatches, [], `wrong auto-matches\n${report}`);
    assert(s.rankedFirstRate >= 0.90, `ranked first ${(s.rankedFirstRate * 100).toFixed(1)}% < 90%\n${report}`);
    assert(s.shownRate >= 0.98, `shown ${(s.shownRate * 100).toFixed(1)}% < 98%\n${report}`);
  },
});

Deno.test("the corpus covers every kind of damage, multi-disc, classical and edition cases", () => {
  const kinds = new Set(manifest.cases.map((c) => c.damage));
  for (const d of DAMAGE) assert(kinds.has(d), `no case with damage ${d}`);
  const groups = new Map<string, number>();
  for (const c of manifest.cases) {
    if (c.releaseGroupMbid) groups.set(c.releaseGroupMbid, (groups.get(c.releaseGroupMbid) ?? 0) + 1);
  }
  assert([...groups.values()].filter((n) => n >= 2).length >= 5, "fewer than 5 release groups with two editions");
});
