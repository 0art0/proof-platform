# Product database migrations

`0001_proof_commands.sql` creates the initial PostgreSQL proof-session, immutable-node,
displayed-suggestion, concrete-preview, edge, event, and idempotent-command tables. Mathematical
state and documentary records are stored as JSONB; orchestration SQLite state is deliberately
unrelated.

Apply migrations with the deployment environment's normal PostgreSQL migration runner.
The worker does not connect to a database or run migrations automatically at startup.
The migration has not been exercised against a live PostgreSQL instance by the unit suite.

`0002_llm_call_evidence.sql` adds owner-scoped immutable LLM request/outcome records and explicit
topic-manifest review decisions. A `dispatching` record deliberately remains ambiguous after a
worker crash: retry reads it as uncertain and does not silently dispatch the provider again.

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
