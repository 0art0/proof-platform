# AI endpoints

The worker exposes seven single-call AI roles: the background proposer, the librarian (the initial
library and top-ups during a proof), the topic extractor, the proof-state formalizer, the move shortlister, the move
executor and the move author. All use the Vercel AI Gateway and persist a validated call record before returning a
proposal. AI responses never execute proof commands or change a proof session directly; the move
executor's plan is committed only by a separate apply request that the user makes after reading a
kernel preview, and the move author's proposal of a reusable move becomes a draft only when the user
submits it through the ordinary command and is added only when a person approves it. The other
roles of design plan §15.2 (attestor, background gatekeeper, generality
reviewer, stateful proof agent) are not implemented. The agent architecture is specified in
`docs/ai-agents-architecture.md`.

The background proposer supersedes the topic extractor in the new-problem page: the web
application no longer calls the topic routes. The worker keeps the `topic-extractor` role and its
routes, so stored topic evidence still reads.

## Configuration

Set `AI_GATEWAY_API_KEY` or the existing `AI_API_KEY` variable. The worker does not load dotenv
files itself. For local development with Node 24 and the repository's `tsx` dependency:

```sh
PROOF_STORE=memory node --env-file=.env.local --import tsx apps/worker/src/main.ts
```

For an existing PostgreSQL database, apply migrations `0013_llm_formalizer_role.sql`,
`0015_llm_background_proposer_role.sql`, `0016_llm_librarian_role.sql` and
`0017_llm_move_executor_role.sql` and `0019_llm_move_author_role.sql` before starting the updated
worker (each widens the `llm_calls`
role constraint; background and library decisions reuse the `llm_topic_decisions` table). A
single-instance deployment can use `PROOF_AUTO_MIGRATE=true`; the normal migration runner is
`npm run migrate`.

Defaults are `openai/gpt-6-luna` with high reasoning effort and a 32,000 token output limit for the
formalizer and for the librarian, the same model with high reasoning effort and a 16,000 token
output limit for the move executor, the same model with high reasoning effort and a 32,000 token
output limit for the move author, the same model with medium reasoning effort and an 8,000 token
output limit for the background proposer and for topic extraction, and `typesafe-ai/jev` for
shortlisting. Configuration can be overridden with `PROOF_AI_FORMALIZER_MODEL`,
`PROOF_AI_FORMALIZER_REASONING_EFFORT`, `PROOF_AI_FORMALIZER_MAX_OUTPUT_TOKENS`,
`PROOF_AI_EXECUTOR_MODEL`, `PROOF_AI_EXECUTOR_REASONING_EFFORT`,
`PROOF_AI_EXECUTOR_MAX_OUTPUT_TOKENS`, `PROOF_AI_MOVE_AUTHOR_MODEL`,
`PROOF_AI_MOVE_AUTHOR_REASONING_EFFORT`, `PROOF_AI_MOVE_AUTHOR_MAX_OUTPUT_TOKENS`,
`PROOF_AI_SHORTLISTER_MODEL`,
`PROOF_AI_SHORTLISTER_MIN_CONFIDENCE`, `PROOF_AI_BACKGROUND_MODEL`,
`PROOF_AI_BACKGROUND_REASONING_EFFORT`, `PROOF_AI_BACKGROUND_MAX_OUTPUT_TOKENS`,
`PROOF_AI_LIBRARIAN_MODEL`, `PROOF_AI_LIBRARIAN_REASONING_EFFORT`,
`PROOF_AI_LIBRARIAN_MAX_OUTPUT_TOKENS`, `PROOF_AI_TOPIC_MODEL`, `PROOF_AI_TOPIC_REASONING_EFFORT`,
`PROOF_AI_TOPIC_MAX_OUTPUT_TOKENS`, `PROOF_AI_TIMEOUT_MS`, and `PROOF_AI_FORMALIZER_TIMEOUT_MS`
(the formalizer's total budget; defaults to `PROOF_AI_TIMEOUT_MS`, itself 120000 ms; raise it for
long high-effort generations; the executor shares `PROOF_AI_TIMEOUT_MS`). The confidence threshold
defaults
to `0.55`; Jev's native confidence and candidate probabilities are included in the stored structured
evidence. Missing credentials disable these routes. No model fallback is silently selected.

## Cost guard and status codes

The background, library, library top-up, topic, formalizer, shortlist, move-executor preview and
move-author routes can
trigger paid provider calls, so they share an in-process limiter: a global cap on
concurrent provider calls (`PROOF_AI_MAX_CONCURRENT`, default 4) and a token bucket
(`PROOF_AI_RATE_PER_MINUTE`, default 20; it is also the burst size). A request over budget gets
`429` with a `Retry-After` header (seconds) and a stable diagnostic code: `ai-rate-limited` or
`ai-concurrency-limited`. A shortlist `429` still carries the deterministic `fallbackCandidateIds`.
Budget is spent only when a provider call is really dispatched: invalid requests, stale or read-only
sessions, a single candidate, a disabled runtime, and replays of a stored call cost nothing. The
limits are per worker process and are a cost guard, not authentication: anyone who can reach the
worker is still trusted.

| Status | Meaning on the AI routes                                                         |
| ------ | -------------------------------------------------------------------------------- |
| 400    | invalid JSON or request, unknown pack, candidate not in the displayed set        |
| 404    | a revision, decision or approved background names a call or decision that does   |
|        | not exist for that construction                                                  |
| 409    | stale session or suggestion set; decision ID reused or not reviewable; revision  |
|        | of a call that is not a validated background proposal; approved constant clash   |
|        | with the operator registry; approved background decision that was rejected; a    |
|        | move-executor plan that is stale, read-only, or not an applicable plan; a        |
|        | move-author request for an executor call that is missing, not applied or not a   |
|        | user instruction; a draft whose proposal link names calls the session lacks      |
| 413    | request body over 256 KiB                                                        |
| 415    | `Content-Type` is not `application/json`                                         |
| 422    | the model output was rejected or the draft failed admission; nothing was created |
|        | (applying a plan: the kernel rejected a step, `plan-step-failed`)                |
| 429    | cost guard (`Retry-After`)                                                       |
| 503    | `ai-disabled` (no provider configured), transport failure, or uncertain call     |

Unknown `/ai/*` paths are ordinary unknown routes.

## Capabilities

`GET /ai/capabilities` answers `{ "roles": { "topic-extractor": bool, "background-proposer": bool,
"librarian": bool, "proof-state-formalizer": bool, "move-shortlister": bool, "move-executor":
bool, "move-author": bool } }`. A role is `true` only when it has a configured transport and evidence storage. No model
name, endpoint or credential is disclosed. The web application reads it to
decide which AI controls to enable.

## Propose a background

`POST /ai/background` proposes the background relative to which a proof will be motivated, and the
constants (operator declarations) that suffice to formalize the problem
(`docs/ai-agents-architecture.md` section 1). The role sees only the problem statement and the
optional preferences; the user's background, declarations, hypotheses, goals and library content
are never sent.

