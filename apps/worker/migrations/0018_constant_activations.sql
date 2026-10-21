BEGIN;

-- Constant activations (docs/ai-agents-architecture.md section 2). A session's setup operators are
-- its `proof_sessions.operators`. A library result may need further operator declarations
-- ("library constants"), which the session holds as available until a committed step applies that
-- result. The step's own transaction then appends one row here per newly activated constant,
-- before it stores the step, so the session's effective operators are its setup operators followed
-- by these declarations in `sequence` order.
--
-- Rows are append-only history, like library additions (design plan 12.4): backtracking and
-- "Delete previous move" never remove one, so the effective operators only grow. For that reason
-- the step is recorded by ID only, with no foreign key to the command, edge or node, which a
-- deletion may remove. The declaration is stored in full: the session's operators are readable
-- from this table without the library.
CREATE TABLE proof_constant_activations (
  session_id text NOT NULL,
  symbol text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  command_id text NOT NULL,
  edge_id text NOT NULL,
  node_id text NOT NULL,
  result_id text NOT NULL,
  transition_sequence integer NOT NULL CHECK (transition_sequence >= 1),
  activated_at timestamptz NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (session_id, symbol),
  UNIQUE (session_id, sequence),
  CHECK ((record ->> 'symbol') IS NOT DISTINCT FROM symbol),
  CHECK ((record #>> '{declaration,symbol}') IS NOT DISTINCT FROM symbol),
  CHECK ((record -> 'sequence') IS NOT DISTINCT FROM to_jsonb(sequence)),
  CHECK ((record ->> 'commandId') IS NOT DISTINCT FROM command_id),
  CHECK ((record ->> 'edgeId') IS NOT DISTINCT FROM edge_id),
  CHECK ((record ->> 'nodeId') IS NOT DISTINCT FROM node_id),
  CHECK ((record ->> 'resultId') IS NOT DISTINCT FROM result_id),
  CHECK ((record -> 'transitionSequence') IS NOT DISTINCT FROM to_jsonb(transition_sequence)),
  FOREIGN KEY (session_id) REFERENCES proof_sessions (id) ON DELETE CASCADE
);

-- A session's activations are read in order.
CREATE INDEX proof_constant_activations_sequence
  ON proof_constant_activations (session_id, sequence);

COMMIT;
