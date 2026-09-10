BEGIN;

CREATE TABLE proof_sessions (
  id text PRIMARY KEY,
  root_node_id text NOT NULL,
  current_node_id text NOT NULL,
  operators jsonb NOT NULL CHECK (jsonb_typeof(operators) = 'array')
);

CREATE TABLE proof_nodes (
  session_id text NOT NULL,
  id text NOT NULL,
  state_id text NOT NULL,
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, state_id),
  UNIQUE (session_id, id, state_id),
  CHECK ((state ->> 'id') IS NOT DISTINCT FROM state_id),
  FOREIGN KEY (session_id) REFERENCES proof_sessions (id) ON DELETE CASCADE
);

CREATE TABLE proof_suggestion_sets (
  session_id text NOT NULL,
  id text NOT NULL,
  node_id text NOT NULL,
  state_id text NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, id, node_id),
  CHECK ((record ->> 'id') IS NOT DISTINCT FROM id),
  CHECK ((record ->> 'nodeId') IS NOT DISTINCT FROM node_id),
  CHECK ((record ->> 'stateId') IS NOT DISTINCT FROM state_id),
  FOREIGN KEY (session_id) REFERENCES proof_sessions (id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, node_id, state_id)
    REFERENCES proof_nodes (session_id, id, state_id)
);

CREATE TABLE proof_previews (
  session_id text NOT NULL,
  id text NOT NULL,
  node_id text NOT NULL,
  state_id text NOT NULL,
  suggestion_set_id text NOT NULL,
  chosen_suggestion_id text NOT NULL,
  move_id text NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, id, node_id, suggestion_set_id, chosen_suggestion_id),
  CHECK ((record ->> 'id') IS NOT DISTINCT FROM id),
  CHECK ((record ->> 'nodeId') IS NOT DISTINCT FROM node_id),
  CHECK ((record ->> 'stateId') IS NOT DISTINCT FROM state_id),
  CHECK ((record ->> 'suggestionSetId') IS NOT DISTINCT FROM suggestion_set_id),
  CHECK ((record ->> 'chosenSuggestionId') IS NOT DISTINCT FROM chosen_suggestion_id),
  CHECK ((record ->> 'moveId') IS NOT DISTINCT FROM move_id),
  FOREIGN KEY (session_id) REFERENCES proof_sessions (id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, node_id, state_id)
    REFERENCES proof_nodes (session_id, id, state_id),
  FOREIGN KEY (session_id, suggestion_set_id, node_id)
    REFERENCES proof_suggestion_sets (session_id, id, node_id)
);