```json
{
  "constructionId": "construction:example",
  "id": "llm-call:background-example",
  "problem": { "title": "Coprime neighbours", "statement": "Show that n and n + 1 are coprime." },
  "preferences": { "domains": ["number theory"] }
}
```

A validated proposal answers `status: "proposed"` with `provenance: { kind: "minimal-context-llm",
role: "background-proposer" }`, the `callId`, and the `proposal`:

- `background`: the existing background profile (`level`, `summary`, `assumptions`, optional
  `domains` and `maximumLevel`);
- `constants`: a list of `{ operator, rationale }`, where `operator` is a full `OperatorDeclaration`
  (ID, symbol, signature, LaTeX and natural-language presentation) and `rationale` is a one-line
  reason.

The role's context also lists the operators that already exist (the packs' operators, i.e. the
global registry) as `operators`: symbol, display name and signature in the sort names. The system
message tells the model to reference an existing operator with exactly its symbol and signature
instead of clashing with it, which the worker resolves as described under "Record a background
decision". Calls stored before the list was offered have no `operators` field and still read; the
system message and prompt version (`background-proposer-v2`) changed with it, and the earlier
message is still accepted when stored evidence is read.

The provider is asked for a strict, flat encoding (nullable fields instead of optional ones, and a
signature written with the problem setup's sort names), which the worker converts to full
declarations. The converted proposal is the stored and returned form. Deterministic validation
rejects the output (`422`, recorded) unless every constant parses as an `OperatorDeclaration`, no
constant declares a reserved built-in symbol (built-ins are always available and are never
constants), IDs, symbols and LaTeX parse triggers are unique, symbols are plain identifiers, every
signature sort is a known sort and every constant has at least one operand. The system message
states that the constants must suffice to formalize the problem.

A context request or refusal answers `status: "insufficient-context"` or `"declined"` with the
model's `result`.

### Revise a proposal

A revision is a new call that names the previous call of the same construction:

```json
{
  "constructionId": "construction:example",
  "id": "llm-call:background-example-2",
  "problem": { "title": "Coprime neighbours", "statement": "Show that n and n + 1 are coprime." },
  "revision": {
    "previousCallId": "llm-call:background-example",
    "feedback": "Also allow the greatest common divisor."
  }
}
```

The worker reads the previous proposal from storage; a client cannot supply one, and a request that
carries a `previousProposal` is refused (`400`). An unknown call, or a call owned by another
construction, is `404`. A call that exists but is not a validated background proposal (another role,
a rejected output, a refusal) is `409 proposal-not-revisable`. The answer is an ordinary proposal
plus `revisedCallId`. The whole chain is recorded, and a revision can itself be revised.

### Record a background decision

`POST /ai/background/decisions` records the user's decision on a stored proposal, with the same
request body as a topic decision (`constructionId`, `decisionId`, `callId`, `decision`, `rationale`,
`decidedAt`). The worker reads the proposal from the stored call, and the reviewer is the web actor
`actor:web`. The client chooses `decisionId` and `decidedAt` once, so a retried decision replays
(`200`, `replayed: true`); reusing the ID for a different decision, or for a topic decision, is
`409 decision-id-conflict`. Only a validated background proposal can be decided (`409
proposal-not-reviewable`). Decisions are stored beside topic decisions in `llm_topic_decisions`.

An approval answers `201 { status: "recorded", decision, approvedBackground }`, where
`approvedBackground.id` is `background-approval:<decisionId>`. It is refused with `409
approved-constant-conflict` when a constant clashes with the global operator registry, which is the
set of operators of the library packs: a constant that uses a registry symbol is a _reference_ to
that operator if its signature is the same (the registry's own declaration is then used wherever the
constants are), and a clash if the signature differs or if it reuses a registry operator's ID or
LaTeX trigger under another symbol. A rejection is always recorded and approves nothing.

### Approved constants

The constants of an approved background are available to later steps only by naming the approval
decision; the worker resolves them from storage, and every route refuses declarations supplied by
the client. An unknown decision, or one of another construction, is `404 decision-not-found`; a
rejected decision is `409 decision-not-approved`. The steps are the formalizer (`approvedBackground:
{ decisionId }`, below), the setup check and the session approval (`approvedBackground: {
constructionId, decisionId }`, below).

## Build a library

`POST /ai/library` asks the librarian for general library results about an approved background
and its constants (`docs/ai-agents-architecture.md` section 2, request kind `initial`). The
librarian never sees the problem statement: its context is `{ kind: "initial", background,
constants, existingResults }`, where `background` and `constants` are resolved from the approved
background decision in storage (the constants are the approved constants followed by the operators
of the selected packs) and `existingResults` lists the id, name and statement of the results
already in the library for those packs, so that it does not repeat them. The context is a union
discriminated by `kind`; the top-up kinds (below) extend it. The system message gained guidance for the
top-up kinds (prompt version `librarian-v2`); calls stored with the earlier message remain readable.

```json
{
  "constructionId": "construction:example",
  "id": "llm-call:library-example",
  "approvedBackground": { "decisionId": "background-decision:example" },
  "packs": ["pack:divisibility"]
}
```

A request with any other field (a problem, a background, constants, existing results) is `400`.
An unknown, foreign or rejected background decision is `404` or `409`, as for the formalizer.

The provider returns up to 40 results in a strict flat encoding: a slug, a name, a description, a
classification (domains and a level), parameters (a symbol and a sort name), premises, a statement
and patterns (recursive plain MathJSON formulas), application directions, and optionally new
constants (operator declarations with a rationale) that the results need. The worker normalizes
each result to the library's result shape (deterministic identifiers `result:library-<slug>`,
`declaration:library-<slug>-<symbol>` and `pattern:library-<slug>-<n>`). New constants are checked
like a background proposal's constants, and one that repeats or clashes with a constant of the
context rejects the output (`422`). A result that cannot be read as a result (a formula that is not
plain MathJSON or is too large, a parameter named like an operator, inconsistent directions) is set
aside as `unusable` with a reason and does not affect the others. More than 40 results is an invalid
output. A context request (`requestedCategories` of `background-detail` or `constant-detail`) or a
refusal answers `status: "insufficient-context"` or `"declined"` with the model's `result`.

Everything after validation is deterministic and a function of the stored call alone, so a replay
answers identically:

- each result is assembled into a library result (kind, renderings from the language package,
  `generated` provenance naming the librarian and the call, layer `initial-problem`, priority 50)
  and run through `admitLibraryArtifact` in the construction's operator environment (the context's
  constants plus the accepted new constants) and background profile. The gate admits the
  `initial-problem` layer on approval alone, so a result is judged in the form in which it would be
  recorded (approved by the web reviewer) and shown as a draft; the worker additionally rejects a
  result whose classification is outside the profile's declared domains or above its maximum level
  (an undeclared domain list or maximum level constrains nothing);
