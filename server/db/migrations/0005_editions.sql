-- Phase 2 part 5b: editions the identify run found but did not look up (D38),
-- for the edition picker. JSON [{releaseId, summary}].
ALTER TABLE candidate ADD COLUMN unexamined_editions TEXT NOT NULL DEFAULT '[]';
