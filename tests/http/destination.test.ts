/** Destinations (D59): listing library folders, and choosing one for a release. */
import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { reconcileUnit, upsertFile } from "../../server/db/repo/library.ts";
import { saveProposal } from "../../server/db/repo/proposals.ts";
import type { FolderListDto, ProposalResponse } from "../../shared/types.ts";
import { makeTestApp, signIn } from "../helpers/app.ts";

Deno.test("folders: plain subfolders only, confined to the library", async () => {
  const t = await makeTestApp();
  try {
    const { cookie } = await signIn(t);
    for (const d of ["Soundtracks/Interstellar", "soundtracks2", "Classical", ".hidden", "@inbox"]) {
      await Deno.mkdir(join(t.musicDir, d), { recursive: true });
    }
    await Deno.writeTextFile(join(t.musicDir, "a file.txt"), "x");
    const outside = await Deno.makeTempDir();
    await Deno.symlink(outside, join(t.musicDir, "Link"));
    const list = async (path: string) => {
      const r = await t.request(`/api/library/folders?${new URLSearchParams({ path })}`, { cookie });
      return { status: r.status, body: await r.json() };
    };
    const top = await list("");
    assertEquals(top.status, 200);
    assertEquals((top.body as FolderListDto).folders, ["Classical", "Soundtracks", "soundtracks2"]);
    assertEquals((await list("Soundtracks")).body.folders, ["Interstellar"]);
    assertEquals((await list("../")).status, 400);
    assertEquals((await list("Nope")).status, 404);
    assertEquals((await list("Link")).status, 404, "a symlink out of the library is not followed");
    assertEquals((await t.request("/api/library/folders")).status, 401);
    await Deno.remove(outside, { recursive: true });
  } finally {
    await t.cleanup();
  }
});

Deno.test("a release's destination: saved, validated, shown, and it makes the write move the album", async () => {
  const t = await makeTestApp();
  try {
    const { cookie, csrf } = await signIn(t);
    upsertFile(t.db, {
      path: "Old/01.flac",
      folder: "Old",
      size: 1,
      mtimeMs: 1,
      format: "flac",
      durationMs: 1000,
      sampleRate: null,
      channels: null,
      bitrateKbps: null,
      tags: { album: "Interstellar", albumartist: "Hans Zimmer", title: "One" },
      pictures: [],
      readError: null,
      scannedAt: 1,
    });
    const [id] = reconcileUnit(t.db, "Old", [{
      key: "k",
      folder: "Old",
      paths: ["Old/01.flac"],
      hintArtist: null,
      hintAlbum: null,
      hintMbid: null,
      contentHash: "h",
    }], 1);
    saveProposal(t.db, {
      candidateId: id,
      releaseMbid: null,
      sourceUrl: "https://www.deezer.com/album/1",
      chosenBy: "user",
      basedOnHash: "h",
      snapshotIds: [],
      build: {
        fields: [{
          fileId: (t.db.prepare("SELECT id FROM library_file").get() as { id: number }).id,
          field: "title",
          current: "One",
          proposed: "One",
          status: "unchanged",
          locked: false,
          sources: [],
          origin: "deezer",
          conflict: false,
        }],
        unmappedFiles: [],
      },
    }, 1);
    t.ctx.settings.files = {
      active: "custom-t",
      renameLibrary: false,
      templates: [{ id: "custom-t", name: "Test", template: "{albumartist}/{album}/{title}" }],
    };
    const get = async () =>
      (await (await t.request(`/api/library/releases/${id}/proposal`, { cookie })).json()) as ProposalResponse;
    const put = (folder: unknown, rid = id) =>
      t.request(`/api/library/releases/${rid}/destination`, {
        method: "PUT",
        cookie,
        csrf,
        body: JSON.stringify({ folder }),
      });

    assertEquals([(await get()).destination, (await get()).proposal!.rename], [null, null], "renaming off: nothing");
    assertEquals((await put("../x")).status, 400);
    assertEquals((await put("a:b")).status, 400);
    assertEquals((await put(5)).status, 400);
    assertEquals((await put("Films", 999)).status, 404);
    assertEquals(
      (await t.request(`/api/library/releases/${id}/destination`, { method: "PUT", cookie, body: '{"folder":null}' }))
        .status,
      403,
      "CSRF",
    );
    assertEquals((await put("Films/Interstellar/")).status, 204);
    const r = await get();
    assertEquals(r.destination, "Films/Interstellar", "a trailing slash is dropped");
    assertEquals(r.proposal!.rename?.moves.map((m) => m.to), ["Films/Interstellar/Interstellar/One.flac"]);
    assertEquals(r.proposal!.rename?.include, true);
    const recent = await (await t.request("/api/library/folders", { cookie })).json() as FolderListDto;
    assertEquals(recent.recent, ["Films/Interstellar"]);
    assertEquals((await put(null)).status, 204);
    assertEquals([(await get()).destination, (await get()).proposal!.rename], [null, null]);
  } finally {
    await t.cleanup();
  }
});
