/** Jellyfin refresh client (§13) against scripted responses; never a live server in the default run. */
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  JellyfinClient,
  JellyfinConfigError,
  JellyfinHttpError,
  pathEndsWithFolder,
} from "../../server/integrations/jellyfin.ts";

const KEY = "jf-secret-key";
const FOLDERS = [
  { Name: "Music", ItemId: "aaa", CollectionType: "music", Locations: ["/data/music"] },
  { Name: "MusicTest", ItemId: "f00d", CollectionType: "music", Locations: ["/music"] },
];

function client(responses: Response[], opts: { library?: string; baseUrl?: string } = {}) {
  const seen: { method: string; url: URL; auth: string | null }[] = [];
  const c = new JellyfinClient({
    baseUrl: opts.baseUrl ?? "http://jellyfin.test:8096",
    apiKey: KEY,
    library: opts.library,
    userAgent: "Tagmonia/test",
    version: "0.1.0",
    fetch: (input, init) => {
      seen.push({
        method: init?.method ?? "GET",
        url: new URL(String(input)),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return Promise.resolve(responses.shift() ?? new Response(null, { status: 500 }));
    },
  });
  return { c, seen };
}

Deno.test("refreshing a named library finds it, then refreshes it recursively without replacing metadata", async () => {
  const { c, seen } = client([Response.json(FOLDERS), new Response(null, { status: 204 })], { library: "musictest" });
  assertEquals(await c.refresh(), { library: "MusicTest" });
  assertEquals(seen.map((s) => `${s.method} ${s.url.pathname}`), [
    "GET /Library/VirtualFolders",
    "POST /Items/f00d/Refresh",
  ]);
  const q = seen[1].url.searchParams;
  assertEquals([q.get("Recursive"), q.get("MetadataRefreshMode"), q.get("ReplaceAllMetadata")], [
    "true",
    "Default",
    "false",
  ]);
});

Deno.test("the API key travels only in the Authorization header", async () => {
  const { c, seen } = client([new Response(null, { status: 204 })]);
  await c.refresh();
  assertEquals(seen[0].url.pathname, "/Library/Refresh", "no library configured: refresh all");
  assert(seen[0].auth!.includes(`Token="${KEY}"`));
  assert(!seen[0].url.href.includes(KEY), "never in the URL");
});

Deno.test("a base URL with a path prefix is kept", async () => {
  const { c, seen } = client([new Response(null, { status: 204 })], { baseUrl: "https://example.test/jellyfin" });
  await c.refresh();
  assertEquals(seen[0].url.href, "https://example.test/jellyfin/Library/Refresh");
});

Deno.test("a rejected key and an unknown library are configuration errors; other failures are HTTP errors", async () => {
  const bad = await assertRejects(() => client([new Response(null, { status: 401 })]).c.refresh(), JellyfinConfigError);
  assert(!bad.message.includes(KEY), "the key is never in an error message");
  await assertRejects(
    () => client([Response.json(FOLDERS)], { library: "Nope" }).c.refresh(),
    JellyfinConfigError,
    'no library named "Nope"',
  );
  await assertRejects(() => client([new Response(null, { status: 503 })]).c.refresh(), JellyfinHttpError);
});

Deno.test("credentials in the URL are refused", () => {
  assertThrows(() => client([], { baseUrl: "https://user:pw@example.test" }));
});

Deno.test("written folders map to Jellyfin albums by whole path segments, Windows paths too", () => {
  assert(pathEndsWithFolder("/music/Artist/Album (2013)", "Artist/Album (2013)"));
  assert(pathEndsWithFolder("D:\\Music\\Artist\\Album", "Artist/Album"));
  assert(pathEndsWithFolder("/music/Beyonce\u0301/Lemonade", "Beyoncé/Lemonade"), "Unicode forms compared alike");
  assert(!pathEndsWithFolder("/music/AB", "B"), "never a partial segment");
  assert(!pathEndsWithFolder("/music/A", ""), "the music root itself is not an album");
});

Deno.test("refreshFolders fully re-reads the written albums and scans for folders Jellyfin does not know", async () => {
  const albums = {
    Items: [
      { Id: "al1", Path: "/music/Mendelssohn Piano Trios (2013)" },
      { Id: "al2", Path: "/music/Other" },
    ],
    TotalRecordCount: 2,
  };
  const { c, seen } = client([
    Response.json(FOLDERS),
    Response.json(albums),
    new Response(null, { status: 204 }),
    Response.json(FOLDERS),
    new Response(null, { status: 204 }),
  ], { library: "MusicTest" });
  const r = await c.refreshFolders(["Mendelssohn Piano Trios (2013)", "New Album"]);
  assertEquals(r, { albums: ["Mendelssohn Piano Trios (2013)"], unknown: ["New Album"], library: "MusicTest" });
  assertEquals(seen.map((s) => `${s.method} ${s.url.pathname}`), [
    "GET /Library/VirtualFolders",
    "GET /Items",
    "POST /Items/al1/Refresh",
    "GET /Library/VirtualFolders",
    "POST /Items/f00d/Refresh",
  ]);
  assertEquals(seen[1].url.searchParams.get("ParentId"), "f00d", "only albums of the configured library");
  const full = seen[2].url.searchParams;
  assertEquals(
    [
      full.get("MetadataRefreshMode"),
      full.get("ReplaceAllMetadata"),
      full.get("Recursive"),
      full.get("ReplaceAllImages"),
    ],
    ["FullRefresh", "true", "true", "false"],
  );
});
