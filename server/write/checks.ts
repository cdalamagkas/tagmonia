/**
 * Whether a proposal may be written now (§11.3 step 1, §10.3 rule 4): the same rules for the Write button and for
 * bulk writes from the library (D75). Null when it may; otherwise why not, in the user's words.
 */
import type { Db } from "../db/db.ts";
import { isUnresolved, type StoredProposal } from "../db/repo/proposals.ts";
import type { JobQueue } from "../jobs/queue.ts";
import { writeDedupeKey } from "../jobs/write.ts";

export function writeBlocker(db: Db, queue: JobQueue, p: StoredProposal): string | null {
  if (p.state === "written" || p.state === "discarded") return `This proposal is already ${p.state}`;
  const cand = db.prepare("SELECT content_hash FROM candidate WHERE id = ?").get(p.candidateId) as
    | { content_hash: string }
    | undefined;
  if (!cand) return "not found";
  // Files changed since the proposal was built.
  if (cand.content_hash !== p.basedOnHash) {
    return "The files changed since this proposal was built; build it again first";
  }
  // A field whose sources disagree waits for the user's choice (D48).
  const open = p.fields.filter(isUnresolved).length;
  if (open > 0) return `${open} field${open === 1 ? "" : "s"} with conflicting sources need a decision`;
  if (queue.live(writeDedupeKey(p.candidateId))) return "A write or undo is already running for this release";
  return null;
}
