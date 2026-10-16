# AI endpoints

The worker exposes four single-call AI roles: the background proposer, the topic extractor, the
proof-state formalizer and the move shortlister. All use the Vercel AI Gateway and persist a
validated call record before returning a proposal. AI responses never execute proof commands or
change a proof session directly. The other roles of design plan §15.2 (initial librarian, move
executor, attestor, background gatekeeper, generality reviewer, stateful proof agent) are not
implemented. The agent architecture is specified in `docs/ai-agents-architecture.md`.

The background proposer supersedes the topic extractor in the new-problem page: the web
application no longer calls the topic routes. The worker keeps the `topic-extractor` role and its
routes, so stored topic evidence still reads.

## Configuration

Set `AI_GATEWAY_API_KEY` or the existing `AI_API_KEY` variable. The worker does not load dotenv
files itself. For local development with Node 24 and the repository's `tsx` dependency:

```sh
PROOF_STORE=memory node --env-file=.env.local --import tsx apps/worker/src/main.ts
```

For an existing PostgreSQL database, apply migrations `0013_llm_formalizer_role.sql` and
`0015_llm_background_proposer_role.sql` before starting the updated worker (0015 widens the
`llm_calls` role constraint; background decisions reuse the `llm_topic_decisions` table). A
single-instance deployment can use `PROOF_AUTO_MIGRATE=true`; the normal migration runner is
`npm run migrate`.

Defaults are `openai/gpt-6-luna` with high reasoning effort and a 32,000 token output limit for the
formalizer, the same model with medium reasoning effort and an 8,000 token output limit for the
background proposer and for topic extraction, and `typesafe-ai/jev` for shortlisting.
Configuration can be overridden with
`PROOF_AI_FORMALIZER_MODEL`, `PROOF_AI_FORMALIZER_REASONING_EFFORT`,
`PROOF_AI_FORMALIZER_MAX_OUTPUT_TOKENS`, `PROOF_AI_SHORTLISTER_MODEL`,
`PROOF_AI_SHORTLISTER_MIN_CONFIDENCE`, `PROOF_AI_BACKGROUND_MODEL`,
`PROOF_AI_BACKGROUND_REASONING_EFFORT`, `PROOF_AI_BACKGROUND_MAX_OUTPUT_TOKENS`,
`PROOF_AI_TOPIC_MODEL`, `PROOF_AI_TOPIC_REASONING_EFFORT`,
`PROOF_AI_TOPIC_MAX_OUTPUT_TOKENS`, `PROOF_AI_TIMEOUT_MS`, and `PROOF_AI_FORMALIZER_TIMEOUT_MS`
(the formalizer's total budget; defaults to `PROOF_AI_TIMEOUT_MS`, itself 120000 ms; raise it for
long high-effort generations). The confidence threshold defaults
to `0.55`; Jev's native confidence and candidate probabilities are included in the stored structured
evidence. Missing credentials disable these routes. No model fallback is silently selected.

## Cost guard and status codes

The background, topic, formalizer and shortlist routes can trigger paid provider calls, so they
share an in-process limiter: a global cap on
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
|        | with the operator registry; approved background decision that was rejected       |
| 413    | request body over 256 KiB                                                        |
| 415    | `Content-Type` is not `application/json`                                         |
| 422    | the model output was rejected or the draft failed admission; nothing was created |
| 429    | cost guard (`Retry-After`)                                                       |
| 503    | `ai-disabled` (no provider configured), transport failure, or uncertain call     |

Unknown `/ai/*` paths are ordinary unknown routes.

## Capabilities

`GET /ai/capabilities` answers `{ "roles": { "topic-extractor": bool, "background-proposer": bool,
"proof-state-formalizer": bool, "move-shortlister": bool } }`. A role is `true` only when it has a
configured transport and evidence storage. No model name, endpoint or credential is disclosed. The web application reads it to
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

## Check and approve a setup with approved constants

A drafted (or hand-entered) setup that applies approved constants can only be checked and approved
when the request names the approval:

- `POST /problem-drafts/validate` accepts `{ "draft": ..., "approvedBackground": { "constructionId":
"...", "decisionId": "..." } }`;
- `POST /proof-sessions` accepts the same optional `approvedBackground` beside `sessionId`, `draft`
  and `reviewedDigest`.

The worker resolves the constants from storage and adds them to the session's operators after the
selected packs' operators; the stored session therefore declares them like any pack operator. The
reviewed digest covers the operators, so approving with other constants than the review used is a
stale review (`409`). A missing decision is `404`, a rejected one `409`, and a field other than
`constructionId` and `decisionId` in the reference is `400`. Without the reference, the constants
are unknown to the setup, and a draft that uses them is invalid (`422`).

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
offer "Describe a move" and "Find more results" (`docs/ai-agents-architecture.md` §4); neither
action exists on the worker yet.

This endpoint records an immutable LLM call record but does not preview or apply any move. Human or
agent actions still go through the existing proof command protocol.
Shortlist evidence is session-owned and included in exported session artifacts under `llmCalls`.
Construction-owned formalizer evidence is available through its construction evidence route; it is
not implicitly attached to a later proof-session artifact.

## Web interface

The web application relays these routes through same-origin proxies (`/api/ai/background`,
`/api/ai/background/decisions`, `/api/ai/formalize` and
`/api/proof-sessions/:sessionId/ai-shortlist`), keeping the worker's status codes, including `429`.
`/api/problem-drafts/validate` and `/api/proof-sessions` also pass the optional
`approvedBackground` reference. The topic routes are no longer relayed.

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
  that appear only when the host provides the matching callbacks (they are not wired yet). The empty
  suggestions state offers the same optional "Find more results". Read-only sessions, and
  deployments without a configured shortlister, show no AI controls and send no AI requests.
- When a role is not configured, its control is disabled with an explanation.

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
