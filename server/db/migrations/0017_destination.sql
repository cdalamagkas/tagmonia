-- Destinations (D59): a library folder the user chose for a release; its album folder goes there on the
-- next write, instead of where the whole naming template would put it. NULL: the template decides.
ALTER TABLE candidate ADD COLUMN destination TEXT;
