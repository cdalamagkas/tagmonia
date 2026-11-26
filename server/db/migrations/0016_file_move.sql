-- Renaming on write (D57): each file a write batch moved, so its undo can move it back, and a
-- per-proposal choice to leave the names alone for that write.
CREATE TABLE file_move (
  id             INTEGER PRIMARY KEY,
  write_batch_id INTEGER NOT NULL REFERENCES write_batch(id) ON DELETE CASCADE,
  file_id        INTEGER REFERENCES library_file(id) ON DELETE SET NULL,
  kind           TEXT    NOT NULL,          -- audio | companion (cover.jpg, booklet.pdf, … moved with the album)
  from_path      TEXT    NOT NULL,          -- relative to the music root
  to_path        TEXT    NOT NULL,
  status         TEXT    NOT NULL,          -- moved | undone | failed
  error          TEXT
);
CREATE INDEX file_move_batch ON file_move(write_batch_id);

ALTER TABLE proposal ADD COLUMN rename_skip INTEGER NOT NULL DEFAULT 0;
