BEGIN;

-- Session privacy (design plan §19.3, roadmap N36). Every session is private unless its owner
-- explicitly shares it, including sessions created before this migration. The worker has no
-- authentication yet, so `visibility` is enforced only where it can be today: private sessions
-- are never enumerated, and exporting one requires an explicit acknowledgement. It is not access
-- control; that awaits an authentication system.
ALTER TABLE proof_sessions
  ADD COLUMN visibility text NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'shared'));

COMMIT;
