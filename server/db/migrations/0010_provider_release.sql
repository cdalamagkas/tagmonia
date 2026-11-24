-- Phase 4: the chosen release as found on Deezer, iTunes and Discogs (§10.1, D47).
-- One row per proposal and provider; part 3 merges their values into the fields.
CREATE TABLE provider_release (
  proposal_id INTEGER NOT NULL REFERENCES proposal(id) ON DELETE CASCADE,
  provider    TEXT    NOT NULL,              -- deezer | itunes | discogs
  status      TEXT    NOT NULL,              -- found | different_edition | not_found | skipped | error
  via         TEXT,                          -- link | barcode
  url         TEXT,
  reason      TEXT,
  data        TEXT,                          -- JSON Harmony release, for found / different_edition
  fetched_at  INTEGER NOT NULL,
  PRIMARY KEY (proposal_id, provider)
);
