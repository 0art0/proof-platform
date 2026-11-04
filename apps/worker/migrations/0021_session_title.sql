BEGIN;

-- A name a person gives a session while working on it. NULL means the approved problem title in
-- `metadata`, which is never rewritten: renaming is not a proof write and leaves the approved setup
-- exactly as it was approved.
ALTER TABLE proof_sessions
  ADD COLUMN title text
    CHECK (title IS NULL OR (char_length(title) BETWEEN 1 AND 200 AND title = btrim(title)));

COMMIT;
