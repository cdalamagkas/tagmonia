import { assertEquals } from "@std/assert";
import { albumKey, type GroupFile, groupUnit, isDiscFolder, unitRoot } from "../../server/scanner/group.ts";
import type { CanonicalTags } from "../../server/tagio/types.ts";

const f = (path: string, tags: CanonicalTags): GroupFile => ({
  path,
  folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
  tags,
});
const shape = (root: string, files: GroupFile[]) =>
  groupUnit(root, files).map((g) => ({ album: g.hintAlbum, artist: g.hintArtist, loose: g.loose, paths: g.paths }));

Deno.test("disc folder names", () => {
  for (const yes of ["CD1", "CD 2", "cd-03", "Disc 1", "DISC_2", "Disk3", "disc 1 - Bonus", "Disco 2", "Disque 1"]) {
    assertEquals(isDiscFolder(`A/B/${yes}`), true, yes);
  }
  for (const no of ["CDs", "Discography", "Disco Inferno", "1999", "Discovery 1"]) {
    assertEquals(isDiscFolder(`A/${no}`), false, no);
  }
  assertEquals(unitRoot("Artist/Album/CD2"), "Artist/Album");
  assertEquals(unitRoot("Artist/Album"), "Artist/Album");
  assertEquals(unitRoot("CD1"), "", "a disc folder at the top level belongs to the root unit");
});

Deno.test("album identity: MBID first, then album artist + album, normalised; compilations stay together", () => {
  assertEquals(
    albumKey({ album: "Abbey  Road", albumartist: "The Beatles" }),
    albumKey({ album: "abbey road", albumartist: "THE BEATLES" }),
  );
  assertEquals(
    albumKey({ album: "Now 1", artist: "A" }),
    albumKey({ album: "Now 1", artist: "B" }),
    "track artist is not part of the key",
  );
  assertEquals(albumKey({ musicbrainz_albumid: "ABC", album: "x" }), "mbid:abc");
  assertEquals(albumKey({ title: "no album" }), undefined);
  assertEquals(albumKey({ album: "   " }), undefined);
});

Deno.test("one folder, one album", () => {
  const files = [
    f("A/Alb/02.flac", { album: "Alb", albumartist: "A", artist: "A feat. B" }),
    f("A/Alb/01.flac", { album: "Alb", albumartist: "A", artist: "A" }),
  ];
  assertEquals(shape("A/Alb", files), [{
    album: "Alb",
    artist: "A",
    loose: false,
    paths: ["A/Alb/01.flac", "A/Alb/02.flac"],
  }]);
});

Deno.test("multi-disc folders merge into one candidate when album tags agree", () => {
  const files = [
    f("A/Alb/CD1/01.flac", { album: "Alb", albumartist: "A", discnumber: 1 }),
    f("A/Alb/CD2/01.flac", { album: "Alb", albumartist: "A", discnumber: 2 }),
    f("A/Alb/folder-level.flac", { album: "Alb", albumartist: "A" }),
  ];
  const g = shape("A/Alb", files);
  assertEquals(g.length, 1);
  assertEquals(g[0].paths.length, 3);
});

Deno.test("multi-disc folders with different albums stay separate", () => {
  const files = [
    f("Box/CD1/01.flac", { album: "Vol. 1", albumartist: "A" }),
    f("Box/CD2/01.flac", { album: "Vol. 2", albumartist: "A" }),
  ];
  assertEquals(shape("Box", files).map((g) => g.album), ["Vol. 1", "Vol. 2"]);
});

Deno.test("a mixed folder splits by album; untagged files form one loose group per folder", () => {
  const files = [
    f("Mixed/a.mp3", { album: "One", albumartist: "X" }),
    f("Mixed/b.mp3", { album: "Two", albumartist: "Y" }),
    f("Mixed/c.mp3", { album: "One", albumartist: "X" }),
    f("Mixed/d.mp3", { title: "untagged 1" }),
    f("Mixed/e.mp3", {}),
  ];
  const g = shape("Mixed", files);
  assertEquals(g.map((x) => [x.album, x.loose, x.paths.length]), [[null, true, 2], ["One", false, 2], [
    "Two",
    false,
    1,
  ]]);
});

Deno.test("group keys are stable regardless of file order", () => {
  const files = [f("A/1.flac", { album: "Z" }), f("A/2.flac", { album: "Y" }), f("A/3.flac", {})];
  assertEquals(groupUnit("A", files).map((g) => g.key), groupUnit("A", [...files].reverse()).map((g) => g.key));
});
