# Product database migrations

`0001_proof_commands.sql` creates the initial PostgreSQL proof-session, immutable-node,
displayed-suggestion, concrete-preview, edge, event, and idempotent-command tables. Mathematical
state and documentary records are stored as JSONB.

Apply migrations with the deployment environment's normal PostgreSQL migration runner.
The worker does not connect to a database or run migrations automatically at startup.
The migration has not been exercised against a live PostgreSQL instance by the unit suite.

`0002_llm_call_evidence.sql` adds owner-scoped immutable LLM request/outcome records and explicit
topic-manifest review decisions. A `dispatching` record deliberately remains ambiguous after a
worker crash: retry reads it as uncertain and does not silently dispatch the provider again.

`0003_session_metadata.sql` adds a nullable `proof_sessions.metadata` JSONB object holding the
protocol `ProofSessionMetadata` (problem title and statement, background profile, preferences and
active library layer IDs). Existing sessions keep `NULL` and load without metadata. The column is
written only when a session is initialized and is never part of proof state.

`0004_library.sql` adds the library store (design plan §12.4):

- `library_addition_events`: append-only addition events keyed by `(scope_key, id)`, where
  `scope_key` is `global` or `session:<id>`. Every gate decision is recorded, including rejections.
  Only `global`-layer events are outside a session.
- `library_artifacts`: admitted artifacts keyed by `(scope_key, id)`. Each row references its
  admitting event by artifact ID, layer, sequence, and an `admitted` decision.
- `library_background_revisions`: append-only session background revisions. Recording one also
  rewrites `proof_sessions.metadata.background` in the same transaction.
- `library_operators`: the global registry of approved operator declarations, with a unique symbol.

Sequences are allocated per scope under the session row lock (or a global advisory lock). Stored
suggestion sets are never touched, so earlier menus stay exactly as displayed. `MemoryLibraryStore`
mirrors these constraints for database-free runs.

## Proof HTTP service and live verification

`createPostgresProofHttpService(pool)` creates the product `node:http` service without applying
migrations. Its PostgreSQL-backed endpoints are:

- `GET /proof-sessions/:sessionId` for the runtime-validated session and current proof node.
- `POST /proof-sessions/:sessionId/suggestion-sets` to record deterministic retrieval evidence.
- `GET /proof-sessions/:sessionId/suggestion-sets/:suggestionSetId` for immutable persisted
  evidence, validated against its historical proof node.

The POST body is `{ "id": "...", "selections": [...] }`. Each selection must be only a strict
snapshot-anchored exact occurrence or supported associative range. Resolved fragments, contexts,
polarity, selection-query wrappers, retrieval options, and catalogs are rejected; the service
constructs the approved core-result and hand-authored-move index itself.

After applying migrations with the deployment migration runner, exercise a real database restart
and persistence boundary with:

```bash
PROOF_DATABASE_URL=postgresql://... ./scripts/pnpmw exec tsx \
  apps/worker/src/development-session/live-postgres-verification.ts
```

The executable creates the fixed development session only when absent, closes its first HTTP
service and pool, reopens fresh instances, verifies the same current node, records anchored
suggestions, and reads back the identical persisted order and reasons. It never resets an existing
session or runs migrations.
