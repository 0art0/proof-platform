# AI agent architecture

This document specifies the five AI agents of the problem-to-proof pipeline. It refines design plan
§4.2–§4.5, §12.4, §13 and §15.2, and refinement §7, and is the shared contract for their
implementation. `docs/ai-endpoints.md` documents the routes as they ship.

Every agent below obeys the product invariants in `AGENTS.md`:

- Each call is a single, role-scoped, recorded LLM call (`@proof/llm` envelope → transport →
  validated structured output → stored call evidence).
- No agent output mutates proof state. Proof-state changes go through the command protocol and the
  kernel. Library changes go through explicit library-addition events and the deterministic
  admission gate (`admitLibraryArtifact`).
- Deterministic computation runs first, and every model output is validated deterministically
  before anything uses it.

"Constants" are the platform's existing notion of vocabulary: operator declarations
(`OperatorDeclaration`, including the reserved built-ins) together with the sorts they use. The
"active constants" of a session are its effective operators: the operators declared by its approved
setup (the selected packs, the accepted background's constants, and any library constant the problem
statement itself uses), followed by the constants that committed steps activated by applying a
library result that needs them. Library constants that no step has activated are _available_.

## 1. Background proposer (`background-proposer`)

It supersedes the topic extractor in the new-problem UI. The worker keeps the `topic-extractor`
role, so stored evidence still reads, but the web UI no longer calls it.

- **Input:** the problem statement and optional preferences. On a revision it also receives the
  previous proposal and the user's free-text feedback. A revision is a new call that references the
  previous call ID, so the whole chain is recorded.
- **Output:**
  - a background profile (the existing `backgroundProfileSchema`: level, summary, assumptions,
    domains, maximum level), presented as the background relative to which the proof will be
    motivated;
  - a list of constants. Each constant is either a reference to an existing operator (a reserved
    built-in, or one from an approved pack or the global registry) or a new operator declaration
    with signature, LaTeX and natural-language presentation;
  - for each constant, a one-line rationale.

  The proposer must choose constants so that the problem can be formalized using only them; the
  system prompt says so.

- **Validation:** every constant parses as an `OperatorDeclaration`, there are no duplicates or
  symbol clashes, and every sort is a known sort ID.
- **UI:** the user enters only the problem, then clicks "Propose background". The page shows the
  background and the constants with their rationales, plus a feedback box ("Revise with feedback")
  and an "Accept" button. Accepting fills the existing background fields and records an approval
  decision, like the existing topic decision. The fields stay editable by hand.

## 2. Library agent (`librarian`)

- **Input:** the background profile, the constants to cover, and a request kind:
  - `initial`: all active constants.
  - `new-constants`: the old active constants plus newly activated constants. Requested results
    involve the new constants together with the old ones, as well as the new constants alone.
  - `no-relevant-results`: the active constants plus a minimal, abstracted description of the
    local situation (selection fragments and their sorts only, per §15.3; never the original
    problem or proof history).

  In every kind the agent also receives the names and statements of the results already in the
  session library, so that it does not duplicate them.

- **Output:** library results in the library's existing result shape: MathJSON statement,
  premises, application directions and patterns, name, description, and background
  classification. Definitions may be included where the library schema supports them. Output is
  capped, at most 40 results per call. The agent may also return new constant declarations that
  the results need; each must be justified.
- **Admission:** every result goes through `admitLibraryArtifact` in the session's (or
  construction's) operator environment and background profile. Rejected items are recorded with
  their diagnostics and are not added. Deterministic variant generation (`generateVariants`) runs
  on admitted results.
- **Initial library (setup):** the results are shown on the new-problem page as a reviewable list.
  The user can remove entries, then approves the remaining set in bulk. The approved set becomes
  the problem's `layer:initial-problem` content and is passed to the formalizer as its approved
  library, alongside any packs.
