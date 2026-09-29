BEGIN;

-- Proof artifacts (design plan §19, roadmap N27). An uploaded artifact is fully revalidated and
-- then stored as an ordinary session whose rows (nodes, edges, events, commands, suggestion sets,
-- previews, replay steps, deletion tombstones, interaction events and inquiry records) keep their
-- original IDs under a new session ID. Such a session is read-only: the worker refuses every
-- write to it at the transaction layer (`guardReadOnlySessions`), with the diagnostic
-- `session-read-only`. The importer inserts the rows and sets `read_only` last, in the same
-- transaction, so no reader observes a writable imported session.
ALTER TABLE proof_sessions
  ADD COLUMN read_only boolean NOT NULL DEFAULT false;

-- One row per imported session: the uploaded artifact's digest and source session, and the
-- sections without proof-store rows (the library section and LLM call records), already rebased
-- onto the imported session. Re-exporting the session reads them back statically. The imported
-- session ID is derived from the digest, and the digest is unique, so importing the same artifact
-- twice finds the same session.
CREATE TABLE proof_artifact_imports (
  session_id text PRIMARY KEY,
  digest text NOT NULL UNIQUE CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  source_session_id text NOT NULL,
  imported_at timestamptz NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  CHECK ((record ->> 'sessionId') IS NOT DISTINCT FROM session_id),
  CHECK ((record ->> 'digest') IS NOT DISTINCT FROM digest),
  CHECK ((record ->> 'sourceSessionId') IS NOT DISTINCT FROM source_session_id),
  FOREIGN KEY (session_id) REFERENCES proof_sessions (id) ON DELETE CASCADE
);

COMMIT;