- a new constant is resolved against the operator registry like a background constant: a repeat of a
  registry operator's symbol and signature becomes that registry operator, and a clash is set aside
  with its reason (the results that need it then fail the gate);
- `generateVariants` runs on each admitted result, and each variant passes the gate as well.

The answer is `status: "proposed"` with `provenance: { kind: "minimal-context-llm", role:
"librarian" }`, the `callId`, `requestKind`, and

- `results`: `{ artifact, variants, newConstantSymbols }` for each admitted result, in the
  proposal's order. The artifact is a draft (`approval.status: "draft"`) tagged with its variant
  family when it has variants;
- `rejected`: `{ id, name, reasons, codes }` for each result that did not pass, with plain reasons
  (an unknown operator, an ill-sorted statement, a domain outside the background) and the admission
  code, or `unreadable` or `outside-background`;
- `newConstants`: `{ operator, rationale, usedBy }` for each accepted new constant;
- `rejectedConstants`: `{ symbol, reason }` for each one set aside.

Nothing is written to any library scope. The cost guard, replay by call ID and the `503`/`422`
outcomes are as for the other roles.

### Record a library decision

`POST /ai/library/decisions` records which admitted results the user kept:

```json
{
  "constructionId": "construction:example",
  "decisionId": "library-decision:example",
  "callId": "llm-call:library-example",
  "approvedResultIds": ["result:library-coprime-symmetry"],
  "decidedAt": "2026-10-15T12:30:00.000Z",
  "rationale": "Kept in the problem setup form."
}
```

