# AI endpoints

The worker exposes four single-call AI roles: the topic extractor, the proof-state formalizer, the
move shortlister and the move executor. All use the Vercel AI Gateway and persist a validated call
record before returning a proposal. AI responses never execute proof commands or change a proof
session directly; the move executor's plan is committed only by a separate apply request that the
user makes after reading a kernel preview. The other roles of design plan §15.2 (initial librarian,
attestor, background gatekeeper, generality reviewer, stateful proof agent) are not implemented.

## Configuration

Set `AI_GATEWAY_API_KEY` or the existing `AI_API_KEY` variable. The worker does not load dotenv
files itself. For local development with Node 24 and the repository's `tsx` dependency:

```sh
PROOF_STORE=memory node --env-file=.env.local --import tsx apps/worker/src/main.ts
```

For an existing PostgreSQL database, apply migrations `0013_llm_formalizer_role.sql` and
`0017_llm_move_executor_role.sql` before starting the updated worker (0017 widens the stored-role
constraint to `move-executor`; 0015 and 0016 are reserved for other AI lanes, see
`docs/ai-agents-architecture.md`). A single-instance deployment can use
`PROOF_AUTO_MIGRATE=true`; the normal migration runner is `npm run migrate`.

Defaults are `openai/gpt-6-luna` with high reasoning effort and a 32,000 token output limit for the
formalizer, the same model with high reasoning effort and a 16,000 token output limit for the move
executor, the same model with medium reasoning effort and an 8,000 token output limit for topic
extraction, and `typesafe-ai/jev` for shortlisting. Configuration can be overridden with
`PROOF_AI_FORMALIZER_MODEL`, `PROOF_AI_FORMALIZER_REASONING_EFFORT`,
`PROOF_AI_FORMALIZER_MAX_OUTPUT_TOKENS`, `PROOF_AI_EXECUTOR_MODEL`,
`PROOF_AI_EXECUTOR_REASONING_EFFORT`, `PROOF_AI_EXECUTOR_MAX_OUTPUT_TOKENS`,
`PROOF_AI_SHORTLISTER_MODEL`, `PROOF_AI_SHORTLISTER_MIN_CONFIDENCE`, `PROOF_AI_TOPIC_MODEL`,
`PROOF_AI_TOPIC_REASONING_EFFORT`, `PROOF_AI_TOPIC_MAX_OUTPUT_TOKENS`, `PROOF_AI_TIMEOUT_MS`, and
`PROOF_AI_FORMALIZER_TIMEOUT_MS` (the formalizer's total budget; defaults to
`PROOF_AI_TIMEOUT_MS`, itself 120000 ms; raise it for long high-effort generations; the executor
shares `PROOF_AI_TIMEOUT_MS`). The confidence threshold defaults
to `0.55`; Jev's native confidence and candidate probabilities are included in the stored structured
evidence. Missing credentials disable these routes. No model fallback is silently selected.

## Cost guard and status codes

The topic, formalizer, shortlist and move-executor preview routes can trigger paid provider calls,
so they share an in-process limiter: a global cap on
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
| 404    | a topic decision names a call that does not exist for that construction          |
| 409    | stale session or suggestion set; topic decision ID reused or not reviewable;     |
|        | a move-executor plan that is stale, read-only, or not an applicable plan         |
| 413    | request body over 256 KiB                                                        |
| 415    | `Content-Type` is not `application/json`                                         |
| 422    | the model output was rejected or the draft failed admission; nothing was created |
|        | (applying a plan: the kernel rejected a step, `plan-step-failed`)                |
| 429    | cost guard (`Retry-After`)                                                       |
| 503    | `ai-disabled` (no provider configured), transport failure, or uncertain call     |

Unknown `/ai/*` paths are ordinary unknown routes.

## Capabilities

`GET /ai/capabilities` answers `{ "roles": { "topic-extractor": bool, "proof-state-formalizer":
bool, "move-shortlister": bool, "move-executor": bool } }`. A role is `true` only when it has a
configured transport and
evidence storage. No model name, endpoint or credential is disclosed. The web application reads it to
decide which AI controls to enable.

## Suggest topics

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
preferences, approved library layer IDs, and selected library pack IDs. The server resolves the
selected packs from its approved catalog; clients cannot provide library statements, operators, or
sorts directly.

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
`status: "needs-review"` and diagnostics.
The endpoint does not create a proof session or approve the draft. The N26 draft must fit the
existing problem setup schemas for problem text, background, preferences, approved library layers
and packs, and LaTeX goals/hypotheses. `validateProblemDraft` performs the existing parse, sort,
operator, and admission checks before exposing the proof state and review result. Formalizer
evidence belongs to the construction and is available at
`GET /constructions/:constructionId/llm-calls` and
`GET /constructions/:constructionId/llm-calls/:callId`.

Call IDs are immutable within their owner scope. Retrying the same ID and identical prepared call
replays its stored outcome; reusing it for different input or dispatch settings is a conflict. A
changed context should use a new call ID.

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

## Web interface

The web application relays these routes through same-origin proxies (`/api/ai/topics`,
`/api/ai/topics/decisions`, `/api/ai/formalize`, `/api/proof-sessions/:sessionId/ai-shortlist`,
`/api/proof-sessions/:sessionId/ai-execute` and `/api/proof-sessions/:sessionId/ai-execute/apply`),
keeping the worker's status codes, including `429`.

- **New problem.** An optional "AI assistance" section asks for topics and for a drafted setup once
  the problem and background are filled in. Topics are approved or rejected explicitly. Approved
  areas and notation reach the preferences only through "Add these areas and notation to my
  preferences". A drafted setup, even one that needs review, replaces the variables, hypotheses and
  goals only through an explicit button, and then goes through the usual "Check setup" and "Start
  exploring". The review marks a setup that started from an AI draft. Every call from one form
  shares a construction ID.
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
  move" to the move-instruction box (below) whenever that box can take a description; "Find more
  results" has no backend yet and stays unwired. The empty suggestions state offers the same
  optional "Find more results". Read-only sessions, and deployments without a configured
  shortlister, show no ranking controls and send no ranking requests.
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
- A role that is not configured shows its control disabled with an explanation.

Not yet available: "Save as reusable move" after an applied one-off step (architecture §5). The
authoring flow derives a move from steps picked from displayed suggestions (their recorded
selections and menu choices), and a plan applied here is a sequence of raw kernel operations with
neither, so it cannot be turned into an authored-move draft without inventing selections and menu
choices. Recording such plans as macros is a separate change.

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
