-- A pasted link's release may be on MusicBrainz after all (D68): releases found by its page, barcode or title
-- that were not certain enough to switch to, offered in the Match tab. JSON list.
ALTER TABLE proposal ADD COLUMN mb_candidates TEXT NOT NULL DEFAULT '[]';
