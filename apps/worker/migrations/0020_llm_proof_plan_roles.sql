BEGIN;

-- Motivated proof plans add two session-owned roles: the proof planner, which writes one structured
-- proof, and the step translator, whose Jev calls turn its steps into displayed actions. As the last
-- widening, the list names every role.
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
    'proof-planner',
    'step-translator'
  ));

COMMIT;
