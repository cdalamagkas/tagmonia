-- Search terms (D63): what the user typed for a poorly tagged release (artist, album, a track title), as JSON.
-- Identification searches with them; when nothing fits, they can become the release's tags.
ALTER TABLE candidate ADD COLUMN search_terms TEXT;
