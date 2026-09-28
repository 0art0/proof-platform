BEGIN;

-- Backtracking with information (design plan §16.3) records one worker-only interaction event,
-- `backtracked-with-information`, in the transaction that inserts the case split at an ancestor.
-- It is anchored at the node the cursor moved to and carries no suggestion-set or preview IDs.
ALTER TABLE proof_interaction_events
  DROP CONSTRAINT proof_interaction_events_kind_check;

ALTER TABLE proof_interaction_events
  ADD CONSTRAINT proof_interaction_events_kind_check CHECK (kind IN (
    'selection-changed',
    'suggestions-requested',
    'suggestions-displayed',
    'preview-requested',
    'preview-rejected',
    'menu-expanded',
    'focus-changed',
    'objective-changed',
    'interaction-ended-without-action',
    'preview-regenerated',
    'backtracked-with-information'
  ));

COMMIT;
