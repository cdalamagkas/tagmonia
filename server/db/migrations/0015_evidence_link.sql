-- Evidence links (§9.5, D55): a YouTube video or playlist the user pasted for a release. Every proposal
-- built for the release looks it up again and adds its date and label as evidence.
CREATE TABLE evidence_link (
  candidate_id INTEGER PRIMARY KEY REFERENCES candidate(id) ON DELETE CASCADE,
  provider     TEXT    NOT NULL,             -- youtube
  url          TEXT    NOT NULL,             -- canonical: …/playlist?list=… or …/watch?v=…
  added_at     INTEGER NOT NULL
);
