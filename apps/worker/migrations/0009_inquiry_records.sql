BEGIN;

-- Inquiry records (refinement §3–§4, §6): questions, objectives, attempts, requirements,
-- observations, obstructions, decisions, relationships between them, and explicit status changes.
-- None of them changes proof state. An inquiry command records one or more records atomically at
-- an anchor node; the worker assigns each record the session's next `sequence` under the session
-- row lock. Records are static history: they are never updated, and a later change is a new
-- relationship or status-change record.
CREATE TABLE proof_inquiry_records (
  session_id text NOT NULL,
  id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  command_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'question',
    'objective',
    'attempt',
    'requirement',
    'observation',
    'obstruction',
    'decision',
    'relationship',
    'status-change'
  )),
  node_id text NOT NULL,
  state_id text NOT NULL,
  actor_id text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('human', 'agent')),
  recorded_at timestamptz NOT NULL,
  -- Every proof node the record references, including its anchor, and every inquiry record it
  -- references. The repository validates each reference before inserting; "Delete previous move"
  -- uses these columns to remove records that would otherwise dangle.
  referenced_node_ids text[] NOT NULL,
  referenced_record_ids text[] NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, sequence),
  CHECK (node_id = ANY (referenced_node_ids)),
  CHECK (NOT (id = ANY (referenced_record_ids))),
  CHECK ((record ->> 'id') IS NOT DISTINCT FROM id),
  CHECK ((record -> 'sequence') IS NOT DISTINCT FROM to_jsonb(sequence)),
  CHECK ((record ->> 'commandId') IS NOT DISTINCT FROM command_id),
  CHECK ((record ->> 'kind') IS NOT DISTINCT FROM kind),
  CHECK ((record ->> 'nodeId') IS NOT DISTINCT FROM node_id),
  CHECK ((record ->> 'stateId') IS NOT DISTINCT FROM state_id),
  CHECK ((record #>> '{actor,id}') IS NOT DISTINCT FROM actor_id),
  CHECK ((record #>> '{actor,kind}') IS NOT DISTINCT FROM actor_kind),
  FOREIGN KEY (session_id) REFERENCES proof_sessions (id) ON DELETE CASCADE,
  -- The anchor node and its snapshot.
  FOREIGN KEY (session_id, node_id, state_id)
    REFERENCES proof_nodes (session_id, id, state_id)
);

-- Replaying a command reads its records in order.
CREATE INDEX proof_inquiry_records_command
  ON proof_inquiry_records (session_id, command_id, sequence);

-- Reads list a session's records, or one anchor node's, in sequence order.
CREATE INDEX proof_inquiry_records_node_sequence
  ON proof_inquiry_records (session_id, node_id, sequence);

-- Status folding and deletion look records up by what they reference.
CREATE INDEX proof_inquiry_records_referenced_records
  ON proof_inquiry_records USING gin (referenced_record_ids);
CREATE INDEX proof_inquiry_records_referenced_nodes
  ON proof_inquiry_records USING gin (referenced_node_ids);

COMMIT;
