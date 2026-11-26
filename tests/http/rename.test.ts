/** The rename preview in the proposal and the per-write choice to leave names alone (D57). */
import { assertEquals } from "@std/assert";
import { reconcileUnit, upsertFile } from "../../server/db/repo/library.ts";
import { saveProposal } from "../../server/db/repo/proposals.ts";
import type { ProposalResponse } from "../../shared/types.ts";
import { makeTestApp, signIn } from "../helpers/app.ts";

Deno.test("the proposal shows the new names when renaming is on, and the choice to leave them", async () => {
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
      tags: { album: "Old Name", title: "One" },
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
    const fileId = (t.db.prepare("SELECT id FROM library_file").get() as { id: number }).id;
    const pid = saveProposal(t.db, {
      candidateId: id,
      releaseMbid: null,
      sourceUrl: "https://www.deezer.com/album/1",
      chosenBy: "user",
      basedOnHash: "h",
      snapshotIds: [],
      build: {
        fields: [{
          fileId,
          field: "album",
          current: "Old Name",
          proposed: "New Name",
          status: "changed",
          locked: false,
          sources: [],
          origin: "deezer",
          conflict: false,
        }],
        unmappedFiles: [],
      },
    }, 1);
    const rename = async () =>
      ((await (await t.request(`/api/library/releases/${id}/proposal`, { cookie })).json()) as ProposalResponse)
        .proposal!.rename;

    assertEquals(await rename(), null, "renaming is off by default");
    t.ctx.settings.files = {
      active: "custom-t",
      renameLibrary: true,
      templates: [{ id: "custom-t", name: "Test", template: "{album}/{title}" }],
    };
    assertEquals(await rename(), {
      include: true,
      folder: "New Name",
      moves: [{ fileId, from: "Old/01.flac", to: "New Name/One.flac" }],
      conflicts: [],
    }, "from the tags as the write leaves them");

    const choose = (include: unknown) =>
      t.request(`/api/proposals/${pid}/rename`, { method: "POST", cookie, csrf, body: JSON.stringify({ include }) });
    assertEquals((await choose("no")).status, 400);
    assertEquals((await choose(false)).status, 204);
    assertEquals((await rename())?.include, false);
    assertEquals(
      (await t.request(`/api/proposals/999/rename`, {
        method: "POST",
        cookie,
        csrf,
        body: JSON.stringify({ include: true }),
      })).status,
      404,
    );
  } finally {
    await t.cleanup();
  }
});
