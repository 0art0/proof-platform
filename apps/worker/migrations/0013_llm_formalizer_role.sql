BEGIN;

-- The N26 formalizer's owner-scoped evidence uses the same immutable call table as other roles.
-- Expand the role constraint in a new migration so databases that already ran 0002 remain valid.
ALTER TABLE llm_calls DROP CONSTRAINT llm_calls_role_check;
ALTER TABLE llm_calls
  ADD CONSTRAINT llm_calls_role_check
  CHECK (role IN ('topic-extractor', 'move-shortlister', 'proof-state-formalizer'));

COMMIT;
