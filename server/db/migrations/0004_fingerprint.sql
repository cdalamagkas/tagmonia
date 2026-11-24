-- Phase 2 part 4: AcoustID fingerprints (ARCHITECTURE.md §8 order 4).
-- library_file.fingerprint and acoustid_id exist since 0001; fpcalc also reports
-- the duration AcoustID wants, which can differ from the tag reader's by a second.
ALTER TABLE library_file ADD COLUMN fingerprint_duration INTEGER;