The request names result IDs only (`rationale` is optional); an artifact, a statement or any other
field is `400`. The worker reads the stored call, evaluates it again and refuses (`409
result-not-admitted`) any ID the gate did not admit; the call must be a validated library
proposal of the same construction (`404` for an unknown call, `409 proposal-not-reviewable` for
another role's call). The decision is stored in `llm_topic_decisions` beside the other decisions
(no new table): the row holds the IDs, in the proposal's order whatever order the client sent them
in, and no artifact. The client chooses `decisionId` and `decidedAt` once, so a retried decision
replays (`200`, `replayed: true`), and reusing the ID for another selection is `409
decision-id-conflict`. An approval answers `201 { status: "recorded", decision, approvedLibrary }`;
`approvedLibrary.id` is `library-approval:<decisionId>`. Keeping nothing records nothing.

### Approved library

The results of an approved library reach later steps only by naming the decision. The worker
resolves the decision and its call from storage, runs the gate again and keeps the named results
with their variants (approved by the reviewer `actor:web`); if a stored decision no longer passes
the gate the answer is `409 approved-library-stale`. The new constants that the kept results apply
(and only those) join the session's operators after the approved background constants. The
formalizer takes `approvedLibrary: { decisionId }`, the setup check and the session approval take
`approvedLibrary: { constructionId, decisionId }` (below).

## Suggest topics

The topic extractor is superseded by the background proposer in the web UI. The worker keeps the
role and the routes below.

`POST /ai/topics` proposes a topic and vocabulary manifest (design plan §4.2) from the problem,
the background and the optional preferences only. Declarations, hypotheses, goals and library
content are never sent.

```json
{
  "constructionId": "construction:example",
  "id": "llm-call:topics-example",
  "problem": { "title": "A small example", "statement": "Prove that p implies p." },
  "background": { "level": "first-year undergraduate", "summary": "Logic.", "assumptions": [] },
  "preferences": { "domains": ["logic"] }
}
```

A validated manifest answers `status: "proposed"` with `provenance: { kind:
"minimal-context-llm", role: "topic-extractor" }`, the `callId`, and the `proposal` (`domains`,
`objectKinds`, `vocabulary`, `notation`, `backgroundTopics`, `customOperators`). A context request
or refusal answers `status: "insufficient-context"` or `"declined"` with the model's `result`. A
malformed manifest (an extra field such as a solution, duplicates, another kind) is recorded and
rejected with `422`. The manifest changes nothing on its own.

### Record a topic decision

`POST /ai/topics/decisions` records the reviewer's decision on a stored proposal:

```json
{
  "constructionId": "construction:example",
  "decisionId": "topic-decision:example",
  "callId": "llm-call:topics-example",
  "decision": "approved",
  "rationale": "Matches the problem.",
  "decidedAt": "2026-10-13T12:00:00.000Z"
}
```

The worker reads the proposal from the stored call; a client cannot send its own. The reviewer is
the web actor `actor:web`. An approval also yields an approved manifest with the ID
`topic-manifest:<decisionId>`. The client chooses `decisionId` and `decidedAt` once, so a retried
decision replays (`200`, `replayed: true`). Reusing the ID for a different decision is `409
decision-id-conflict`. Only a validated `topic-manifest` output can be decided (`409
proposal-not-reviewable`). Topic evidence is construction-owned, like the formalizer's.

## Formalize a problem

`POST /ai/formalize` accepts a problem-construction ID, a stable call ID, problem text, background,
preferences, approved library layer IDs, selected library pack IDs, and optionally the approval
decision of a background proposal (`"approvedBackground": { "decisionId": "..." }`). The server
resolves the selected packs from its approved catalog and the approved constants from storage;
clients cannot provide library statements, operators, or sorts directly. The formalizer's
`approvedLibrary.operators` are the selected packs' operators followed by the approved constants
(`approvedLibrary.sorts` stays the problem setup's sort menu), and its system message requires it to
formalize using only those operators, the built-in symbols and its own declarations, and to ask for
an operator definition instead of inventing one. The decision must be an approval of the same
construction (`404` otherwise; `409` for a rejected decision or a constant that clashes with the
registry).

With `"approvedLibrary": { "decisionId": "..." }` the formalizer's `approvedLibrary.results` also
include the approved initial library's results and then their variants, after the selected packs'
results, and `approvedLibrary.operators` also include the new constants that the kept results
apply. The context holds at most 64 results. Within that cap everything is shown; beyond it
originals come before variants and the user's approved results before the packs' own, and the rest
are left out. A draft is checked against the same operators, and the approved library is checked
against the draft's setup like at "Check setup" (below).

```json
{
  "constructionId": "construction:example",
  "id": "llm-call:formalize-example",
  "problem": { "title": "A small example", "statement": "Prove that p implies p." },
  "background": {
    "level": "first-year undergraduate",
    "summary": "Introductory logic.",
    "assumptions": [],
    "domains": ["logic"],
    "maximumLevel": "undergraduate"
  },
  "preferences": { "domains": ["logic"], "notation": [] },
  "libraryLayerIds": ["layer:global"],
  "packs": []
}
```

The response contains an N26 problem draft and, when admitted, a `proofState` using the repository's
existing `ExecutableProofState` shape: declarations, contextual sequents, MathJSON hypotheses and
goals, and obligations. The state is the exact state generated by `validateProblemDraft` for the
approval review. Each goal or obligation carries a sequent with its context declarations and
hypotheses plus a conclusion; statements contain the authoritative MathJSON `expression`. The
returned state equals `review.rootNode.state`, including its IDs, after executable-state schema
validation. A valid draft is returned with `status: "ready-for-review"`; an invalid draft returns
`status: "needs-review"` and diagnostics. The review's `operators` include the approved constants,
and LaTeX in the draft is read with the constants' parse triggers.

Before admission the worker checks, deterministically, that the draft applies no operator outside
the approved set. An operator that is neither a reserved built-in, nor an operator of a selected
pack, nor an approved constant, nor a symbol the draft declares gives a `422` `needs-review` answer
with one `unapproved-constant` diagnostic per statement and operator (path `["goals", 0,
"latex"]` and so on); the message names the pack when the operator belongs to a pack that is not
selected. The draft is returned for the user to repair by hand, and nothing is admitted.
The endpoint does not create a proof session or approve the draft. The N26 draft must fit the
existing problem setup schemas for problem text, background, preferences, approved library layers
and packs, and LaTeX goals/hypotheses. `validateProblemDraft` performs the existing parse, sort,
operator, and admission checks before exposing the proof state and review result. Formalizer
evidence belongs to the construction and is available at
`GET /constructions/:constructionId/llm-calls` and
`GET /constructions/:constructionId/llm-calls/:callId`.

Call IDs are immutable within their owner scope. Retrying the same ID and identical prepared call
replays its stored outcome; reusing it for different input or dispatch settings is a conflict. A
changed context should use a new call ID. The strengthened formalizer system message has the
prompt version `proof-state-formalizer-v2`; calls stored with the earlier message remain readable.

## Check and approve a setup with approved constants and library

A drafted (or hand-entered) setup that applies approved constants can only be checked and approved
when the request names the approval:

- `POST /problem-drafts/validate` accepts `{ "draft": ..., "approvedBackground": { "constructionId":
"...", "decisionId": "..." }, "approvedLibrary": { "constructionId": "...", "decisionId": "..." } }`;
- `POST /proof-sessions` accepts the same optional `approvedBackground` and `approvedLibrary` beside
  `sessionId`, `draft` and `reviewedDigest`.

The worker resolves the constants from storage and adds them to the session's operators after the
selected packs' operators; the stored session therefore declares them like any pack operator. The
reviewed digest covers the operators, so approving with other constants than the review used is a
stale review (`409`). A missing decision is `404`, a rejected one `409`, and a field other than
`constructionId` and `decisionId` in the reference is `400`. Without the reference, the constants
are unknown to the setup, and a draft that uses them is invalid (`422`).

An `approvedLibrary` reference is resolved the same way (`404` for an unknown decision or one of
another construction or role, `409 approved-library-stale`, `503 library-unavailable` when the
worker has no library store). The check also runs the library gate for every kept result and
variant in the session's operators and the draft's background, and requires the draft to include the
layer `layer:initial-problem`; anything the gate would reject is a `422` with an
`approved-library-invalid` diagnostic (path `["approvedLibrary"]` or `["libraryLayerIds"]`) naming
the result, so no result is rejected silently at approval. The review gains `initialLibrary`
(`{ results, variantCount, addedOperatorSymbols }`, with each result's id, name, description,
statement and premises) and its digest covers the kept results and their variants in full; a setup
without a library hashes as before.

A `201` records the kept results and then their variants as library additions of the new session,
layer `initial-problem`, origin `{ kind: "setup", actorId: "actor:web" }`, occurring at the
decision's `decidedAt`, approved by `actor:web`, through the library repository's gate. The
session and its additions cannot share one transaction: the proof store and the library store have
separate transaction interfaces (separate connections in PostgreSQL). Recording is therefore
idempotent instead: each addition has the deterministic event ID
`library-addition:<sessionId>:<decisionId>:<artifactId>`, so repeating it replays the stored event.
The approval runs it after creating the session and again for a replay of the same approval (`200`).
If recording is interrupted the answer is `503 initial-library-incomplete` (the session exists,
with part of its library), and approving again with the same request finishes it, adding each
result exactly once.

## Shortlist displayed moves

`POST /proof-sessions/:sessionId/ai/shortlist` accepts a call ID, the expected current node ID, a
stored displayed suggestion-set ID, candidate suggestion IDs, and the trigger: `explicit-user`
(the user asked), `automatic` (the user's selections produced a list of two or more suggestions and
automatic ranking is on) or `deterministic-empty`. The trigger is stored in the call evidence as
sent. Candidate IDs must be members of that stored set. The response contains ordered candidate IDs
and provenance. A Jev refusal, malformed response, low-confidence response (including a
low-confidence none-relevant answer), disabled runtime, or transport failure returns the
deterministic candidate order from the stored set. If the current node or suggestion set is stale, the response is marked stale and contains no
fallback candidates. A single supplied candidate is returned deterministically without a model
call.

```json
{
  "id": "llm-call:shortlist-example",
  "expectedCurrentNodeId": "node:current",
  "suggestionSetId": "suggestion-set:displayed-example",
  "candidateIds": ["suggestion:one", "suggestion:two"],
  "trigger": "explicit-user",
  "maxChoices": 2
}
```

The successful response has `status: "shortlisted"`, `provenance: "minimal-context-llm"`, the
anchored `suggestionSetId` and `nodeId`, and ordered `choices` containing existing suggestion IDs.
Deterministic outcomes use `status: "deterministic-fallback"` and `provenance: "deterministic"`.
The route references the existing displayed set; it does not create a new suggestion set.

### None relevant

The shortlister may also answer that no displayed candidate is relevant to the selections. This is a
validated outcome of its own, distinct from a refusal, a malformed answer and a low-confidence
answer. The response is `200`:

```json
{
  "status": "none-relevant",
  "provenance": "minimal-context-llm",
  "callId": "llm-call:shortlist-example",
  "replayed": false,
  "suggestionSetId": "suggestion-set:displayed-example",
  "nodeId": "node:current",
  "choices": [],
  "confidence": 0.9,
  "reason": "Jev judged that none of the displayed suggestions is relevant to the selection.",
  "fallbackCandidateIds": ["suggestion:one", "suggestion:two"],
  "diagnostics": []
}
```

`fallbackCandidateIds` is the deterministic list, so a client can keep showing it. The call evidence
stores the output `{ "kind": "none-relevant", "confidence", "reason" }`. The outcome is accepted only
when its confidence reaches the configured threshold (`PROOF_AI_SHORTLISTER_MIN_CONFIDENCE`). A
none-relevant answer below it is stored as `declined` (Jev) or answered as an ordinary
`deterministic-fallback`, exactly like any other low-confidence answer. A client uses the outcome to
offer "Describe a move" (the move executor, below) and "Find more results" (a library top-up,
below; `docs/ai-agents-architecture.md` §4).

This endpoint records an immutable LLM call record but does not preview or apply any move. Human or
agent actions still go through the existing proof command protocol.
Shortlist evidence is session-owned and included in exported session artifacts under `llmCalls`.
Construction-owned formalizer evidence is available through its construction evidence route; it is
not implicitly attached to a later proof-session artifact.

## Top up the library during a proof

`POST /proof-sessions/:sessionId/ai/library/top-up` asks the librarian for more results while a
proof is in progress (`docs/ai-agents-architecture.md` section 2). There is no review step: the
worker judges every returned result with the admission gate and records the admitted ones, with
their generated variants, as library additions of the session. The route never touches proof
state, and the suggestion sets that were displayed before it are stored exactly as they were; the
next suggestion request sees the larger library.

```json
{ "id": "llm-call:find-more-1", "kind": "no-relevant-results",
  "expectedCurrentNodeId": "node:current", "selections": [ { "kind": "exact", "anchor": { ... }, "path": [0] } ] }
{ "id": "llm-call:new-constants-1", "kind": "new-constants", "constants": ["Gcd"] }
```

- `kind: "no-relevant-results"` is user-initiated ("Find more results"). `selections` (1 to 16
  descriptors, as for a suggestion request but without an abstraction) are resolved against the
  current node, and the librarian is given an abstracted description of them (design plan §15.3):
  each selected fragment with its problem variables renamed to neutral names (`x1`, `x2`, ... in
  order of first appearance, one mapping for all fragments), the sorts of those variables and
  whether it sits in a positive or negative position. It is never given the problem, the proof's
  identifiers, hypotheses, other goals, history or any suggestion. Its context is `{ kind,
background, constants, existingResults, situation }`, where `constants` are the session's active
  constants.
- `kind: "new-constants"` is requested automatically by the web application after a committed step
  activated constants (below). Its context is `{ kind, background, constants, existingResults,
newConstants }`: the old active constants and the newly activated ones, and the librarian is asked
  for results that involve the new constants together with the old ones and the new ones alone. The
  optional `constants` lists symbols only, never declarations: the worker finds the activated
  constants itself, and a symbol that no committed step has activated is `409
constant-not-activated`. Without `constants`, every activated constant that no recorded top-up
  covers is requested. Nothing waiting is `409 no-new-constants`.
- In both kinds `existingResults` are the id, name and statement of the results the session
  library already holds (the catalog below), most relevant first and capped at 128. `expectedCurrentNodeId`
  is optional; when given, a proof that moved on is `409 stale-evidence`.

Before a call is paid for, the worker refuses a read-only session (`409 session-read-only`), a
session without a background profile (`409 background-missing`) or whose profile does not declare
its domains and maximum level (`409 background-undeclared`: the gate would admit nothing), and a
stale or unresolvable selection. A missing provider is `503 ai-disabled` (also without evidence or
library storage), an exhausted budget is `429` with `Retry-After`, and a failed or malformed call
is `503` or `422`, recorded as session-owned evidence like the executor's calls
(`GET /proof-sessions/:id/llm-calls`, and `llmCalls` of the exported artifact).

Admission is deterministic and a function of the stored call, the session's operators and
background, and its library:

- Results are judged in the session's own operators and recorded in the `proof-time-background`
  layer, approved by `service:library-gate` (the gate, not a person or the model), with origin
  `{ "kind": "service", "actorId": "llm-call:<id>" }`. Each addition has the event ID
  `library-addition:<sessionId>:top-up:<callId>:<artifactId>`, so doing it again records nothing
  twice. The library drawer lists them as ordinary additions, without a badge; the provenance is in
  the event and the exported artifact.
- **New constants are not accepted.** A session's operators are fixed when it is approved, and no
  recorded mechanism extends a live session's operators (the operator registry is global and is not
  read by retrieval or the kernel). Any `newConstants` the librarian returns are reported in
  `rejectedConstants`, and a result that applies one is rejected (`needs-new-constant`) rather
  than silently changing the session.
- Other rejections carry plain reasons and codes: the gate's own (`invalid-artifact`, an unknown
  operator or ill-sorted statement; `domain-outside-background`, `level-above-background`),
  `duplicate-id`, `duplicate-statement` (the same premises and statement as a library result, up to
  the names of parameters), `unreadable`, and for `new-constants` `not-about-new-constants` (a result
  must apply at least one newly activated constant). A variant that repeats a library statement
  is left out quietly.
