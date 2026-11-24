-- Phase 3: proposals with per-field provenance and locks (ARCHITECTURE.md §6.1, §10).

CREATE TABLE proposal (
  id             INTEGER PRIMARY KEY,
  candidate_id   INTEGER NOT NULL REFERENCES candidate(id) ON DELETE CASCADE,
  release_mbid   TEXT,                    -- null for a not-in-MusicBrainz proposal (§10.4, Phase 5)
  state          TEXT    NOT NULL,        -- draft | needs_review | approved | written | discarded
  chosen_by      TEXT    NOT NULL,        -- auto (identification matched) | user (picked in the UI)
  based_on_hash  TEXT    NOT NULL,        -- candidate.content_hash when built; differs = files changed since
  snapshot_ids   TEXT    NOT NULL DEFAULT '[]', -- JSON: the responses it was built from (§9.4)
  unmapped_files TEXT    NOT NULL DEFAULT '[]', -- JSON file ids with no track on the release
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX proposal_candidate ON proposal(candidate_id, id);

-- One row per file and field (D40): writes are per file; release-level fields repeat per file.
CREATE TABLE field_proposal (
  id             INTEGER PRIMARY KEY,
  proposal_id    INTEGER NOT NULL REFERENCES proposal(id) ON DELETE CASCADE,
  file_id        INTEGER NOT NULL REFERENCES library_file(id) ON DELETE CASCADE,
  field          TEXT    NOT NULL,        -- canonical name (§6.2)
  current_value  TEXT,                    -- JSON; null when the file has no value
  proposed_value TEXT    NOT NULL,        -- JSON
  status         TEXT    NOT NULL,        -- unchanged | changed | added
  decision       TEXT    NOT NULL DEFAULT 'auto', -- auto | accepted | edited | kept_current
  locked         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (proposal_id, file_id, field)
);

CREATE TABLE field_source (
  id                   INTEGER PRIMARY KEY,
  field_proposal_id    INTEGER NOT NULL REFERENCES field_proposal(id) ON DELETE CASCADE,
  provider             TEXT    NOT NULL,
  value                TEXT    NOT NULL,  -- JSON
  snapshot_id          INTEGER REFERENCES snapshot(id),
  agrees_with_proposed INTEGER NOT NULL
);
CREATE INDEX field_source_field ON field_source(field_proposal_id);

CREATE TABLE field_lock (
  id         INTEGER PRIMARY KEY,
  scope      TEXT    NOT NULL,            -- file | release | global_field
  target     TEXT    NOT NULL,            -- file id, candidate id, or '' for global
  field      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (scope, target, field)
);
