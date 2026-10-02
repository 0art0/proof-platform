# Product database migrations

`0001_proof_commands.sql` creates the initial PostgreSQL proof-session, immutable-node,
displayed-suggestion, concrete-preview, edge, event, and idempotent-command tables. Mathematical
state and documentary records are stored as JSONB.

Apply migrations with the runner: `PROOF_DATABASE_URL=postgresql://... npm run migrate`. It is
idempotent and records each applied file by name and sha256 checksum in `schema_migrations`.

- Each file runs in its own transaction together with its `schema_migrations` row (the runner
  strips the file's own `BEGIN;`/`COMMIT;` envelope), so a failing file is rolled back completely
  and earlier files stay applied. Re-running applies only files that are not yet recorded.
- An applied file whose checksum changed, or an applied name whose file is missing, aborts the run
  before anything else changes. Applied migrations are immutable; add a new numbered file.
- A session-level advisory lock serializes concurrent runners.
- `npm run migrate -- --status` lists pending migrations and changes nothing.
- A database whose schema was applied by hand before the runner existed is adopted once with
  `npm run migrate -- --baseline 0011_artifact_imports.sql` (records every file up to that name as
  applied without running it), then `npm run migrate` applies the rest.
- At startup with PostgreSQL the worker only verifies that every migration is applied and
  unchanged and refuses to start otherwise (schema changes need DDL rights and a deliberate step,
  and several workers must not race to alter it). `PROOF_AUTO_MIGRATE=true` applies pending
  migrations first, for single-instance deployments. The memory store needs neither.

The runner is tested against a fake connection; the unit suite does not use a live PostgreSQL
instance. `schema-coverage.test.ts` checks the stores' SQL against the tables and columns the
migrations create and that every memory-store entity has a migrated table.

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

`0011_artifact_imports.sql` supports proof artifacts (design plan §19). An uploaded artifact is
revalidated in full and stored as an ordinary session that keeps the artifact's record IDs under
a new session ID derived from the artifact digest.

- `proof_sessions.read_only` marks an imported session. The worker refuses every write to such a
  session at the transaction layer (`guardReadOnlySessions`, diagnostic `session-read-only`,
  HTTP 409). The importer sets the flag as its last write in the import transaction.
- `proof_artifact_imports` holds one record per imported session: the digest (unique), the source
  session, and the library section and LLM call records rebased onto the imported session, which
  have no proof-store rows and are re-exported statically. `MemoryProofStore` mirrors both.
- The flag is enforced by the worker, not by a database trigger; a direct SQL writer can still
  modify an imported session.

`0012_session_visibility.sql` adds `proof_sessions.visibility` (`private` default, or `shared`), the
privacy marker of design plan §19.3. Every session, including those that existed before the
migration, is private until explicitly shared. There is no authentication system yet, so this is
not access control; the worker enforces only what it can without identity:

- new sessions (approved problem setups, the development seed, artifact imports) are private;
- the worker has no route that lists sessions, so private sessions cannot be enumerated;
- `GET /proof-sessions/:id/export` of a private session needs `?confirmPrivateExport=true` and
  otherwise answers 403 `private-export-unconfirmed`; a shared session exports directly;
- `PATCH /proof-sessions/:id/visibility` changes it, and it may be changed on a read-only session
  (it is not a proof write).

`DELETE /proof-sessions/:id` hard-deletes a session in one transaction: nodes, suggestion sets,
previews, edges, events, commands, deletion tombstones, interaction events, inquiry records, replay
steps, the artifact-import record, the session-scoped library additions, artifacts and revisions,
and the proof-session-owned LLM call records. The adapter deletes in foreign-key order instead of
relying on `ON DELETE CASCADE` (the dependent tables reference each other without cascades), and
`schema-coverage.test.ts` fails when a table with a `session_id` column is missing from that list
or ordered before a table that references it. Deletion is allowed on an imported read-only session.
Exports are not stored on the server: the artifact is built on demand from stored rows, so
"deleting an export" means deleting the session, or the imported session with its
`proof_artifact_imports` record; a downloaded file is outside the worker's reach. The global
library layer and operator registry are not session data and are kept.

`0013_transition_evidence.sql` stores the kernel's transition evidence and a per-session transition
sequence (roadmap N40). `proof_edges` and `proof_events` gain `evidence` (`structural`,
`background-inference`, `library-result` or `sorry`) and `transition_sequence`; both also stay in the
JSONB record, and CHECKs keep the columns identical to it. Previews and command results carry the
same evidence in their JSONB records only.

- The worker assigns `transition_sequence` in the storing transaction, under the session row lock,
  as one more than the session's highest retained sequence (`UNIQUE (session_id,
transition_sequence)`). Replayed (idempotent) commands keep the recorded value. "Delete previous
  move" removes rows, so a later transition may reuse the numbers of deleted ones; the retained
  rows stay strictly ordered, and a transition is always sequenced after the one that produced its
  parent.
- A row has both columns or neither. Rows written before this migration have neither: the migration
  adds columns only and never infers or rewrites history. A session with such rows exports as a
  version-1 artifact (no stored evidence or sequence; viewers derive what they show), and a session
  imported from a version-1 artifact keeps the artifact's records exactly as uploaded. Version 2
  artifacts require every transition, command record and preview to store its evidence and every
  transition its sequence, and the importer rechecks the evidence against the kernel and the
  sequences against the tree.
- An event's `(edge_id, evidence, transition_sequence)` must equal its edge's
  (`proof_events_edge_evidence_key_fk`). `MemoryProofStore` mirrors the checks and uniqueness.

Migration `0003` already carries the generated `provenance_key` columns and the event-to-edge
foreign key, and `PostgresProofStore.transaction` already discards a connection with
`release(true)` after a failed rollback or commit, so no migration was added for either.

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
- `GET /proof-sessions/:sessionId/export` returns the session's versioned proof artifact, built
  from stored rows only, as an attachment. A private session (the default)
  needs `?confirmPrivateExport=true`.
- `DELETE /proof-sessions/:sessionId` hard-deletes the session and its rows (204, or 404 when absent).
- `GET`/`PATCH /proof-sessions/:sessionId/visibility` read and set `{ visibility }`.
- `POST /artifacts` with an artifact body (at most 16 MiB) revalidates it completely and creates a
  read-only session: `{ sessionId, digest, sourceSessionId, readOnly, replayed }` (201, or 200 for
  an identical re-upload). A failed check returns 422 with its diagnostics and records nothing.
  Every write to a read-only session returns 409 `session-read-only`.
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