- Replay by call ID: an `id` that is already stored is answered from the stored call, after
  checking it is the same kind of request (`409 call-id-conflict` otherwise; for a situation request
  the selections are compared with the stored situation while they still resolve). The context a
  replay would rebuild differs from the stored one (the library grew), which is why the stored call
  is used. A run interrupted part-way (`503`, `status: "incomplete"`) is finished by repeating the
  request with the same ID.

The answer is `201` (something was recorded) or `200` with `status: "topped-up"`, `provenance`,
`admittedBy`, `callId`, `replayed`, `requestKind`, `added` (`{ id, name, description, renderings,
variantIds, eventId }` per result), `addedCount`, `rejected` (`{ id, name, reasons, codes }`),
`rejectedConstants`, and for `new-constants` `coveredConstants`. A context request or refusal is
`200` with its `status` and `result` and adds nothing.

### Active constants

The constants of a session are its operator declarations. Those of the accepted background and of
the starter packs are active from the start. An operator that joined the session only because an
approved initial-library result applies it (`libraryConstants` in the session metadata, recorded at
approval) is declared but dormant: no step has used it and the library has no results written about
it. It becomes active when a committed step first applies a library result that mentions it.

Activation is not a new record. The committed step already is the append-only record: its edge names
the library result it applied (an `apply-result-*` operation, or a rewrite whose source is a result)
and carries the session's transition sequence, so activation is a deterministic read of the retained
history in sequence order. Backtracking does not undo it; deleting the step that activated a
constant does. No migration was needed. The library call is a separate request made after the step
committed, never inside the command transaction.

`GET /proof-sessions/:sessionId/library/constants` answers `{ sessionId, readOnly, active,
dormant, activated }`: symbols of the operators in play and of the dormant ones, and for each
activation `{ symbol, edgeId, nodeId, resultId, sequence, topUp }`, where `topUp` is `{ callId }` of
the recorded `new-constants` call that covered it (a session-owned librarian call with a validated
output; a failed or rejected call covers nothing) or `null`. The web application reads it after
every change of the current node and requests the missing top-ups.

### The session library in retrieval

The results a session records join its retrieval and application catalog (design plan §12.4): the
admitted results of its `initial-problem` layer (the approved initial library) and of its
`proof-time-background` layer, with their generated variants and variant families, beside the
approved conditional lemmas. It is one catalog for retrieval, materialization, apply, replay, the
move executor's context and the library view. A result the kernel cannot instantiate in the
session's operators (for example one whose operator the session does not declare) is not offered,
and never fails the session. An imported artifact is revalidated with the results of its own
library section, so a step that applied one replays. A result added during the session is available
from then on, including after backtracking.

