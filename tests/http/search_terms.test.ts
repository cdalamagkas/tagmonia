/** Search terms over the API (D63): saved and searched with, shown, used as tags, forgotten. */
import { assertEquals } from "@std/assert";
import { reconcileUnit, upsertFile } from "../../server/db/repo/library.ts";
import type { IdentificationDto } from "../../shared/types.ts";
import { makeTestApp, signIn } from "../helpers/app.ts";

Deno.test("search terms: validated, saved, searched with, offered as tags, and forgotten", async () => {
  const t = await makeTestApp();
  try {
    const { cookie, csrf } = await signIn(t);
    upsertFile(t.db, {
      path: "Misc/x.flac",
      folder: "Misc",
      size: 1,
      mtimeMs: 1,
      format: "flac",
      durationMs: 1000,
      sampleRate: null,
      channels: null,
      bitrateKbps: null,
      tags: {},
      pictures: [],
      readError: null,
      scannedAt: 1,
    });
    const [id] = reconcileUnit(t.db, "Misc", [{
      key: "k",
      folder: "Misc",
      paths: ["Misc/x.flac"],
      hintArtist: null,
      hintAlbum: null,
      hintMbid: null,
      contentHash: "h",
    }], 1);
    const send = (method: string, path: string, body?: unknown) =>
      t.request(path, { method, cookie, csrf, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const terms = async () =>
      ((await (await t.request(`/api/library/releases/${id}/identification`, { cookie })).json()) as IdentificationDto)
        .searchTerms;
    const useAsTags = () => send("POST", `/api/library/releases/${id}/proposal`, { fromSearchTerms: true });

    assertEquals(await terms(), null);
    assertEquals((await useAsTags()).status, 409, "no terms yet");
    const empty = await send("PUT", `/api/library/releases/${id}/search-terms`, { artist: " ", album: "" });
    assertEquals([empty.status, (await empty.json()).error], [400, "Give at least one of artist, album or title"]);
    assertEquals((await send("PUT", `/api/library/releases/${id}/search-terms`, { year: "2014" })).status, 400);
    assertEquals((await send("PUT", `/api/library/releases/999/search-terms`, { album: "X" })).status, 404);

    const saved = await send("PUT", `/api/library/releases/${id}/search-terms`, { artist: " Hans Zimmer ", album: "" });
    assertEquals([saved.status, (await saved.json()).kind], [202, "identify"], "identified again with them");
    assertEquals(await terms(), { artist: "Hans Zimmer" });
    assertEquals(
      (await send("PUT", `/api/library/releases/${id}/search-terms`, { album: "Y" })).status,
      409,
      "not while it is being identified",
    );

    assertEquals((await useAsTags()).status, 202);
    t.db.prepare("UPDATE job SET state = 'done'").run();
    assertEquals((await send("DELETE", `/api/library/releases/${id}/search-terms`)).status, 202);
    assertEquals(await terms(), null);
  } finally {
    await t.cleanup();
  }
});
