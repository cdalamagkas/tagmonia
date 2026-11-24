import { assert, assertEquals } from "@std/assert";
import { assign } from "../../server/identify/hungarian.ts";
import { normalizeText, positionFromPath, similarity, titleFromPath } from "../../server/identify/normalize.ts";
import { formatString, normalizeBarcode, normalizeCatno } from "../../server/identify/release.ts";

Deno.test("normalizeText folds case, diacritics, '&' and punctuation, and keeps non-Latin scripts", () => {
  assertEquals(normalizeText("Beyoncé & Jay-Z"), "beyonce and jay z");
  assertEquals(normalizeText("Μίκης Θεοδωράκης"), "μικης θεοδωρακης");
  assertEquals(normalizeText("坂本龍一"), "坂本龍一");
  assertEquals(normalizeText("Don’t Stop"), "dont stop");
});

Deno.test("similarity ignores edition noise in brackets", () => {
  assertEquals(similarity("Abbey Road (Remastered 2019)", "Abbey Road"), 1);
  assertEquals(similarity("Rumours [Deluxe Edition]", "Rumours"), 1);
  // A real subtitle is not noise.
  assert(similarity("Live (At Wembley)", "Live") < 1);
});

Deno.test("similarity orders near matches above unrelated titles", () => {
  const exact = similarity(
    "Symphony no. 5 in C minor, op. 67: I. Allegro con brio",
    "Symphony No.5 - I. Allegro con brio",
  );
  const other = similarity("Symphony no. 5 in C minor, op. 67: I. Allegro con brio", "Finlandia, op. 26");
  assert(exact > 0.6, `near match ${exact}`);
  assert(other < 0.4, `unrelated ${other}`);
  assertEquals(similarity(undefined, "x"), 0);
});

Deno.test("titles and positions are guessed from untagged file names", () => {
  assertEquals(titleFromPath("A/03 - Song Name.flac"), "Song Name");
  assertEquals(titleFromPath("A/1-03 Song_Name.mp3"), "Song Name");
  assertEquals(titleFromPath("A/03.flac"), undefined);
  assertEquals(positionFromPath("A/03 - Song.flac"), { track: 3 });
  assertEquals(positionFromPath("A/2-07 Song.flac"), { disc: 2, track: 7 });
  assertEquals(positionFromPath("A/Song.flac"), {});
});

Deno.test("barcodes compare across UPC/EAN, catalog numbers across separators", () => {
  assertEquals(normalizeBarcode("0602508000001"), normalizeBarcode("602508000001"));
  assertEquals(normalizeBarcode("n/a"), null);
  assertEquals(normalizeCatno("2542 105"), normalizeCatno("2542-105"));
  assertEquals(normalizeCatno("[none]"), null);
});

Deno.test("formatString collapses repeated media", () => {
  assertEquals(formatString(["CD", "CD"]), "2×CD");
  assertEquals(formatString(["CD", "DVD-Video"]), "CD + DVD-Video");
  assertEquals(formatString([null]), "(unknown format)");
});

function bruteForce(cost: number[][]): number {
  const rows = cost.length, cols = cost[0].length;
  const k = Math.min(rows, cols);
  let best = Infinity;
  const used = new Array(cols).fill(false);
  const go = (i: number, picked: number, sum: number) => {
    if (picked === k || i === rows) {
      if (picked === k) best = Math.min(best, sum);
      return;
    }
    // A row may stay unassigned only when there are more rows than columns.
    if (rows - i - 1 >= k - picked) go(i + 1, picked, sum);
    for (let j = 0; j < cols; j++) {
      if (used[j]) continue;
      used[j] = true;
      go(i + 1, picked + 1, sum + cost[i][j]);
      used[j] = false;
    }
  };
  go(0, 0, 0);
  return best;
}

Deno.test("assign finds the minimum-cost assignment on square and rectangular matrices", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (const [r, c] of [[5, 5], [4, 6], [6, 4], [1, 3], [3, 1]]) {
    for (let trial = 0; trial < 20; trial++) {
      const cost = Array.from({ length: r }, () => Array.from({ length: c }, () => Math.round(rand() * 100) / 100));
      const a = assign(cost);
      assertEquals(new Set(a.filter((j) => j >= 0)).size, Math.min(r, c), "each column used at most once");
      const total = a.reduce((s, j, i) => s + (j >= 0 ? cost[i][j] : 0), 0);
      assert(Math.abs(total - bruteForce(cost)) < 1e-9, `${r}x${c}: ${total} vs ${bruteForce(cost)}`);
    }
  }
  assertEquals(assign([]), []);
});
