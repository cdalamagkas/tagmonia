-- Phase 4: cover art (§10.3, §11.3, D49).

-- The release's proposed front cover: one per proposal, decided once for every file.
CREATE TABLE cover_proposal (
  proposal_id     INTEGER PRIMARY KEY REFERENCES proposal(id) ON DELETE CASCADE,
  mode            TEXT    NOT NULL,        -- embed_1200 | embed_full | folder | both (the setting when built)
  source          TEXT,                    -- coverartarchive | itunes | deezer | discogs; null = none found
  skipped         TEXT    NOT NULL DEFAULT '[]', -- JSON [{source, reason}]: sources passed over
  embed           TEXT,                    -- JSON cached image {sha256, mime, width, height, size, url}
  folder          TEXT,                    -- JSON cached image for the folder file
  embed_status    TEXT,                    -- added | changed | unchanged; null = nothing to embed
  folder_status   TEXT,
  folder_path     TEXT,                    -- relative to the music root, e.g. "Artist/Album/cover.jpg"
  folder_current  TEXT,                    -- SHA-256 of the folder file when built; null = absent
  decision        TEXT    NOT NULL DEFAULT 'auto' -- auto | accepted | kept_current
);

-- Picture backups: image bytes live in /config/backups/pictures/<sha256>.<ext>, referenced here.
ALTER TABLE file_backup ADD COLUMN kind TEXT NOT NULL DEFAULT 'tags'; -- tags | folder_image
ALTER TABLE file_backup ADD COLUMN pictures_before TEXT;  -- JSON [{type, mime, description, sha256}]
ALTER TABLE file_backup ADD COLUMN pictures_after TEXT;