## Describe a step (move executor)

The move executor turns a step described in words into a plan of kernel operations. Two routes,
both session-scoped, keep it from ever changing the proof on its own (architecture §5).

### Preview

`POST /proof-sessions/:sessionId/ai/execute` accepts:

```json
{
  "id": "llm-call:execute-example",
  "expectedCurrentNodeId": "node:current",
  "instruction": "Assume p, split the conjunction and close the p half.",
  "source": "user-instruction",
  "target": { "kind": "goal", "id": "goal:main" },
  "selections": [
    {
      "kind": "exact",
      "anchor": {
        "stateId": "state:current",
        "target": { "kind": "goal", "id": "goal:main" },
        "statement": { "kind": "conclusion" }
      },
      "path": []
    }
  ]
}
```

`source` is `user-instruction` (the user's own words) or `shortlisted-technique` (a technique another
service suggested). `selections` is optional and uses the same descriptors as a suggestion request,
without an abstraction. The instruction is trimmed and limited to 2,000 characters.

The worker builds the model's context deterministically (design plan §15.3) before any call: the
instruction, the source, the selections as fragments with their positions, the **target sequent
only** (its conclusion, its hypotheses with their statement IDs, and the declarations those
statements use), the session's active operator declarations, and up to 32 approved library results
that share operators with the selection (or the conclusion, when nothing is selected). The original
problem, other goals and obligations, history, branches and alternative suggestions are never sent.
A stale node, a read-only session, and a target outside the state are refused before a provider call
(`409`, `409`, `400`); a missing provider is `503 ai-disabled`; an exhausted budget is `429` with
`Retry-After`. A replay of a stored call costs nothing and returns the stored plan again.

The model answers with one of: a **plan** of 1 to 16 kernel operations (the kernel's operation
schema minus `expectedStateId` and `resultStateId`), `insufficient-context`, or `declined`. A plan
never contains `mark-sorry` or `close-by-accepted-inference`, no unknown operation kind, no state
IDs, and cites only supplied library results; anything else is recorded and answered `422`
(`status: "rejected"`). The model names every new statement, hypothesis, obligation, declaration or
assumption with a short **label**; the worker makes labels globally unique by prefixing the call
ID, and a later step refers to an earlier label by the same text. State IDs are chained by the
worker (`state:<callId>:<n>`).

The worker runs the plan with `planMoveSequence` against the current state and answers `200`:

- `status: "previewed"`: `provenance` (`user-proposal` or `minimal-context-llm`, role
  `move-executor`), `callId`, `replayed`, `nodeId`, the model's short `explanation`, the composed
  `transitionClass` and most caveated `evidence`, the `steps` (each concrete kernel operation with
  its own class and evidence), and `preview`: `{ transitionClass, evidence, beforeState, afterState,
delta }`, the same before/after/delta the move preview uses. Nothing was committed.
- `status: "plan-failed"`: the kernel rejected a step. `failure` is `{ stepIndex, stepCount, code,
message }` with the kernel's own sentence; nothing was committed.
- `status: "insufficient-context"` or `"declined"`, with the model's `result`.

The call is session-owned evidence (`GET /proof-sessions/:sessionId/llm-calls`) and is exported
with the session artifact under `llmCalls`, exactly like shortlist evidence.

### Apply

`POST /proof-sessions/:sessionId/ai/execute/apply` accepts `{ "callId", "expectedCurrentNodeId" }`
and nothing else. The worker reads the plan from the **stored call**, never from the request; a
call that does not exist is `404`, one that produced no validated plan is `409 plan-not-applicable`,
and a call previewed at a different node, or a session that moved on since, is `409` (stale). It
then commits the steps as ordinary raw `apply-kernel-operation` commands in one transaction, the way
a macro's steps are committed: step `i` is command `command:<callId>:step:<i>`, validated by the
kernel against the node the previous step created, with the acting human `actor:web`. A step the
kernel rejects at this point is `422 plan-step-failed` and records nothing. `201` carries
`status: "applied"`, the final `nodeId`, the composed class and the committed steps; a retry replays
the recorded commands (`200`, `replayed: true`).

Every committed command, and the edge it creates, carries a **proposal link**
`{ source: "user-proposal" | "minimal-context-llm", role: "move-executor", callId, stepIndex,
stepCount }`, so history and the exported artifact name the stored call that proposed the step.
`user-proposal` marks a plan from the user's own description; `minimal-context-llm` one from a
suggested technique. The link is part of the protocol (`proposalLinkSchema`); artifact import
replays each command with it, so stripping it from an edge is detected.

## Save a step as a reusable move (move author)

A step the user described in words and applied can be turned into a general, reusable move. The
raw operations of the executor's plan are not enough: they carry one problem's constants and no
selections. The move author is the prose-authoring workflow of refinement section 7.1: a stronger
model proposes a general move in the existing authored-move template language, the platform runs
every example through the kernel, and a person reviews the draft. Nothing is approved
automatically, and the route records no draft.

`POST /proof-sessions/:sessionId/ai/move-author` accepts:

```json
{
  "id": "llm-call:author-example",
  "executorCallId": "llm-call:execute-example",
  "revision": { "previousCallId": "llm-call:author-previous", "feedback": "Also handle ..." }
}
```

`revision` is optional. The executor call, and on a revision the previous proposal, are read from
the session's stored evidence, never from the request. Only an executor call whose plan was
actually applied in this session (its step commands still exist) and that came from a
`user-instruction` can be authored from; any other call (missing, another session's, another role's,
previewed but not applied, applied and since deleted, a shortlisted technique) is `409`
(`executor-call-unavailable`, `plan-not-applied`, `not-a-user-instruction`). A read-only session is
`409 session-read-only`. A revision of a call that is missing is `404`, and of one that is not a
validated proposal for the same step is `409 proposal-not-revisable`.

The worker builds the model's context deterministically (design plan section 15.3) before any
call: the user's own instruction text; the applied plan, abstracted (the target sequent restricted
to the hypotheses and declarations the step used, the problem's symbols and every statement ID
renamed to neutral names, the plan's references and mathematics renamed the same way, and the state
the plan leaves, obtained by running it through the kernel); the kernel primitives a move may use
with their selection slots, parameters (and the kind of value each takes) and the identifiers they
create, generated from the move catalog; the active operators and the approved results the executor
was shown; and, on a revision, the previous proposal (validated again), the reviewer's feedback and
the platform's own findings about the previous proposal. The original problem, other goals,
history, branches and alternative suggestions are never sent. `mark-sorry` and
`close-by-accepted-inference` are not primitives a move can use.

