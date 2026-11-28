/**
 * Each release's prepared changes, counted with the Changes tab's own rules (shared/changes.ts, D61), and the cache
 * the library list filters, sorts and counts by (D75). A cached row is recomputed when any key it was computed for
 * changed: the latest proposal's id and revision, the release's content hash, the global generation. Triggers in
 * migration 0022 keep those keys current; `bumpGeneration` covers the settings that live outside the database.
 */
import type { ReleaseChangesDto, RenameProposalDto } from "../../shared/types.ts";
import { changesToWrite, openChoices } from "../../shared/changes.ts";
import type { Db } from "../db/db.ts";
import { coverWrites, getCover } from "../db/repo/covers.ts";
import { latestProposal } from "../db/repo/proposals.ts";
import { destinationOf, TakenNames } from "../files/rename.ts";
import { inInbox, renamePlanFor } from "../write/apply.ts";

export type Naming = { template: string; renameLibrary: boolean } | undefined;

/** The new names a write of an open proposal would give (D57); null when renaming is off or nothing changes. */
export function renameDto(
  db: Db,
  naming: { template: string; renameLibrary: boolean } | undefined,
  p: NonNullable<ReturnType<typeof latestProposal>>,
  taken?: string[] | TakenNames,
): RenameProposalDto | null {
  if (!["draft", "needs_review", "approved"].includes(p.state)) return null;
  const plan = renamePlanFor(db, naming, p, false, taken);
  if (!plan || plan.moves.length === 0) return null;
  const folders = [...new Set(plan.moves.map((m) => m.to.split("/").slice(0, -1).join("/")))];
  const inbox = inInbox(db, p.candidateId);
  return {
    // An inbox album always moves into the library: no choice to offer.
    include: inbox || !p.renameSkip,
    inbox,
    folder: folders.length === 1 ? folders[0] : commonFolder(folders),
    moves: plan.moves,
    conflicts: plan.conflicts,
  };
}

/**
 * The latest prepared changes of each release (D61), for the library list: counted with the Changes tab's own
 * rules (shared/changes.ts), the cover and the move included.
 */
export function releaseChanges(
  db: Db,
  naming: { template: string; renameLibrary: boolean } | undefined,
  ids: number[],
): Map<number, ReleaseChangesDto | null> {
  const out = new Map<number, ReleaseChangesDto | null>();
  let taken: TakenNames | undefined;
  for (const id of ids) {
    const p = latestProposal(db, id);
    if (!p || p.state === "discarded") {
      out.set(id, null);
      continue;
    }
    if (p.state === "written") {
      out.set(id, { state: "written", count: 0, choices: 0 });
      continue;
    }
    const hash = (db.prepare("SELECT content_hash FROM candidate WHERE id = ?").get(id) as { content_hash: string })
      .content_hash;
    const w = coverWrites(getCover(db, p.id));
    // One list of the library's paths for every album's rename preview, not one per album.
    if (naming?.renameLibrary || inInbox(db, id) || destinationOf(db, id) !== null) {
      taken ??= new TakenNames(
        (db.prepare("SELECT path FROM library_file").all() as { path: string }[]).map((r) => r.path),
      );
    }
    const counted = {
      fields: p.fields,
      cover: { writes: w.embed || w.folder },
      rename: renameDto(db, naming, p, taken),
    };
    const count = changesToWrite(counted);
    const choices = openChoices(counted);
    out.set(id, {
      state: p.basedOnHash !== hash ? "stale" : choices > 0 ? "choices" : count > 0 ? "ready" : "none",
      count,
      choices,
    });
  }
  return out;
}

function commonFolder(folders: string[]): string {
  let common = folders[0].split("/");
  for (const f of folders.slice(1)) {
    const parts = f.split("/");
    let i = 0;
    while (i < common.length && common[i] === parts[i]) i++;
    common = common.slice(0, i);
  }
  return common.join("/");
}

/** Something outside the database that every release's count depends on changed (the naming settings). */
export function bumpGeneration(db: Db): void {
  db.prepare("UPDATE summary_generation SET value = value + 1").run();
}

/**
 * Brings the cache up to date for every release whose keys changed (or `ids` only), and returns how many rows it
 * recomputed. Cheap when nothing changed: one query finds the stale rows.
 */
export function refreshSummaries(db: Db, naming: Naming, ids?: number[]): number {
  const only = ids ? `AND c.id IN (${ids.map(() => "?").join(",") || "NULL"})` : "";
  const stale = db.prepare(
    `SELECT c.id, c.content_hash, p.id AS proposal_id, coalesce(p.revision, 0) AS revision, g.value AS generation
     FROM candidate c
     CROSS JOIN summary_generation g
     LEFT JOIN proposal p ON p.id = (SELECT max(id) FROM proposal WHERE candidate_id = c.id)
     LEFT JOIN release_summary s ON s.candidate_id = c.id
     WHERE (s.candidate_id IS NULL OR s.proposal_id IS NOT p.id OR s.revision != coalesce(p.revision, 0)
            OR s.content_hash != c.content_hash OR s.generation != g.value) ${only}`,
  ).all(...(ids ?? [])) as {
    id: number;
    content_hash: string;
    proposal_id: number | null;
    revision: number;
    generation: number;
  }[];
  if (stale.length === 0) return 0;
  const changes = releaseChanges(db, naming, stale.map((r) => r.id));
  const upsert = db.prepare(
    `INSERT INTO release_summary (candidate_id, proposal_id, revision, content_hash, generation, state, count, choices)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (candidate_id) DO UPDATE SET proposal_id = excluded.proposal_id, revision = excluded.revision,
       content_hash = excluded.content_hash, generation = excluded.generation, state = excluded.state,
       count = excluded.count, choices = excluded.choices`,
  );
  for (const r of stale) {
    const c = changes.get(r.id) ?? null;
    upsert.run(
      r.id,
      r.proposal_id,
      r.revision,
      r.content_hash,
      r.generation,
      c?.state ?? null,
      c?.count ?? 0,
      c?.choices ?? 0,
    );
  }
  return stale.length;
}
