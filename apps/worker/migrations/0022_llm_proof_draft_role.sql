BEGIN;

ALTER TABLE llm_calls DROP CONSTRAINT llm_calls_role_check;
ALTER TABLE llm_calls
  ADD CONSTRAINT llm_calls_role_check
  CHECK (role IN (
    'topic-extractor',
    'move-shortlister',
    'proof-state-formalizer',
    'background-proposer',
    'librarian',
    'move-executor',
    'move-author',
    'proof-draft',
    'proof-planner',
    'step-translator'
  ));

COMMIT;