The model answers with a proposal, `insufficient-context`, or `declined`. A proposal is a name, a
mathematical description, a `motivation` (how the situation led to it), an honest `classification`
(`macro`, `heuristic` or `principle`, refinement section 7.3), the declared transition class,
applicability conditions, the metavariables with their sorts, the patterns for the first step's
selection slots, a plan of one to sixteen primitive steps (each with the selections that fill its
slots, as expressions over the metavariables, and its menu parameters), required results, and three
to eight examples. Exactly one example is the situation the step was applied to: for it the
platform supplies the abstracted state and what the step left, so the model states only the
selections. At least one more positive example (with its own state and the outcome it expects) and
at least one negative or boundary example are required. An output that breaks these rules, names a
primitive, slot, parameter or result the context does not offer, or does not compile to a
well-formed template, is recorded and answered `422` (`status: "rejected"`).

**Template language.** The proposal is compiled into the existing authored-move template. One
extension carries what executor steps need and a menu cannot offer: a **construction**. A recorded
plan parameter with the template's own `rule` origin and a `term` or `proposition` value is a
MathJSON template over the metavariables of the patterns. When the move is applied the
metavariables are bound by matching the selections against the patterns, the template is
instantiated by capture-avoiding substitution, and the result is offered as one more item of the
parameter's menu, already chosen. The menu's typing check and the kernel still validate it, a
user cannot override it, and the first primitive's contract does not ask the user for it. Only the
parameters of `split-classical-cases`, `assume-hypothesis`, `replace-goal`, `suffices`,
`instantiate-universal-hypothesis`, `choose-existential-witness` and the instantiation of a result
or assumption can be constructed. A later step can name an identifier an earlier step created as
`<step id>.<field>[.<n>]` (for example `split.childIds.1`) instead of recording the operation. A
single-step template with a construction is an ordinary retrievable move; a template of several
steps is a macro. `validateMoveTemplate` still runs every example through the kernel and compares
the composed class, and now also fails with `problem-specific-symbol` when a pattern fragment,
construction or recorded value mentions a symbol that is not an operator, a built-in or a
metavariable (a problem-specific constant), and `invalid-construction` for a construction of a
parameter that cannot be built.

The worker compiles a validated proposal, runs `validateMoveTemplate` in the session's operator
environment and answers `200`:

- `status: "proposed"`: `provenance` (`minimal-context-llm`, role `move-author`), `callId`,
  `replayed`, `executorCallId`, `revisedCallId` (on a revision), the compiled `template`,
  `motivation`, `classification`, `validation` (`{ ok: true, report }` or `{ ok: false,
diagnostics }`, with per-example diagnostics carrying `exampleId`), `generality` (notes that are
  not failures: a numeral kept by a construction, or positive examples that differ only by
  renaming) and, for a proposal classed as a new `principle`, `blocked`. A proposal that fails
  validation is still `proposed`: the person sees the diagnostics and can edit by hand or revise.
- `status: "insufficient-context"` or `"declined"`, with the model's `result`.

The call is session-owned evidence and is exported with the session artifact under `llmCalls`. A
replay of a stored call costs nothing and returns the proposal and a fresh validation; reusing an
ID for a different request is `409`.

