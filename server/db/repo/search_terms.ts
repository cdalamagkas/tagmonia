/** Search terms per release (D63): typed by the user, kept until cleared. */
import { z } from "zod";
import type { SearchTerms } from "../../../shared/types.ts";
import type { Db } from "../db.ts";

const term = z.string().trim().min(1).max(200).optional();

/** At least one term; empty strings count as absent. */
export const searchTermsSchema = z.preprocess(
  (v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).filter(([, x]) => !(typeof x === "string" && !x.trim())))
      : v,
  z.object({ artist: term, album: term, title: term }).strict().refine(
    (t) => !!(t.artist || t.album || t.title),
    { message: "Give at least one of artist, album or title" },
  ),
);

export function getSearchTerms(db: Db, candidateId: number): SearchTerms | null {
  const r = db.prepare("SELECT search_terms FROM candidate WHERE id = ?").get(candidateId) as
    | { search_terms: string | null }
    | undefined;
  if (!r?.search_terms) return null;
  const parsed = searchTermsSchema.safeParse(JSON.parse(r.search_terms));
  return parsed.success ? parsed.data : null;
}

/** False when there is no such release. */
export function setSearchTerms(db: Db, candidateId: number, terms: SearchTerms | null): boolean {
  return db.prepare("UPDATE candidate SET search_terms = ? WHERE id = ?").run(
    terms === null ? null : JSON.stringify(terms),
    candidateId,
  ).changes > 0;
}
