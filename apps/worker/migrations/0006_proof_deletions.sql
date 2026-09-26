BEGIN;

-- Audit tombstones for "Delete previous move" (design plan §16.2). A deletion physically removes
-- the deleted nodes, edges, events, command records, and node-anchored suggestion sets and
-- previews; this row records only that it happened, by whom, and which IDs were removed. It never
-- holds the deleted snapshots. There is deliberately no foreign key to proof_nodes: the parent node
-- may itself be deleted by a later deletion.
CREATE TABLE proof_deletions (
  session_id text NOT NULL,
  id text NOT NULL,
  command_id text NOT NULL,
  actor_id text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('human', 'agent')),
  reason text,
  parent_node_id text NOT NULL,
  deleted_node_ids text[] NOT NULL CHECK (cardinality(deleted_node_ids) >= 1),
  deleted_edge_ids text[] NOT NULL
    CHECK (cardinality(deleted_edge_ids) = cardinality(deleted_node_ids)),
  deleted_command_ids text[] NOT NULL
    CHECK (cardinality(deleted_command_ids) = cardinality(deleted_node_ids)),
  occurred_at timestamptz NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, command_id),
  CHECK (NOT (parent_node_id = ANY (deleted_node_ids))),
  CHECK (NOT (command_id = ANY (deleted_command_ids))),
  CHECK ((record ->> 'id') IS NOT DISTINCT FROM id),
  CHECK ((record ->> 'commandId') IS NOT DISTINCT FROM command_id),
  CHECK ((record #>> '{actor,id}') IS NOT DISTINCT FROM actor_id),
  CHECK ((record #>> '{actor,kind}') IS NOT DISTINCT FROM actor_kind),
  CHECK ((record ->> 'reason') IS NOT DISTINCT FROM reason),
  CHECK ((record ->> 'parentNodeId') IS NOT DISTINCT FROM parent_node_id),
  CHECK ((record -> 'deletedNodeIds') IS NOT DISTINCT FROM to_jsonb(deleted_node_ids)),
  CHECK ((record -> 'deletedEdgeIds') IS NOT DISTINCT FROM to_jsonb(deleted_edge_ids)),
  CHECK ((record -> 'deletedCommandIds') IS NOT DISTINCT FROM to_jsonb(deleted_command_ids)),
  CHECK (NOT (record ?| ARRAY['state', 'node', 'nodes', 'edge', 'edges', 'event', 'events'])),
  FOREIGN KEY (session_id) REFERENCES proof_sessions (id) ON DELETE CASCADE
);

-- Retried apply commands look up whether their command ID was deleted.
CREATE INDEX proof_deletions_deleted_command_ids
  ON proof_deletions USING gin (deleted_command_ids);

COMMIT;
