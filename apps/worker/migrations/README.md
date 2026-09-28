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

`0004_session_metadata.sql` adds a nullable `proof_sessions.metadata` JSONB object holding the
protocol `ProofSessionMetadata` (problem title and statement, background profile, preferences and
active library layer IDs). Existing sessions keep `NULL` and load without metadata. The column is
written only when a session is initialized and is never part of proof state.

`0005_library.sql` adds the library store (design plan §12.4):

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

`0006_proof_deletions.sql` adds `proof_deletions`, the audit tombstones of "Delete previous move"
(design plan §16.2). A deletion physically removes, in foreign-key order, the transition events and
edges of the deleted subtree, previews anchored at deleted nodes or chosen by deleted edges (unless a
retained edge still references one), suggestion sets anchored at deleted nodes, the deleted command
records, and the deleted nodes. The session cursor moves to the parent in the same transaction.
Deleted work is therefore absent from history and export.

- Each tombstone holds only identities: the issuing command ID, actor, optional reason, parent node,
  and the deleted node, edge, event, command, suggestion-set and preview IDs. It never stores
  snapshots, operations, or suggestions; a check rejects records carrying such keys.
- `UNIQUE (session_id, command_id)` makes the delete command idempotent. Delete command IDs share
  the session's command-ID space with apply commands, but are kept out of `proof_commands`, whose
  checks describe apply results.
- A GIN index on `deleted_command_ids` lets a retried apply command discover that its move was
  deleted; the repository rejects it (`command-deleted`) instead of re-applying it.

`MemoryProofStore` mirrors the table and checks each immediate foreign key as rows are deleted, and
the deferred command and session-pointer keys at commit.

`0007_interaction_events.sql` adds `proof_interaction_events`, the ordered, node-anchored
interaction log of refinement §12.1: selection changes, suggestion requests and displays, preview
requests and rejections, menu expansions, focus and objective changes, interactions that ended
without an action, and worker-recorded preview regenerations (§12.2). None of them changes proof
state.

- The client supplies the event ID, so a retry replays the stored event (`PRIMARY KEY
(session_id, id)`); different content under that ID is rejected. The worker assigns `sequence`
  as the session's highest sequence plus one while it holds the session row lock, and
  `UNIQUE (session_id, sequence)` backs that ordering.
- Each event references its anchor node and snapshot `(session_id, node_id, state_id)`. Suggestion
  sets and previews are referenced only by ID columns: a `suggestions-requested` event precedes its
  set. The repository checks every reference against the anchor node before inserting.
- "Delete previous move" removes events anchored at deleted nodes, and events naming a deleted
  chosen preview, before it removes the nodes.

Move previews also record `definitions`: `sha256` hashes of the canonical JSON of the move and
library definitions they were built from. When a command's preview was built from definitions
that have since changed, the worker records a regenerated preview (ID
`<preview>:regenerated:<digest>`) and a `preview-regenerated` event in one transaction and answers
409 instead of applying; repeating the command applies the regenerated preview. A preview already
applied by an edge is never regenerated.

