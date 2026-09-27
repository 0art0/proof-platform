BEGIN;

-- Ordered, node-anchored interaction events (refinement §12.1): selections, suggestion requests
-- and displays, preview requests and rejections, menu expansions, focus and objective changes,
-- interactions that ended without an action, and worker-recorded preview regenerations
-- (refinement §12.2). None of them changes proof state. The client supplies the event ID, which
-- makes recording idempotent; the worker assigns `sequence` under the session row lock.
CREATE TABLE proof_interaction_events (
  session_id text NOT NULL,
  id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  node_id text NOT NULL,
  state_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'selection-changed',
    'suggestions-requested',
    'suggestions-displayed',
    'preview-requested',
    'preview-rejected',
    'menu-expanded',
    'focus-changed',
    'objective-changed',
    'interaction-ended-without-action',
    'preview-regenerated'
  )),
  actor_id text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('human', 'agent')),
  suggestion_set_id text,
  preview_id text,
  stale_preview_id text,
  recorded_at timestamptz NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, sequence),
  CHECK ((record ->> 'id') IS NOT DISTINCT FROM id),
  CHECK ((record -> 'sequence') IS NOT DISTINCT FROM to_jsonb(sequence)),
  CHECK ((record ->> 'nodeId') IS NOT DISTINCT FROM node_id),
  CHECK ((record ->> 'stateId') IS NOT DISTINCT FROM state_id),
  CHECK ((record ->> 'kind') IS NOT DISTINCT FROM kind),
  CHECK ((record #>> '{actor,id}') IS NOT DISTINCT FROM actor_id),
  CHECK ((record #>> '{actor,kind}') IS NOT DISTINCT FROM actor_kind),
  CHECK ((record ->> 'suggestionSetId') IS NOT DISTINCT FROM suggestion_set_id),
  CHECK ((record ->> 'previewId') IS NOT DISTINCT FROM preview_id),
  CHECK ((record ->> 'stalePreviewId') IS NOT DISTINCT FROM stale_preview_id),
  CHECK ((kind = 'preview-regenerated') = (stale_preview_id IS NOT NULL)),
  CHECK (kind NOT IN ('preview-rejected', 'preview-regenerated') OR preview_id IS NOT NULL),
  FOREIGN KEY (session_id) REFERENCES proof_sessions (id) ON DELETE CASCADE,
  -- The anchor node and its snapshot. "Delete previous move" removes events anchored at deleted
  -- nodes (and those naming a deleted chosen preview) before it removes the nodes.
  FOREIGN KEY (session_id, node_id, state_id)
    REFERENCES proof_nodes (session_id, id, state_id)
);

-- Reads list a session's events, or one node's, in sequence order.
CREATE INDEX proof_interaction_events_node_sequence
  ON proof_interaction_events (session_id, node_id, sequence);

COMMIT;
