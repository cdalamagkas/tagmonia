-- The library list's view of each release's prepared changes (D75), so it can filter, sort and count by them
-- across a whole folder. A row is recomputed on read whenever any key it was computed for has changed: the
-- latest proposal's id and revision, the release's content hash, and a global generation. The triggers below
-- keep those keys honest, so no code path has to remember to invalidate.
ALTER TABLE proposal ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE summary_generation (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL
);
INSERT INTO summary_generation (id, value) VALUES (1, 0);

CREATE TABLE release_summary (
  candidate_id INTEGER PRIMARY KEY REFERENCES candidate(id) ON DELETE CASCADE,
  proposal_id  INTEGER,                    -- the latest proposal it was computed from; NULL: none
  revision     INTEGER NOT NULL,
  content_hash TEXT    NOT NULL,
  generation   INTEGER NOT NULL,
  state        TEXT,                       -- ready | choices | stale | none | written; NULL: nothing prepared
  count        INTEGER NOT NULL DEFAULT 0,
  choices      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX release_summary_state ON release_summary(state);

-- A proposal changes: its decisions, its cover, its own columns (state, rename choice, the hash it was built on).
CREATE TRIGGER proposal_revision_update AFTER UPDATE ON proposal WHEN NEW.revision = OLD.revision
BEGIN UPDATE proposal SET revision = revision + 1 WHERE id = NEW.id; END;
CREATE TRIGGER field_proposal_revision_insert AFTER INSERT ON field_proposal
BEGIN UPDATE proposal SET revision = revision + 1 WHERE id = NEW.proposal_id; END;
CREATE TRIGGER field_proposal_revision_update AFTER UPDATE ON field_proposal
BEGIN UPDATE proposal SET revision = revision + 1 WHERE id = NEW.proposal_id; END;
CREATE TRIGGER field_proposal_revision_delete AFTER DELETE ON field_proposal
BEGIN UPDATE proposal SET revision = revision + 1 WHERE id = OLD.proposal_id; END;
CREATE TRIGGER cover_proposal_revision_insert AFTER INSERT ON cover_proposal
BEGIN UPDATE proposal SET revision = revision + 1 WHERE id = NEW.proposal_id; END;
CREATE TRIGGER cover_proposal_revision_update AFTER UPDATE ON cover_proposal
BEGIN UPDATE proposal SET revision = revision + 1 WHERE id = NEW.proposal_id; END;
CREATE TRIGGER cover_proposal_revision_delete AFTER DELETE ON cover_proposal
BEGIN UPDATE proposal SET revision = revision + 1 WHERE id = OLD.proposal_id; END;

-- Changes that can touch any release's count: locks, a chosen destination, and files appearing, going or moving
-- (a new name another album would take blocks its renaming). Settings outside the database bump it in code.
CREATE TRIGGER field_lock_generation_insert AFTER INSERT ON field_lock
BEGIN UPDATE summary_generation SET value = value + 1; END;
CREATE TRIGGER field_lock_generation_delete AFTER DELETE ON field_lock
BEGIN UPDATE summary_generation SET value = value + 1; END;
CREATE TRIGGER candidate_destination_generation AFTER UPDATE OF destination ON candidate
BEGIN UPDATE summary_generation SET value = value + 1; END;
CREATE TRIGGER library_file_generation_insert AFTER INSERT ON library_file
BEGIN UPDATE summary_generation SET value = value + 1; END;
CREATE TRIGGER library_file_generation_delete AFTER DELETE ON library_file
BEGIN UPDATE summary_generation SET value = value + 1; END;
CREATE TRIGGER library_file_generation_path AFTER UPDATE OF path ON library_file
BEGIN UPDATE summary_generation SET value = value + 1; END;