`0008_backtrack_interaction_event.sql` widens the interaction-event `kind` check with the
worker-only `backtracked-with-information` kind (design plan §16.3). Backtracking with information
inserts a classical case split on a proposition `P` as a new child of an ancestor (and, when the
ancestor's goal is `P` or `Not P`, the closing step), each as an ordinary command record, moves the
cursor there, and records one such event anchored at that node. The event holds the source node and
target, `P`, the eligible ancestors (closest first), the chosen ancestor, the auto-closed case and
the focused case; it also makes the command idempotent. `MemoryProofStore` mirrors the check.

`0009_inquiry_records.sql` adds `proof_inquiry_records`, the inquiry records of refinement §3–§4:
questions (`establish`, `construct`, `determine`, `explore`), objectives, attempts, requirements,
observations, obstructions, decisions, relationships (`wouldSufficeFor`, `requires`,
`motivatedBy`, `addresses`, `specializes`, `generalizes`, `tests`, `reuses`) and explicit status
changes. None of them changes proof state.

- One inquiry command records one or more records atomically at an anchor node. The worker assigns
  each record the session's next `sequence` under the session row lock (`UNIQUE (session_id,
sequence)`). Retrying a command ID with identical records replays them; different content, or a
  record ID already used by another command, is rejected.
- Records reference proof nodes, targets, statements, subexpressions, construction tasks,
  suggestion sets, transitions and earlier records by identity; the repository validates every
  reference with the protocol `prepareInquiryCommand` before inserting. `referenced_node_ids`
  (which includes the anchor) and `referenced_record_ids` record those references relationally.
- Records are never updated. "Delete previous move" removes records that reference a deleted node,
  then, recursively, every record that references a removed record, before it removes the nodes.
  `MemoryProofStore` mirrors the table, its checks and this deletion.

`0010_semantic_replay_steps.sql` adds `proof_replay_steps` for semantic replay (design plan
§16.4). A replay re-matches the semantic plans of the steps on a source path onto a target node and
applies each as an ordinary validated command (node, edge, event and command rows, with the step's
move but no displayed suggestion). One row per replayed step holds the step's plan in the replayed
branch's terms, so the step can itself be replayed, its report, and the replay request.

- `PRIMARY KEY (session_id, command_id)` keys a row by the step's command
  (`<replay command>:replay:<index>`), which references `proof_commands` and the step's result node.
  The first step's row makes the replay command idempotent.
- The source edge is recorded by ID only. "Delete previous move" removes the rows of deleted
  commands and nodes before it removes them. `MemoryProofStore` mirrors the table and its checks.

## Proof HTTP service and live verification

`createPostgresProofHttpService(pool)` creates the product `node:http` service without applying
migrations. Its PostgreSQL-backed endpoints are:

- `GET /proof-sessions/:sessionId` for the runtime-validated session and current proof node.
- `POST /proof-sessions/:sessionId/suggestion-sets` to record deterministic retrieval evidence.
- `POST /proof-sessions/:sessionId/backtrack-analysis` with
  `{ sourceNodeId, sourceTarget?, proposition }` lists the source's ancestors closest first with
  each one's eligibility; nothing is recorded.
- `POST /proof-sessions/:sessionId/backtrack-with-information` with
  `{ commandId, expectedCurrentNodeId, sourceNodeId, sourceTarget?, proposition, ancestorNodeId? }`
  returns `{ session, node, receipts, backtrack, replayed }` (201, or 200 for a retry). A conflicting
  reuse of the command ID or a stale cursor returns 409; unavailable symbols return 422.
- `POST /proof-sessions/:sessionId/replay-preview` with
  `{ source: { fromNodeId, toNodeId }, targetNodeId?, focus?, overrides?, commandId? }` returns
  `{ report, finalNode }`: a dry run that records nothing. Pass the commit's `commandId` so the
  candidate IDs of later steps match the commit.
- `POST /proof-sessions/:sessionId/replay` with the same fields plus `commandId` and
  `expectedCurrentNodeId` returns `{ session, node, receipts, report, replayed }` (201, or 200 for a
  retry). A step that fails to re-match returns 422 with the report and records nothing; a
  conflicting reuse of the command ID or a stale cursor returns 409.
- `POST /proof-sessions/:sessionId/delete-previous-move` with
  `{ commandId, expectedCurrentNodeId, confirmDescendants?, reason? }`. It returns the session,
  the parent node and `{ deletedNodeIds, deletedEdgeIds, currentNodeId }`. A stale cursor, deleting
  unconfirmed descendants, or replaying a deleted command returns 409. Deleting at the root returns 400.
- `GET /proof-sessions/:sessionId/suggestion-sets/:suggestionSetId` for immutable persisted
  evidence, validated against its historical proof node.
- `POST /proof-sessions/:sessionId/interaction-events` with a strict protocol
  `recordInteractionEventRequestSchema` body (`{ id, nodeId, kind, ...payload }`). It returns
  `{ event, replayed }` (201, or 200 for an identical retry); a conflicting reuse of the ID returns 409.
- `GET /proof-sessions/:sessionId/interaction-events?nodeId=&after=&limit=` lists events in
  sequence order.
- `POST /proof-sessions/:sessionId/inquiry-commands` with a strict protocol
  `recordInquiryCommandRequestSchema` body (`{ commandId, nodeId, records }`). It returns
  `{ records, replayed }` (201, or 200 for an identical retry). Invalid references or unsupported
  claims return 400; a conflicting reuse of the command or a record ID returns 409.
- `GET /proof-sessions/:sessionId/inquiry-records?nodeId=&commandId=&after=&limit=` lists inquiry
  records in sequence order.

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
