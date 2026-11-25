-- Phase 5: seeding releases missing from MusicBrainz into its release editor (§12, D52).
-- A submission outlives the proposal it came from: the proposal built from the new MBID replaces it.
CREATE TABLE submission (
  id            INTEGER PRIMARY KEY,
  candidate_id  INTEGER NOT NULL REFERENCES candidate(id) ON DELETE CASCADE,
  proposal_id   INTEGER REFERENCES proposal(id) ON DELETE SET NULL,
  user_id       INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  server        TEXT    NOT NULL,          -- https://musicbrainz.org | https://test.musicbrainz.org
  return_base   TEXT    NOT NULL,          -- Tagmonia's own origin, for the release editor's redirect
  state         TEXT    NOT NULL,          -- checking | ready | seeded | verifying | returned | failed | abandoned
  duplicates    TEXT    NOT NULL DEFAULT '[]', -- JSON: releases MusicBrainz may already have
  seed          TEXT,                      -- JSON form fields for <server>/release/add
  isrcs         TEXT    NOT NULL DEFAULT '[]', -- JSON: ISRCs by track order, for the follow-up (MagicISRC)
  artists       TEXT    NOT NULL DEFAULT '[]', -- JSON: each credited artist, found on the server or not (§12.3)
  artist_choices TEXT   NOT NULL DEFAULT '{}', -- JSON: name -> MBID the user chose for an artist not found by its pages
  release_mbid  TEXT,                      -- returned by MusicBrainz, verified by a lookup
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX submission_candidate ON submission(candidate_id, id);

-- The MusicBrainz server a proposal's release is on, when it is not the configured one (the test server).
ALTER TABLE proposal ADD COLUMN mb_server TEXT;
