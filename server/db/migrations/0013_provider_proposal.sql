-- Phase 5: proposals for releases not on MusicBrainz (§10.4, D51).
-- source_url: the provider page the proposal was built from; release_mbid is null for these.
ALTER TABLE proposal ADD COLUMN source_url TEXT;
