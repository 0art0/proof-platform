BEGIN;

-- Semantic replay (design plan §16.4). Replaying a recorded step sequence onto another node
-- applies each re-matched step as an ordinary validated command (node, edge, event and command
-- rows). This table keeps, for every replayed step, the step's semantic plan in the replayed
-- branch's terms, so the step can itself be replayed later, together with its replay report and
-- the replay request that created it. The request makes the replay command idempotent.
--
-- A row belongs to its step's command and result node. "Delete previous move" removes the rows of
-- deleted commands before it removes the commands and nodes. The source edge is recorded by ID
-- only: the source branch may be deleted later without touching the replayed branch.
CREATE TABLE proof_replay_steps (
  session_id text NOT NULL,
  command_id text NOT NULL,
  replay_command_id text NOT NULL,
  step_index integer NOT NULL CHECK (step_index >= 1),
  step_count integer NOT NULL CHECK (step_count >= step_index),
  node_id text NOT NULL,
  source_edge_id text NOT NULL,
  recorded_at timestamptz NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (session_id, command_id),
  UNIQUE (session_id, replay_command_id, step_index),
  CHECK (command_id = replay_command_id || ':replay:' || step_index::text),
  CHECK ((record ->> 'commandId') IS NOT DISTINCT FROM command_id),
  CHECK ((record ->> 'replayCommandId') IS NOT DISTINCT FROM replay_command_id),
  CHECK ((record -> 'index') IS NOT DISTINCT FROM to_jsonb(step_index)),
  CHECK ((record -> 'count') IS NOT DISTINCT FROM to_jsonb(step_count)),
  CHECK ((record ->> 'nodeId') IS NOT DISTINCT FROM node_id),
  CHECK ((record ->> 'sourceEdgeId') IS NOT DISTINCT FROM source_edge_id),
  FOREIGN KEY (session_id) REFERENCES proof_sessions (id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, command_id) REFERENCES proof_commands (session_id, command_id),
  FOREIGN KEY (session_id, node_id) REFERENCES proof_nodes (session_id, id)
);

COMMIT;
