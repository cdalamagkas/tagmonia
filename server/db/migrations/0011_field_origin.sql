-- Phase 4: providers merged into proposals (§10.3, D48).
-- origin: whose value is proposed ("filled by" when not musicbrainz).
-- conflict: the field's precedence sources disagree; the write waits for a decision.
-- resolved_from: the source the user picked to settle it, if any.
ALTER TABLE field_proposal ADD COLUMN origin TEXT NOT NULL DEFAULT 'musicbrainz';
ALTER TABLE field_proposal ADD COLUMN conflict INTEGER NOT NULL DEFAULT 0;
ALTER TABLE field_proposal ADD COLUMN resolved_from TEXT;