- **Top-ups (during proof):** these are admitted automatically, with no user review step, as
  recorded library-addition events in `layer:proof-time-background` (origin `service`). The UI
  shows them as ordinary library additions, without an "AI" disclaimer badge. Their provenance is
  still stored and exported. Earlier suggestion menus are never rewritten (§12.4).
  - **New-constant trigger:** when a committed step applies a library result whose operators
    include a constant that is not active, that constant becomes active through a recorded
    activation, and a `new-constants` top-up is requested automatically.
  - **No-relevant-results trigger:** this is user-initiated, from the empty suggestion state or
    from the shortlister's "none relevant" outcome. The button reads "Find more results".

## 3. Formalization agent (`proof-state-formalizer`, existing)

This agent is unchanged except for its context. It receives the approved constants (as
`approvedLibrary.operators`/`sorts`) and the approved initial library. Its system prompt requires
it to formalize using only those constants. Any operator in the draft that is not among them is a
validation diagnostic, `unapproved-constant`, and the draft returns `needs-review`.

## 4. Move shortlister (`move-shortlister`, existing role)

- It runs automatically, with Jev, when the user's selections produce a displayed suggestion list
  of two or more entries. A per-user toggle, remembered locally, turns this off. The explicit "Ask
  AI to rank these" path remains. It is subject to the existing cost guard; on a `429` it falls
  back silently to the deterministic list.
- **Output gains a `none-relevant` outcome:** Jev may answer that no displayed candidate is
  relevant to the selections. This is a validated outcome, distinct from a refusal or a low
  confidence. The UI then says that none of the suggestions look relevant and offers:
  - "Describe a move" (it focuses the move-instruction box, §5);
  - "Find more results" (a library top-up, §2).

## 5. Move performer (`move-executor`)

- **Input (minimal context, §15.3):** a natural-language move description, either from the user's
  move-instruction box or from a shortlisted technique; the current selections; the target goal or
  obligation sequent, restricted to the declarations and hypotheses it uses; the active constants;
  and the IDs and statements of approved library results relevant to the selections. The input
  never includes the original problem, other branches, or alternative suggestions.
- **Output:** an ordered sequence of kernel operations, at most `MAX_PLAN_STEPS` (16), in the
  kernel's operation schema minus the state IDs, which the worker assigns. The output may instead
  be `insufficient-context` or `declined`. The executor may not emit `mark-sorry` or
  `close-by-accepted-inference`: sorries remain user-selected, and attestation is a separate role.
- **Preview:** the worker runs the sequence through the kernel against the current state (the
  `planMoveSequence` path). It returns either the resulting state, the composed transition class
  (equivalence, strengthening or weakening, shown prominently) and the new obligations, or the
  first failing step with its kernel diagnostic. Nothing is committed.
- **Apply:** only on the user's confirmation. The previewed operations are committed as a
  sequence of ordinary commands through the command protocol. This is the same path as authored
  macros. The commands carry provenance that references the executor call: `user-proposal` for a
  box instruction, `minimal-context-llm` otherwise. If the session moved on since the preview, the
  apply is rejected as stale.
- **UI:** a "Move instructions" text box sits next to the proof state, with the placeholder
  "Describe a step, e.g. 'split into cases on whether n is even'". It shows Preview, then the
  diff/preview card, Apply, and Discard. After an applied one-off step, a "Save as reusable move"
  button creates an authored-move draft from the applied operations through the existing
  `author-move-draft` command. That draft goes through the existing review; nothing is auto-promoted.

## Configuration defaults

| Role                | Model               | Effort | Max output | Env prefix             |
| ------------------- | ------------------- | ------ | ---------- | ---------------------- |
| background-proposer | `openai/gpt-6-luna` | medium | 8,000      | `PROOF_AI_BACKGROUND_` |
| librarian           | `openai/gpt-6-luna` | high   | 32,000     | `PROOF_AI_LIBRARIAN_`  |
| formalizer          | unchanged           |        |            |                        |
| move-shortlister    | `typesafe-ai/jev`   |        |            | unchanged              |
| move-executor       | `openai/gpt-6-luna` | high   | 16,000     | `PROOF_AI_EXECUTOR_`   |

Each new role adds `<PREFIX>MODEL`, `<PREFIX>REASONING_EFFORT` and `<PREFIX>MAX_OUTPUT_TOKENS`,
reports itself in `GET /ai/capabilities`, and shares the cost guard. A role whose transport is not
configured disables its UI controls, and each disabled control explains why.

