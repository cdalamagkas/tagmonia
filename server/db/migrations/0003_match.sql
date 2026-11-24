-- Phase 2: scored MusicBrainz releases per candidate (ARCHITECTURE.md §6.1 `match`, §8).
-- An identify run replaces a candidate's matches; the review UI (part 5) reads them.

CREATE TABLE match (
  id                 INTEGER PRIMARY KEY,
  candidate_id       INTEGER NOT NULL REFERENCES candidate(id) ON DELETE CASCADE,
  rank               INTEGER NOT NULL,       -- 0 = best
  release_mbid       TEXT    NOT NULL,
  release_group_mbid TEXT,
  score              REAL    NOT NULL,
  method             TEXT    NOT NULL,       -- existing_mbid | barcode | catno | text | fingerprint | manual
  signals            TEXT    NOT NULL,       -- JSON {signal: number | null}, plus coverage/capped flags
  track_mapping      TEXT    NOT NULL,       -- JSON TrackMapping
  summary            TEXT    NOT NULL,       -- JSON ReleaseSummary for the edition picker
  snapshot_id        INTEGER REFERENCES snapshot(id),
  created_at         INTEGER NOT NULL,
  UNIQUE (candidate_id, release_mbid)
);
CREATE INDEX match_candidate ON match(candidate_id, rank);

-- Candidate status gains: identifying | matched | needs_review | no_match | error.
ALTER TABLE candidate ADD COLUMN identified_at INTEGER;
ALTER TABLE candidate ADD COLUMN identify_error TEXT;
-- The content hash the last identify run saw; a rescan that changes files makes it stale.
ALTER TABLE candidate ADD COLUMN identified_hash TEXT;
