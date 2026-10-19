BEGIN;

-- The background proposer's owner-scoped evidence uses the same immutable call table as the other
-- roles, and its approval decisions are stored beside the topic decisions in llm_topic_decisions
-- (their rows are discriminated by the role of the call they reference). Widen the role constraint
-- in a new migration so databases that already ran 0002 and 0013 remain valid.
ALTER TABLE llm_calls DROP CONSTRAINT llm_calls_role_check;
ALTER TABLE llm_calls
  ADD CONSTRAINT llm_calls_role_check
  CHECK (role IN (
    'topic-extractor',
    'move-shortlister',
    'proof-state-formalizer',
    'background-proposer'
  ));

COMMIT;