CREATE TABLE proof_commands (
  session_id text NOT NULL,
  command_id text NOT NULL,
  command jsonb NOT NULL CHECK (jsonb_typeof(command) = 'object'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  PRIMARY KEY (session_id, command_id),
  CHECK ((command ->> 'commandId') IS NOT DISTINCT FROM command_id),
  CHECK ((result #>> '{prepared,command,commandId}') IS NOT DISTINCT FROM command_id),
  CHECK (command IS NOT DISTINCT FROM (result #> '{prepared,command}')),
  FOREIGN KEY (session_id) REFERENCES proof_sessions (id) ON DELETE CASCADE
);

CREATE TABLE proof_edges (
  session_id text NOT NULL,
  id text NOT NULL,
  parent_node_id text NOT NULL,
  child_node_id text NOT NULL,
  command_id text NOT NULL,
  suggestion_set_id text,
  chosen_suggestion_id text,
  preview_id text,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, child_node_id),
  UNIQUE (session_id, id, parent_node_id, child_node_id, command_id),
  UNIQUE (
    session_id, id, parent_node_id, child_node_id, command_id,
    suggestion_set_id, chosen_suggestion_id, preview_id
  ),
  CHECK (parent_node_id <> child_node_id),
  CHECK ((record ->> 'id') IS NOT DISTINCT FROM id),
  CHECK ((record ->> 'commandId') IS NOT DISTINCT FROM command_id),
  CHECK ((record ->> 'parentNodeId') IS NOT DISTINCT FROM parent_node_id),
  CHECK ((record ->> 'childNodeId') IS NOT DISTINCT FROM child_node_id),
  CHECK ((suggestion_set_id IS NULL) = (chosen_suggestion_id IS NULL)),
  CHECK (preview_id IS NULL OR suggestion_set_id IS NOT NULL),
  CHECK ((record ->> 'suggestionSetId') IS NOT DISTINCT FROM suggestion_set_id),
  CHECK ((record ->> 'chosenSuggestionId') IS NOT DISTINCT FROM chosen_suggestion_id),
  CHECK ((record ->> 'previewId') IS NOT DISTINCT FROM preview_id),
  FOREIGN KEY (session_id) REFERENCES proof_sessions (id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, parent_node_id)
    REFERENCES proof_nodes (session_id, id),
  FOREIGN KEY (session_id, child_node_id)
    REFERENCES proof_nodes (session_id, id),
  FOREIGN KEY (session_id, suggestion_set_id, parent_node_id)
    REFERENCES proof_suggestion_sets (session_id, id, node_id),
  FOREIGN KEY (
    session_id, preview_id, parent_node_id, suggestion_set_id, chosen_suggestion_id
  ) REFERENCES proof_previews (
    session_id, id, node_id, suggestion_set_id, chosen_suggestion_id
  ),
  FOREIGN KEY (session_id, command_id)
    REFERENCES proof_commands (session_id, command_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE proof_events (
  session_id text NOT NULL,
  id text NOT NULL,
  parent_node_id text NOT NULL,
  child_node_id text NOT NULL,
  edge_id text NOT NULL,
  command_id text NOT NULL,
  suggestion_set_id text,
  chosen_suggestion_id text,
  preview_id text,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (session_id, id),
  CHECK ((record ->> 'id') IS NOT DISTINCT FROM id),
  CHECK ((record ->> 'commandId') IS NOT DISTINCT FROM command_id),
  CHECK ((record ->> 'parentNodeId') IS NOT DISTINCT FROM parent_node_id),
  CHECK ((record ->> 'childNodeId') IS NOT DISTINCT FROM child_node_id),
  CHECK ((record ->> 'edgeId') IS NOT DISTINCT FROM edge_id),
  CHECK ((suggestion_set_id IS NULL) = (chosen_suggestion_id IS NULL)),
  CHECK (preview_id IS NULL OR suggestion_set_id IS NOT NULL),
  CHECK ((record ->> 'suggestionSetId') IS NOT DISTINCT FROM suggestion_set_id),
  CHECK ((record ->> 'chosenSuggestionId') IS NOT DISTINCT FROM chosen_suggestion_id),
  CHECK ((record ->> 'previewId') IS NOT DISTINCT FROM preview_id),
  FOREIGN KEY (session_id) REFERENCES proof_sessions (id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, parent_node_id)
    REFERENCES proof_nodes (session_id, id),
  FOREIGN KEY (session_id, child_node_id)
    REFERENCES proof_nodes (session_id, id),
  FOREIGN KEY (session_id, suggestion_set_id, parent_node_id)
    REFERENCES proof_suggestion_sets (session_id, id, node_id),
  FOREIGN KEY (
    session_id, preview_id, parent_node_id, suggestion_set_id, chosen_suggestion_id
  ) REFERENCES proof_previews (
    session_id, id, node_id, suggestion_set_id, chosen_suggestion_id
  ),
  FOREIGN KEY (session_id, edge_id, parent_node_id, child_node_id, command_id)
    REFERENCES proof_edges (session_id, id, parent_node_id, child_node_id, command_id),
  FOREIGN KEY (
    session_id, edge_id, parent_node_id, child_node_id, command_id,
    suggestion_set_id, chosen_suggestion_id, preview_id
  ) REFERENCES proof_edges (
    session_id, id, parent_node_id, child_node_id, command_id,
    suggestion_set_id, chosen_suggestion_id, preview_id
  ),
  FOREIGN KEY (session_id, command_id)
    REFERENCES proof_commands (session_id, command_id)
    DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE proof_sessions
  ADD CONSTRAINT proof_sessions_root_node_fk
  FOREIGN KEY (id, root_node_id)
  REFERENCES proof_nodes (session_id, id)
  DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT proof_sessions_current_node_fk
  FOREIGN KEY (id, current_node_id)
  REFERENCES proof_nodes (session_id, id)
  DEFERRABLE INITIALLY DEFERRED;

COMMIT;
