-- Phase 3: write batches with per-file backups for verification and undo (ARCHITECTURE.md §6.1, §11.3).

CREATE TABLE write_batch (
  id              INTEGER PRIMARY KEY,
  kind            TEXT    NOT NULL,        -- write | undo
  -- SET NULL, not CASCADE: the backups must outlive a rescan that regroups the release, or undo would be lost.
  candidate_id    INTEGER REFERENCES candidate(id) ON DELETE SET NULL,
  proposal_id     INTEGER REFERENCES proposal(id) ON DELETE SET NULL,
  undoes_batch_id INTEGER REFERENCES write_batch(id),
  status          TEXT    NOT NULL,        -- running | done | partial | failed | undone
  files_written   INTEGER NOT NULL DEFAULT 0,
  files_skipped   INTEGER NOT NULL DEFAULT 0,
  files_failed    INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER
);
CREATE INDEX write_batch_candidate ON write_batch(candidate_id, id);

CREATE TABLE file_backup (
  id             INTEGER PRIMARY KEY,
  write_batch_id INTEGER NOT NULL REFERENCES write_batch(id) ON DELETE CASCADE,
  file_id        INTEGER REFERENCES library_file(id) ON DELETE SET NULL,
  path           TEXT    NOT NULL,         -- relative to the music root; outlives the file row
  tags_before    TEXT,                     -- JSON CanonicalTags read just before the write
  change         TEXT,                     -- JSON TagChange applied
  tags_after     TEXT,                     -- JSON CanonicalTags read back after the write
  status         TEXT    NOT NULL,         -- written | skipped_stale | skipped_changed | failed | restored
  error          TEXT
);
CREATE INDEX file_backup_batch ON file_backup(write_batch_id);

-- The review UI's "edit" decision (§10): the user's own value, written instead of the proposed one.
ALTER TABLE field_proposal ADD COLUMN edited_value TEXT;
