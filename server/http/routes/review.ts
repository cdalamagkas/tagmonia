/** Review actions (§10): per-field decisions, locks, discarding a proposal. Reviewing never writes files. */
import { inInbox } from "../../write/apply.ts";
import { Hono } from "hono";
import { z } from "zod";
import type { LockDto } from "../../../shared/types.ts";
import type { Db } from "../../db/db.ts";
import {
  addLock,
  discardProposal,
  getProposal,
  removeLock,
  ReviewError,
  setDecisions,
  setRenameSkip,
} from "../../db/repo/proposals.ts";
import { canonicalTagsSchema } from "../../tagio/schema.ts";
import { getCover, setCoverDecision } from "../../db/repo/covers.ts";
import { coverCachePath } from "../../covers/fetch.ts";
import type { CanonicalField } from "../../tagio/types.ts";
import type { AuthEnv } from "../auth.ts";

const FIELDS = Object.keys(canonicalTagsSchema.shape) as [CanonicalField, ...CanonicalField[]];

const decisionBody = z.object({
  fieldIds: z.array(z.number().int().positive()).min(1).max(5000),
  decision: z.enum(["auto", "accepted", "edited", "kept_current"]),
  edited: z.unknown().optional(),
  /** Settle a field with one source's value (D48); goes with decision "accepted". */
  source: z.enum(["musicbrainz", "deezer", "itunes", "tidal", "spotify", "discogs"]).optional(),
}).strict().refine((b) => b.source === undefined || b.decision === "accepted");

const lockBody = z.object({
  scope: z.enum(["file", "release", "global_field"]),
  target: z.string().max(20),
  field: z.enum(FIELDS),
}).strict();

const coverDecisionBody = z.object({ decision: z.enum(["accepted", "kept_current"]) }).strict();

export function reviewRoutes(deps: { db: Db; coverDir: string; now?: () => number }) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  return new Hono<AuthEnv>()
    // The cover's preview, served from Tagmonia's cache so the browser never calls a third party (§14).
    .get("/proposals/:id{[0-9]+}/cover/:which{embed|folder}", async (c) => {
      const cover = getCover(db, Number(c.req.param("id")));
      const image = c.req.param("which") === "embed" ? cover?.embed : cover?.folder;
      if (!image) return c.json({ error: "not found" }, 404);
      try {
        const bytes = await Deno.readFile(coverCachePath(deps.coverDir, image.sha256, image.mime));
        return c.body(bytes, 200, {
          "Content-Type": image.mime,
          "Cache-Control": "private, max-age=86400, immutable",
          "X-Content-Type-Options": "nosniff",
        });
      } catch {
        return c.json({ error: "not found" }, 404);
      }
    })
    .post("/proposals/:id{[0-9]+}/cover/decision", async (c) => {
      const body = coverDecisionBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "invalid decision" }, 400);
      try {
        setCoverDecision(db, Number(c.req.param("id")), body.data.decision, now());
      } catch (e) {
        if (e instanceof ReviewError) return c.json({ error: e.message }, e.message.includes("not found") ? 404 : 409);
        throw e;
      }
      return c.body(null, 204);
    })
    // Renaming (D57): include it in this proposal's write, or leave the file names alone this time.
    .post("/proposals/:id{[0-9]+}/rename", async (c) => {
      const body = z.object({ include: z.boolean() }).strict().safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "Give include: true or false" }, 400);
      const p = getProposal(db, Number(c.req.param("id")));
      if (!p) return c.json({ error: "not found" }, 404);
      if (p.state === "written" || p.state === "discarded") {
        return c.json({ error: `This proposal is already ${p.state}` }, 409);
      }
      if (inInbox(db, p.candidateId)) {
        return c.json({ error: "An inbox album always moves into the library when it is written" }, 409);
      }
      setRenameSkip(db, p.id, !body.data.include);
      return c.body(null, 204);
    })
    .post("/proposals/:id{[0-9]+}/decisions", async (c) => {
      const body = decisionBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "invalid decision" }, 400);
      const { fieldIds, decision, edited, source } = body.data;
      if (decision === "edited") {
        // The edited value must be valid for every field it is applied to (they share one field name in the UI).
        const fields = db.prepare(
          `SELECT DISTINCT field FROM field_proposal WHERE id IN (${fieldIds.map(() => "?").join(",")})`,
        ).all(...fieldIds) as { field: CanonicalField }[];
        for (const { field } of fields) {
          if (edited === undefined || !canonicalTagsSchema.safeParse({ [field]: edited }).success) {
            return c.json({ error: `not a valid value for ${field}` }, 400);
          }
        }
      }
      try {
        setDecisions(db, Number(c.req.param("id")), fieldIds, decision, edited, now(), source);
      } catch (e) {
        if (e instanceof ReviewError) return c.json({ error: e.message }, e.message.includes("not found") ? 404 : 409);
        throw e;
      }
      return c.body(null, 204);
    })
    .post("/proposals/:id{[0-9]+}/discard", (c) => {
      try {
        discardProposal(db, Number(c.req.param("id")), now());
      } catch (e) {
        if (e instanceof ReviewError) return c.json({ error: e.message }, e.message.includes("not found") ? 404 : 409);
        throw e;
      }
      return c.body(null, 204);
    })
    .post("/locks", async (c) => {
      const body = lockBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "invalid lock" }, 400);
      const l = body.data;
      // The target must exist: a lock on a typo would silently protect nothing.
      const exists = l.scope === "global_field" ? l.target === "" : /^[0-9]+$/.test(l.target) &&
        !!db.prepare(`SELECT 1 FROM ${l.scope === "file" ? "library_file" : "candidate"} WHERE id = ?`).get(
          Number(l.target),
        );
      if (!exists) return c.json({ error: "lock target not found" }, 400);
      const lock: LockDto = addLock(db, l, now());
      return c.json(lock, 201);
    })
    .delete("/locks/:id{[0-9]+}", (c) => {
      return removeLock(db, Number(c.req.param("id"))) ? c.body(null, 204) : c.json({ error: "not found" }, 404);
    });
}
