-- Phase 1: users and sessions, library index, job queue (ARCHITECTURE.md §6.1, §14.1).
-- Times are Unix epoch milliseconds. Paths are relative to the music root with '/' separators.

CREATE TABLE app_user (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,           -- Argon2id PHC string
  is_admin      INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

CREATE TABLE session (
  id_hash      TEXT    PRIMARY KEY,         -- SHA-256 of the cookie value; the value itself is never stored
  user_id      INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  csrf_token   TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL             -- absolute lifetime
);
CREATE INDEX session_user ON session(user_id);

CREATE TABLE candidate (
  id               INTEGER PRIMARY KEY,
  group_key        TEXT    NOT NULL UNIQUE, -- stable identity across rescans
  folder           TEXT    NOT NULL,        -- unit folder; for multi-disc sets, the parent of the disc folders
  hint_artist      TEXT,
  hint_album       TEXT,
  hint_mbid        TEXT,
  hint_track_count INTEGER NOT NULL DEFAULT 0,
  file_count       INTEGER NOT NULL DEFAULT 0,
  content_hash     TEXT    NOT NULL,        -- changes when member files change
  status           TEXT    NOT NULL DEFAULT 'new', -- new | changed (Phase 2 adds identification states)
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX candidate_folder ON candidate(folder);

CREATE TABLE library_file (
  id           INTEGER PRIMARY KEY,
  path         TEXT    NOT NULL UNIQUE,
  folder       TEXT    NOT NULL,            -- dirname(path), '' for the root
  size         INTEGER NOT NULL,
  mtime_ms     INTEGER NOT NULL,
  format       TEXT,                        -- null when the file could not be read
  duration_ms  INTEGER,
  sample_rate  INTEGER,
  channels     INTEGER,
  bitrate_kbps INTEGER,
  fingerprint  TEXT,                        -- Phase 2
  acoustid_id  TEXT,                        -- Phase 2
  current_tags TEXT    NOT NULL DEFAULT '{}', -- JSON CanonicalTags
  pictures     TEXT    NOT NULL DEFAULT '[]', -- JSON [{type, mime, size}]
  read_error   TEXT,
  candidate_id INTEGER REFERENCES candidate(id) ON DELETE SET NULL,
  scanned_at   INTEGER NOT NULL
);
CREATE INDEX library_file_folder ON library_file(folder);
CREATE INDEX library_file_candidate ON library_file(candidate_id);

CREATE TABLE job (
  id           INTEGER PRIMARY KEY,
  kind         TEXT    NOT NULL,
  payload      TEXT    NOT NULL DEFAULT '{}',
  state        TEXT    NOT NULL DEFAULT 'queued', -- queued | running | done | failed | cancelled
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after    INTEGER NOT NULL,
  dedupe_key   TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  progress     TEXT,                        -- JSON, handler-defined
  result       TEXT,                        -- JSON
  error        TEXT,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER
);
CREATE INDEX job_ready ON job(state, run_after);
-- At most one live job per dedupe key (e.g. one library scan at a time).
CREATE UNIQUE INDEX job_dedupe ON job(dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('queued', 'running');
