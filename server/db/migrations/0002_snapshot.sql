-- Phase 2: provider snapshot cache (ARCHITECTURE.md §6.1, §9.4).
-- Bodies live on disk under /config/snaps/; rows are never updated, so a
-- proposal can keep pointing at the exact response it was built from.

CREATE TABLE snapshot (
  id          INTEGER PRIMARY KEY,
  provider    TEXT    NOT NULL,             -- "musicbrainz", "acoustid", ...
  request_key TEXT    NOT NULL,             -- canonical request URL without credentials
  status      INTEGER NOT NULL,             -- HTTP status; 404s are cached so a missing MBID is not re-asked every scan
  fetched_at  INTEGER NOT NULL,
  body_path   TEXT    NOT NULL,             -- relative to the snaps directory
  size        INTEGER NOT NULL
);
CREATE INDEX snapshot_lookup ON snapshot(provider, request_key, fetched_at);
