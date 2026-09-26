BEGIN;

ALTER TABLE proof_edges
  ADD COLUMN provenance_key text[]
  GENERATED ALWAYS AS (
    ARRAY[suggestion_set_id, chosen_suggestion_id, preview_id]
  ) STORED NOT NULL;

ALTER TABLE proof_events
  ADD COLUMN provenance_key text[]
  GENERATED ALWAYS AS (
    ARRAY[suggestion_set_id, chosen_suggestion_id, preview_id]
  ) STORED NOT NULL;

ALTER TABLE proof_edges
  ADD CONSTRAINT proof_edges_provenance_key_unique
  UNIQUE (session_id, id, provenance_key);

ALTER TABLE proof_events
  ADD CONSTRAINT proof_events_edge_provenance_key_fk
  FOREIGN KEY (session_id, edge_id, provenance_key)
  REFERENCES proof_edges (session_id, id, provenance_key);

COMMIT;
