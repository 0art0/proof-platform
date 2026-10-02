BEGIN;

-- Stored transition evidence and sequence (roadmap N40; design plan §9-§11). At apply time the
-- kernel's evidence for a transition (structural, background-inference, library-result or sorry)
-- and a per-session transition sequence are stored on the edge and on its transition event, so
-- history is never re-derived and playback is chronological. Both also stay in the JSONB `record`
-- (the CHECKs keep the columns and the record identical). Previews and command results carry the
-- same evidence inside their JSONB records only.
--
-- Rows written before this migration have neither: both columns stay NULL for them and their
-- records carry no `evidence` or `sequence`. A row has both or neither. The migration neither
-- infers nor rewrites history, so it is safe to apply to existing databases; such rows are
-- exported as version-1 artifacts and the web derives what it displays for them.
--
-- `transition_sequence` is assigned in the storing transaction under the session row lock as one
-- more than the session's highest retained sequence. "Delete previous move" removes rows, so a
-- later transition may reuse the numbers of deleted ones; retained rows stay strictly ordered.
ALTER TABLE proof_edges
  ADD COLUMN evidence text
    CHECK (evidence IN ('structural', 'background-inference', 'library-result', 'sorry')),
  ADD COLUMN transition_sequence integer
    CHECK (transition_sequence >= 1),
  ADD CONSTRAINT proof_edges_evidence_sequence_together
    CHECK ((evidence IS NULL) = (transition_sequence IS NULL)),
  ADD CONSTRAINT proof_edges_evidence_record_check
    CHECK ((record ->> 'evidence') IS NOT DISTINCT FROM evidence),
  ADD CONSTRAINT proof_edges_sequence_record_check
    CHECK ((record -> 'sequence') IS NOT DISTINCT FROM to_jsonb(transition_sequence)),
  ADD CONSTRAINT proof_edges_transition_sequence_unique
    UNIQUE (session_id, transition_sequence),
  ADD CONSTRAINT proof_edges_evidence_key_unique
    UNIQUE (session_id, id, evidence, transition_sequence);

ALTER TABLE proof_events
  ADD COLUMN evidence text
    CHECK (evidence IN ('structural', 'background-inference', 'library-result', 'sorry')),
  ADD COLUMN transition_sequence integer
    CHECK (transition_sequence >= 1),
  ADD CONSTRAINT proof_events_evidence_sequence_together
    CHECK ((evidence IS NULL) = (transition_sequence IS NULL)),
  ADD CONSTRAINT proof_events_evidence_record_check
    CHECK ((record ->> 'evidence') IS NOT DISTINCT FROM evidence),
  ADD CONSTRAINT proof_events_sequence_record_check
    CHECK ((record -> 'sequence') IS NOT DISTINCT FROM to_jsonb(transition_sequence)),
  ADD CONSTRAINT proof_events_transition_sequence_unique
    UNIQUE (session_id, transition_sequence),
  ADD CONSTRAINT proof_events_edge_evidence_key_fk
    FOREIGN KEY (session_id, edge_id, evidence, transition_sequence)
    REFERENCES proof_edges (session_id, id, evidence, transition_sequence);

COMMIT;