**Submitting.** The user submits the (possibly edited) template through the ordinary
`author-move-draft` command, with an optional `proposal` link
`{ "role": "move-author", "callId", "executorCallId" }`. The worker checks both calls in the
session's evidence (`409 proposal-not-found` or `proposal-mismatch`) and records them as the
draft's provenance, `{ kind: "generated", role: "move-author", contextId: <move-author call>,
sourceContextId: <executor call> }`; the review artifact restates it, an approved move's definition
keeps it, and artifact export and import keep it (import refuses a move that names calls the
artifact does not contain). A proposal classed as a `principle` cannot be submitted as a move
(`409 principle-not-a-move`): a method that needs an unavailable result cannot acquire it by being
approved. The link grants no authority. Review is the ordinary `review-move-draft` by a human,
against the generality questions of refinement section 7.2; the proposed move is retrievable and
applicable in the session only after an approval, with its provenance intact.

## Web interface

The web application relays these routes through same-origin proxies (`/api/ai/background`,
`/api/ai/background/decisions`, `/api/ai/library`, `/api/ai/library/decisions`,
`/api/ai/formalize`, `/api/proof-sessions/:sessionId/ai-shortlist`,
`/api/proof-sessions/:sessionId/ai-execute`, `/api/proof-sessions/:sessionId/ai-execute/apply`,
`/api/proof-sessions/:sessionId/ai-move-author` and
`/api/proof-sessions/:sessionId/ai-library-top-up`), keeping the worker's status codes, including
`429`; `GET /api/proof-sessions/:sessionId/library/constants` reads the activated constants. `/api/problem-drafts/validate` and
`/api/proof-sessions` also pass the optional `approvedBackground` and `approvedLibrary` references
(and refuse any other field in them). The topic routes are no longer relayed.

- **New problem.** An optional "AI assistance" section starts with "Propose background", enabled
  once the problem statement is filled in (the background fields need not be filled first). The
  result card shows the background level, summary, assumptions and domains, and the constants with
  their LaTeX, wording and rationale. "Revise with feedback" (a text box and a button, enabled once
  there is feedback) asks for a revised proposal that replaces the card, and "Accept" records the
  decision, fills in the existing background fields (which stay editable) and keeps the constants
  for the rest of the form: they are named by decision in the formalizer call, the setup check and
  the approval, previewed in the LaTeX fields, and listed in the review. "Stop using these
  constants" drops them. A proposal that cannot be accepted (for example because a constant clashes
  with the operator registry) says why and leaves the form unchanged. The "Draft the setup" step
  needs the problem and background fields; a drafted setup, even one that needs review, replaces
  the variables, hypotheses and goals only through an explicit button, and then goes through the
  usual "Check setup" and "Start exploring". The review marks a setup that started from an AI
  draft. Every call from one form shares a construction ID.
- **Build library.** Once a background is accepted, "Build library" asks the librarian for general
  results for that background (the button is disabled, with the reason beside it, until a
  background is accepted or when the role is not configured). The result is a list with each
  result's name, its statement rendered in LaTeX and in words, its premises and its description,
  and a "Remove"/"Restore" toggle; a count says how many results are kept and how many generated
  variants come with them. Results that did not pass the checks are collapsed under "N proposed
  results did not pass checks" with plain reasons. "Approve library" records the kept result IDs
  and nothing else; the library is then named by decision in the formalizer call, "Check setup" and
  "Start exploring", listed in the review, and added to the new problem's library when the
  session starts. Changing the selection, building again, or forgetting the background asks for a
  new approval. Notation that kept results add is listed and previewed in the LaTeX fields.
- **Workspace.** When a displayed suggestion list has two or more entries, the workspace ranks its
  first 32 candidates automatically (trigger `automatic`) once the list has stayed displayed for
  about half a second, so quickly changing the selection costs nothing. The ranked picks appear
  above the unchanged list. A visible checkbox, "Rank suggestions with AI automatically", turns this
  off; it is on by default and remembered in the browser (local storage; without storage the choice
  lasts for the page). "Ask AI to rank these" sends the same request with the `explicit-user`
  trigger, and it stays available when automatic ranking is on. Each suggestion list is ranked at
  most once automatically, answers for a list that is no longer displayed are ignored, and nothing is
  sent while a step is being applied. An automatic run that falls back (a `429`, a fallback answer,
  an unreachable service) shows nothing and leaves the deterministic list; an explicit run reports
  the fallback in place. A none-relevant answer shows "None of these suggestions look relevant to
  your selection." above the unchanged list, with "Describe a move" and "Find more results" buttons
  that appear only when the host provides the matching callbacks. The workspace wires "Describe a
  move" to the move-instruction box (below) whenever that box can take a description, and "Find more
  results" to the library top-up (below). The empty suggestions state offers the same "Find more
  results". Read-only sessions, and deployments without a configured shortlister, show no ranking
  controls and send no ranking requests.
- **Move instructions.** A panel beside the proof state (below it on narrower screens) with a text
  box, "Describe a step, e.g. 'split into cases on whether n is even'", and a **Preview** button.
  It is always shown; when the move executor is not configured, the session is read-only, another
  step is being applied, the box is empty, the selections span several goals, or nothing is left to
  prove, the control is disabled and says why in place. The step is about the current selection
  when there is one, otherwise the first open goal. The preview card leads with the composed
  transition class (equivalence, strengthening or weakening) and what that means in plain
  language, then the model's short explanation, the ordered steps with their own classes, and the
  resulting goals, hypotheses and new obligations in the same form as a move preview. **Apply**
  commits the plan (the request names only the stored call); **Discard** drops it. A plan the
  kernel rejects shows the failing step and the kernel's reason and says nothing changed; a model
  that asks for more detail or declines shows its own words. A preview belongs to one proof node
  and is dropped when the proof moves on.
- **Find more results.** The none-relevant notice and the empty suggestions state send the current
  selections as a `no-relevant-results` top-up. The request is announced inline ("Looking for more
  results…"), then answered inline ("Added N results to the library. Ask for suggestions again to
  use them." with an "Ask for suggestions again" button, or the plain reason nothing was added or why
  it failed). Where it cannot work the button is disabled and says why: the library assistant is
  not configured, or the session is read-only. After every change of the current node the workspace
  reads `GET …/library/constants` and requests a `new-constants` top-up, once per constant and page
  load, without review; a rate limit, a disabled role, a stale or empty answer is silent, and only a
  top-up that added results leaves a brief note. Top-ups appear in the library drawer as ordinary
  additions (origin `service`), with no AI badge.
- A role that is not configured shows its control disabled with an explanation.

- **Save as reusable move.** After a described step is applied, the move-instructions panel offers
  "Save as reusable move" inline (with the hint "Turn this step into a general move you can reuse.
  You'll review it before it's added." and a "Not now" dismissal; no dialog). Where it cannot work
  the button is disabled and says why: the move author is not configured, the session is read-only,
  or another step is being applied; a step that is no longer part of the proof is reported in place.
  Clicking requests a proposal (the button reads "Asking the model…"), keeps the checked answer in
  this tab's session storage and opens the existing **Author moves** page on
  `/sessions/:id/moves?proposal=<call ID>`. That page fills the ordinary form from the proposal
  (name, description, selection contract, patterns, plan, examples) and shows beside it a read-only
  panel with how the step motivated the move, the model's classification in plain language, and the
  kernel's result per example (diagnostics beside the example and the field they concern, and the
  generality notes). "Revise with feedback" (a text box and a button, disabled with the reason when
  there is no feedback, no provider or the session is read-only) asks for a revision of the stored
  proposal and replaces the form; the address follows the open proposal. The form stays editable,
  "Save draft" is the existing submit-for-review action and sends the link to the two calls with the
  ordinary `author-move-draft` command, and approval stays the existing human review. Starting the
  form from anything else drops the link; a saved revision that a model proposed shows where it came
  from and keeps the link when revised in the editor. A proposal classed as a new principle cannot be
  saved as a move.

## Transport behaviour

The formalizer uses a non-streaming `stream: false` chat-completions call with a strict JSON
schema. Streaming is not used: the Gateway contract the code relies on documents only the
non-streaming response, so long calls are bounded by the configurable budget above instead.

Each call has one total wall-clock budget (the timeout). Retryable failures are retried up to 3
attempts with exponential backoff plus jitter, honouring `Retry-After`; a wait that would not fit
in the remaining budget is skipped and the failure is reported. A failed call is stored as
`transport-failed` with a safe `subcode` on its diagnostic. Provider text, headers and keys are
never stored or logged.

| Situation                                     | Result                      | Retried |
| --------------------------------------------- | --------------------------- | ------- |
| 200, `stop`, JSON content                     | parsed, then validated      |         |
| 200, `stop`, `refusal` set                    | `declined` output           |         |
| 200, `length`/other finish reason, no content | rejected (`invalid-output`) |         |
| 200, `stop`, empty or non-JSON content        | rejected (`invalid-output`) |         |
| 200, body not JSON                            | `invalid-response`          | no      |
| 429                                           | `rate-limited`              | yes     |
| 408, 5xx                                      | `server-error`              | yes     |
| 401, 403                                      | `auth`                      | no      |
| other non-ok status                           | `bad-request`               | no      |
| fetch rejects without abort                   | `network`                   | yes     |
| total budget exhausted                        | `timeout`                   | no      |
| Jev answer without any confidence             | `missing-confidence`        | no      |
| Jev answer choosing `outcome:none-relevant`   | `none-relevant` outcome     |         |

The Jev Choice question offers every displayed candidate plus one reserved option,
`outcome:none-relevant` ("None of the displayed suggestions is relevant to the selected fragment."),
which no candidate may use as its ID. The returned probabilities must cover exactly the candidates
and that option and sum to one, and the choice must be the most probable one. Choosing the reserved
option with enough confidence is the none-relevant outcome above; with too little confidence it is
a `declined` fallback. Jev returns no free text, so the stored reason is a fixed sentence. The
confidence is extracted from the answer exactly as for any other choice.

Jev confidence is read from the answer, then `providerMetadata.typesafe.confidence.shortlist`, then
a scalar `providerMetadata.typesafe.confidence`. The stored Jev `rawResponse` still embeds the
request envelope (`providerRequest.state`) because output validation compares it with the prepared
call to detect forged state; replacing it with a digest would change that validation and the stored
shape, so it is left as is.

## Read evidence

`GET /proof-sessions/:sessionId/llm-calls[/:callId]` and
`GET /constructions/:constructionId/llm-calls[/:callId]` list or read structured stored records
within the requested owner scope. Records contain role-scoped context, dispatch configuration,
structured output, and diagnostics. Provider credentials and hidden reasoning are not stored.

The current worker has no authentication layer. Owner IDs scope evidence records but do not provide
access control; deploy these routes only behind the application's trusted boundary.
