# Product database migrations

`0001_proof_commands.sql` creates the initial PostgreSQL proof-session, immutable-node,
displayed-suggestion, concrete-preview, edge, event, and idempotent-command tables. Mathematical
state and documentary records are stored as JSONB.

Apply migrations with the deployment environment's normal PostgreSQL migration runner.
The worker does not connect to a database or run migrations automatically at startup.
The migrations are not exercised against a live PostgreSQL instance by the unit suite.

`0002_llm_call_evidence.sql` adds owner-scoped immutable LLM request/outcome records and explicit
topic-manifest review decisions. A `dispatching` record deliberately remains ambiguous after a
worker crash: retry reads it as uncertain and does not silently dispatch the provider again.

`0003_proof_event_provenance.sql` closes the nullable composite-foreign-key gap between proof
events and proof edges. It stores each row's suggestion, chosen-suggestion, and preview identity
as a generated `text[]`, then uses that non-null array in the edge key and event foreign key so
the no-evidence, suggestion-without-preview, and suggestion-with-preview shapes all compare
positionally without sentinel values. The migration validates existing rows and deliberately
fails instead of rewriting inconsistent provenance.

Migration `0003` requires PostgreSQL 12 or later because it uses stored generated columns. Adding
the stored columns computes and stores a value for every existing edge and event and can rewrite
both tables. The table alterations, unique-index construction, and foreign-key validation also
take locks that can block concurrent reads or writes. Plan enough time and disk space and run the
migration during a suitable low-traffic or maintenance window.

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
PROOF_DATABASE_URL=postgresql://... npx tsx \
  apps/worker/src/development-session/live-postgres-verification.ts
```

The executable creates the fixed development session only when absent, closes its first HTTP
service and pool, reopens fresh instances, verifies the same current node, records anchored
suggestions, and reads back the identical persisted order and reasons. It never resets an existing
session or runs migrations.
