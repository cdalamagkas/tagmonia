-- Follow-ups of an added release (D65): whether MusicBrainz has its cover art and ISRCs yet, as JSON
-- {coverArt, isrcs, checkedAt}; read from a fresh release lookup after the return and on request.
ALTER TABLE submission ADD COLUMN follow_ups TEXT;