## Migrations

These numbers are pre-assigned so that parallel work does not collide. Each migration widens
`llm_calls_role_check`, as 0013 does.

- `0015_llm_background_proposer_role.sql`
- `0016_llm_librarian_role.sql`
- `0017_llm_move_executor_role.sql`

Because the lanes are developed in parallel, each migration's role list must include every role
that exists on its own branch. The final merge reconciles the lists, so the last-applied migration
lists all roles.

## Implementation status

All five agents are implemented; `docs/ai-endpoints.md` documents the shipped routes. Differences
from the sections above:

- **Constants (§1, §2).** Constants are always full operator declarations. A constant with an
  existing operator's symbol and signature is treated as a reference to it; the proposer is shown
  the registry's operators so it can reuse them. A constant that clashes with the registry is
  refused when the background is accepted.
- **Setup wiring (§1–§3).** The accepted background and the approved library are passed to the
  formalizer, the setup check and the session approval as references (`approvedBackground`,
  `approvedLibrary`); the worker resolves them from stored decisions.
- **Initial library (§2).** Approved results are recorded as `layer:initial-problem` additions
  right after the session is created, with deterministic event IDs, rather than in the same
  transaction; repeating the approval completes an interrupted recording. Session results from
  `initial-problem` and `proof-time-background` join the session's single retrieval and
  application catalog.
- **Top-ups and constants (§2).** A library result may carry operator declarations it needs that
  the session's effective operators do not declare (`operators` of the library result; its variants
  carry them too). These are the session's _available_ (dormant) library constants. The approved
  initial library's new constants are available unless the problem statement itself uses them, in
  which case they are setup operators. A top-up's `newConstants` are no longer rejected: each is
  validated deterministically (schema, known sorts, no identifier, symbol or LaTeX-trigger clash
  with active constants, available constants, packs or the registry unless identical), and the
  admitted results carry the ones they apply. When a committed step applies a result that needs an
  available constant (an `apply-result-*` step, a rewrite using a result, or a macro, executor or
  agent step that does), the command service appends an append-only _constant activation_ record in
  the step's own transaction, before the step is stored (table `proof_constant_activations`,
  migration `0018`). The step is validated in the effective operators extended with the constant,
  so a refused step records nothing. Activation is monotonic: backtracking and deleting the step
  keep it. A session's effective operators are its setup operators followed by its activations;
  they are used wherever the session's operators are (parsing, node and preview schemas, the kernel
  environment, the move executor, the librarian's "active constants", export). Retrieval offers
  results whose operators are effective or available, and a preview that would activate a constant
  names it (`MovePreview.constants`). `GET /proof-sessions/:id/library/constants` reports
  `{ active (setup or activated), available, activated }` from the records; the web application
  lists them in a "Constants" panel and requests one `new-constants` top-up per newly activated
  constant (a rate-limited request is retried once at a later step). Artifacts carry
  `constantActivations`; import re-derives every step's activations and detects a removed, added or
  moved record. The earlier derivation from retained edges (`metadata.libraryConstants`) is gone.
- **Shortlister (§4).** Jev answers a choice question, so "none relevant" is a reserved option
  next to the candidates. Automatic ranking uses its own `automatic` trigger.
- **Move performer (§5).** The worker assigns commands from the call (`command:<callId>:step:<i>`),
  and each command carries a `proposal` link to the executor call. Its `source`
  (`user-instruction` or `shortlisted-technique`) is claimed by the client.
- **Not yet built: "Save as reusable move" (§5).** Authored moves are derived from steps picked
  from displayed suggestions, with recorded selections and menu choices. An executor plan is a
  sequence of raw kernel operations with neither. Turning one into a general template needs the
  prose move-authoring workflow (refinement §7.1, a move-author/generality-review role), which is a
  separate change.
- **Stored evidence.** Prompts changed for the formalizer, shortlister, background proposer and
  librarian; each still accepts its previous system message on read, so earlier call records stay
  readable.
