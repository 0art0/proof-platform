BEGIN;

-- The move executor's call evidence is session-owned, in the same immutable call table as the other
-- roles. Widen the role constraint in a new migration so databases that already ran 0013 stay valid.
-- As the last widening, its list names every role, including those added by 0015 and 0016.
ALTER TABLE llm_calls DROP CONSTRAINT llm_calls_role_check;
ALTER TABLE llm_calls
  ADD CONSTRAINT llm_calls_role_check
  CHECK (role IN (
    'topic-extractor',
    'move-shortlister',
    'proof-state-formalizer',
    'background-proposer',
    'librarian',
    'move-executor'
  ));

COMMIT;
