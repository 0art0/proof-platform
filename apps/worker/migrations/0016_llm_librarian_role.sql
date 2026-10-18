BEGIN;

-- The librarian's owner-scoped evidence uses the same immutable call table as the other roles, and
-- the user's bulk approval of its results is stored beside the other proposal decisions in
-- llm_topic_decisions (rows are discriminated by the role of the call they reference). Widen the
-- role constraint in a new migration so databases that already ran 0002, 0013 and 0015 remain
-- valid. The list holds every role that exists on this branch.
ALTER TABLE llm_calls DROP CONSTRAINT llm_calls_role_check;
ALTER TABLE llm_calls
  ADD CONSTRAINT llm_calls_role_check
  CHECK (role IN (
    'topic-extractor',
    'move-shortlister',
    'proof-state-formalizer',
    'background-proposer',
    'librarian'
  ));

COMMIT;
