-- Album folders written since the last music-server refresh (§13, D44). The
-- debounced refresh job takes them all at once; a write during a running
-- refresh waits here for the next one instead of being lost.
CREATE TABLE refresh_pending (
  folder    TEXT    PRIMARY KEY,           -- relative to the music root, like candidate.folder
  queued_at INTEGER NOT NULL
);
