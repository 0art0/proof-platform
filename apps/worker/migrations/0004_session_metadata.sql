BEGIN;

ALTER TABLE proof_sessions
  ADD COLUMN metadata jsonb
    CHECK (metadata IS NULL OR jsonb_typeof(metadata) = 'object');

COMMIT;
