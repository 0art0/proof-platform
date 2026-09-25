# Non-AI feature roadmap

Durable TODO list for every deterministic (no LLM) capability in
[`platform-design-plan.md`](../platform-design-plan.md) and
[`platform-design-refinement.md`](../platform-design-refinement.md) that is not yet implemented.
It was produced on 2026-09-25 from an audit of `main` at `618c1cf`. The agentctl roadmap is not used for this work.

LLM roles (topic extraction, librarian, formalizer, shortlister, executor, attestor, gatekeeper, generality
reviewer, move proposal, stateful agent memory) are out of scope. Where an AI feature has a deterministic
substrate — for example the record an attestation is stored in, or the manual path that an LLM would
otherwise automate — the substrate is in scope.

## Status legend

- `[ ]` not started · `[~]` in progress · `[x]` done (commit noted) · `[-]` deferred (reason noted)

## Ground rules for every task

- Plain MathJSON stays authoritative; boxing and canonicalization are transient.
- Every proof-state mutation goes through the kernel (`applyTransition`) and the single command path
  (`prepareProofCommand` → worker repository `executeProofCommand`). No UI or route writes state directly.
- Equivalence, strengthening, weakening, background inference, and sorry remain visibly distinct.
- History is static. Stored snapshots and displayed menus are never recomputed for viewing.
- Match existing conventions: zod v4 `.strict()` schemas with branded ids, discriminated `{ok, diagnostics}`
  results, frozen outputs, and vitest tests. Mathematical-core changes need property (fast-check), golden,
  or invariant tests.
- Checks per task: `./scripts/pnpmw run lint`, `./scripts/pnpmw run typecheck`, `./scripts/pnpmw run test`,
  and `./scripts/pnpmw exec prettier --check .`. No live PostgreSQL is available in the development
  sandbox. Persistence is tested through the existing fake `SqlClient` and the in-memory store.

## Reusable work from the agentctl setup

Unmerged agentctl task worktrees live under `.worktrees/` in the canonical checkout.

- `add-classical-case-split-and-398e39ef`: kernel primitives `close-reflexive-equality`,
  `split-classical-cases` and `add-temporary-hypothesis` (weakening), reviewer-approved. The task was
  blocked only because `packages/moves` lacked mappings for the new kinds. It is imported as the start of
  N08/N09.
- `wire-mathlive-gesture-select-a21c632f`: `SelectionGestureOutcome` feedback (replaced / expanded /
  saturated / added / removed / overlap-rejected / cleared) and a `repeatable` flag in
  `apps/web/src/features/proof-workspace/selection-state.ts`. Reuse it in N29 for snapping feedback.
- `resume-and-fix-stored-sessio-8e5b6321`: `postgres-proof-store.ts` releases the pg client with
  `release(true)` (discard) when a transaction fails. This is not on main; fold it into N36.

## Phase 0 — Local operability

- [x] **N00 In-memory proof store and worker mode.** Promote the test-only `MemoryProofStore` to a
      production `ProofStore` implementation in `apps/worker`. Select it with `PROOF_STORE=memory`, and seed
      the development session on startup. Add a Playwright config that runs `proof-workspace.spec.ts`
      against the memory worker, so e2e tests run without Postgres. _Accept:_ the worker starts with no
      database, and the memory store passes the same repository test-suite as today.

## Phase 1 — Mathematical representation (packages/mathjson-model, packages/language)

- [ ] **N01 Term-language breadth (§5.2, §5.4).** Statement/term validation for `Function`/lambda
      literals with typed parameters, application of function-valued expressions (`Apply` and applied
      function variables), `Tuple`, `Set`/`List` literals, `Sequence`/indexing, typed quantifier binders
      (`["ForAll", ["Element", x, S], body]`), and binder operators `Sum`, `Product`, `Integrate`, `Limit`
      through `BinderSpecification`. Higher-order sort checking includes quantification over function and
      predicate sorts. Substitution and free-name analysis must honour the new binders. _Accept:_ fast-check
      properties for capture avoidance under every binder kind, plus golden validation cases.
- [x] **N02 Custom operator presentation metadata (§5.5).** Add optional presentation metadata to
      `OperatorDeclaration`: display name, LaTeX serialization template with a precedence/fixity class,
      optional LaTeX parse trigger, natural-language template(s), and domain/notation tags. Validate that
      template placeholders match arity and binder slots. Existing declarations without metadata stay
      valid. _Accept:_ schema tests for good and bad templates.
- [x] **N03 Deterministic LaTeX dictionary (§6.1).** `packages/language`: a MathJSON→LaTeX serializer that
      handles precedence and parenthesization for logical and relational constructors, arithmetic,
      quantifiers and the new binders, and delegates unknown standard heads to the Compute Engine (raw form).
      It renders custom operators from their N02 templates. Add a central registry used by the web app
      in place of the bare `renderMathJson`. _Accept:_ golden tests and a round-trip parse test for
      operators with parse triggers.
- [x] **N04 Deterministic natural-language renderer (§6.2).** Compositional renderer covering statement
      constructors, relations, quantifier phrasing with sort nouns ("for every real number x"), binder naming
      and referring expressions, plurality and article agreement, and precedence-aware grouping. Add exact
      MathJSON→text entries, pattern templates with wildcards, operator templates (N02), domain terminology
      packs, and problem-local overrides. Precedence order: override > exact > pattern > operator >
      constructor. _Accept:_ golden tests; rendering is total, with a fallback to LaTeX-in-text.
- [ ] **N05 Session-level mathematical context (§7, §11).** Move `backgroundProfileSchema` into
      `packages/library` and re-export it from `llm`. Add `ProofState.assumptions`: universally closed
      additional assumptions, each with origin (sorry id, source goal/obligation) and a `StatementView`.
      Add obligation provenance (`premise-of-result`, `side-condition`, `user`, `case`), a transition
      evidence kind (`structural`, `library-result`, `background-inference`, `sorry`), and a proof-session
      metadata schema (problem statement, background profile, active library layer ids). _Accept:_
      schema tests; existing stored states still parse.

## Phase 2 — Kernel completion (packages/kernel)

- [ ] **N06 Apply approved library results (§9, §12).** Add a `KernelEnvironment.results` catalog of
      structurally described results (parameters, premises, conclusion, directions). Add kernel operations:
  - `apply-result-backward`: instantiate a result so its conclusion matches a goal or obligation
    conclusion (exactly, up to alpha-equivalence). Its premises and side conditions become new goals or
    obligations in the same context. The transition is strengthening, or equivalence when the result is
    an `Equivalent`.
  - `apply-result-forward`: instantiate using hypotheses as premises and add the conclusion as a derived
    hypothesis. The transition is equivalence; an unmet premise becomes an obligation.

  Instantiations are validated for sort and scope. Evidence kind is `library-result` with the artifact id.
  _Accept:_ invariant tests; a result whose premise does not match is rejected with a specific diagnostic.

- [ ] **N07 Obligations and sorries (§11).** Add these operations:
  - `discharge-obligation`: close an obligation through the usual closers, since obligations are already
    closable targets. Verify this and make it explicit.
  - `mark-sorry`: remove a goal or obligation and append its universal closure to `assumptions`. The
    closure is `ForAll x1..xn, (H1 ∧ … ∧ Hk) ⇒ G`, restricted by dependency analysis to the variables and
    hypotheses that `G` transitively depends on through shared free symbols.
  - `close-by-assumption`: close a target by an additional assumption, instantiating its universal closure.

  Evidence kind is `sorry`. _Accept:_ fast-check properties that the closure is closed (no free symbols)
  and minimal under the dependency rule, plus golden cases.

- [x] **N08 Classical case split, contradiction, accepted inference (§9, §16.3).** Add these operations:
  - `case-split`: split on any well-formed proposition `P` over the target's context. Produce two targets
    with hypotheses `P` and `Not P`. The transition is equivalence.
  - `close-by-contradiction`: close from hypotheses `P` and `Not P`.
  - `close-by-hypothesis`: extend it to alpha-equivalence.
  - `close-by-accepted-inference`: close a target and record an external attestation reference id with
    evidence `background-inference`. The kernel does not judge the attestation; it records it.

  _Accept:_ tests for each operation and for stale/invalid inputs.

- [x] **N09 Weakening and strengthening primitives (§10).** Add these operations:
  - `assume-hypothesis`: add an arbitrary proposition as an unproved hypothesis. The transition is weakening.
  - `replace-goal`: replace the conclusion with an arbitrary proposition. The transition is weakening
    unless the operation is `suffices`.
  - `suffices`: replace goal `G` with `P` and add obligation `P ⇒ G`. The transition is strengthening.
  - `drop-hypothesis`: remove a hypothesis. The transition is strengthening.

  _Accept:_ each operation's class is asserted by tests; `planMove` classes stay consistent.

- [ ] **N10 Deep, polarity-aware rewriting (§7.1, §9, §8.2).** Add these operations:
  - Rewrite with an `Equivalent` hypothesis or result at any proposition position. The transition is
    equivalence.
  - Rewrite with an implication `A ⇒ B`. Replacing `B` by `A` in a positive position is strengthening,
    and replacing `A` by `B` in a negative position is also strengthening. In a mixed position the rewrite
    is rejected.
  - Rewrite at an associative selection lens (contiguous operand range) using `packages/selections`
    splice.

  Polarity is computed by the same function the selection resolver uses (move it into mathjson-model or
  kernel, whichever keeps dependencies acyclic). _Accept:_ polarity property tests and golden rewrites.

- [ ] **N11 Construction metavariables (refinement §5).** Add construction-task records with these fields:
      origin (existential goal or auxiliary request), sort, scope, allowed dependencies, requirements, and
      status (unresolved / partially specified / resolved / abandoned).
  - Each requirement has a role (necessary / sufficient / heuristic), evidence, and the attempt that
    produced it.
  - Candidates are also recorded.
  - Kernel operations:
    - `introduce-placeholder`: replace an existential goal's witness with a registered placeholder operator.
    - `add-requirement`.
    - `resolve-placeholder`: substitute through dependent statements; check scope, dependencies (transitive,
      acyclic) and signatures; the remaining sufficient requirements become obligations.
    - `abandon-placeholder`.

  Draft states may hold placeholders. Necessary and heuristic requirements can never close a task.
  _Accept:_ tests for illegal and cyclic dependencies, and a check that a heuristic requirement never
  becomes a hypothesis.

## Phase 3 — Library, moves, retrieval

- [ ] **N12 Library store, layers, admission, derived results (§12.4).** Add a `LibraryRepository` (memory +
      Postgres, migration `0003`) for artifacts, variant families, layers (global / initial-problem /
      proof-time-background / derived / move-discovery-draft), and the global persistent operator registry.
  - Library-addition events record the artifact, layer, origin, background classification and approval.
  - The deterministic background-admission gate works in three steps. An artifact whose
    domains/level exceed the session background profile is rejected unless the profile is first revised
    by a recorded revision event.
  - Derived-result registration from a closed proof node carries its node dependency and retained
    assumptions (conditional-lemma extraction, refinement §9).

  _Accept:_ repository tests with the fake SQL client and a test that the gate rejects out-of-background
  results.

- [x] **N13 Deterministic variant generation (§12.3).** Generate contrapositive, converse (for
      equivalences), symmetric equality orientation, curried/uncurried premise bundling, and
      forward/backward forms as separate indexed artifacts in one variant family, with provenance
      `derived-variant`. _Accept:_ each generated variant is validated, and the family groups it.
- [ ] **N14 Result-application moves, plans, parameter menus (§13, §14.5, §17.4).** Moves become able to:
  - wrap N06 result application, N07 sorry, N08 case split, N09 weakening/strengthening, and N10 deep
    rewriting;
  - run multi-operation plans, validated atomically in sequence;
  - offer parameter menus generated from context only: disjunct index, instantiation terms (in-scope terms
    of matching sort drawn from the snapshot and selections), existential witnesses, rewrite direction and
    occurrence, and case-split propositions drawn from selected statements.

  Worker `materializeKernelOperation` must support every input-requiring move through menu choices.
  Arbitrary expression payloads are rejected (refinement §11). _Accept:_ the four previously unappliable
  moves are applicable via menu choices, end-to-end in the worker tests.

- [ ] **N15 Discrimination tree and filtering (§14.1–§14.3).** Replace the one-level key with a real
      discrimination tree over preorder operator/arity paths with wildcard edges. Add secondary keys for
      polarity, section, and semantic role.
  - Typed unification against declared sorts.
  - Side-condition evaluation: a premise already available as a hypothesis creates no obligation;
    otherwise it becomes an obligation and lowers the rank.
  - Near-miss suggestions ("applies if …") in a separate category, with deterministic category diversity.

  _Accept:_ completeness tests (tree retrieval ⊇ brute-force matching on random patterns) and a
  performance test (≤150 ms query on a 1000-artifact catalog).

- [ ] **N16 Starter domain packs and elementary corpus (§21.5, Stage 2 exit).** Hand-author approved
      results with variants for elementary logic, equality, order (transitivity, antisymmetry, monotonicity
      of addition), basic arithmetic identities, and sets (subset transitivity, union/intersection
      membership). Add a benchmark corpus of at least 8 elementary problems, each solved deterministically
      through the protocol layer by a scripted sequence of displayed suggestions. _Accept:_ corpus test
      proves every problem solved.

## Phase 4 — Discovery tree

- [ ] **N17 Solved status, provability route, pruned proof (§16.5).** Pure functions over the stored
      tree:
  - a target is closed when every goal is discharged through equivalence/strengthening edges, including
    all case branches;
  - `solved(session)` reports the solution relative to background inferences and sorry assumptions;
  - the pruned proof is the minimal retained subtree along the chosen successful route, keeping its cases,
    dependencies, derived results, and universally closed assumptions.

  Weakening edges never count. _Accept:_ tests with weakening-only branches, partial case closure, and
  multiple alternative routes (choose the first-completed, documented).

- [ ] **N18 Delete previous move (§16.2).** Add a repository command that removes the latest edge and child
      at the current leaf. If descendants exist, it requires `confirmDescendants`. The cursor returns to
      the parent, and deleted work is removed from history and export while a tombstone audit row is kept.
      _Accept:_ tests covering leaf and with-descendants cases.
- [ ] **N19 Interaction events and preview coherence (refinement §12).** Add an ordered, node-anchored
      interaction-event log: selection changed, suggestions requested/displayed, preview requested, preview
      rejected, menu expanded, focus/objective changed, and "interaction ended without action".
  - Previews record content hashes of the library/move definitions they used.
  - Apply regenerates the preview (recorded) instead of applying stale definitions.

  _Accept:_ tests for ordering, idempotency, and the stale-definition path.

- [ ] **N20 Backtracking with information (§16.3).** Given a proposition `P` from a descendant snapshot:
  - compute its free symbols, operators, and definitions;
  - find the closest ancestor where all are available, and list the other eligible ancestors;
  - create a new child of the chosen ancestor via `case-split` on `P`, auto-closing a case whose goal is
    `P` itself;
  - focus the remaining open case, leaving the original branch intact.

  _Accept:_ tests for ancestor choice, unavailable-symbol rejection, and the auto-close case.

- [ ] **N21 Semantic replay (§16.4).** Record every applied step as a semantic plan: the move/result id,
      selections described by statement role + pattern match rather than raw paths, and parameters by menu
      origin. Replay a sequence onto a target node, re-matching each step. The report lists adapted steps,
      changed substitutions, new obligations, the first failure, and candidate repairs (alternate matching
      selections). Commit creates fresh nodes. _Accept:_ tests for replay onto an alpha-renamed/perturbed
      state and a failing step.

## Phase 5 — Inquiry language (refinement §3–§4, §6)

- [ ] **N22 Inquiry records and store.** Add these records:
  - Questions (`Establish`, `Construct`, `Determine`, `Explore`), Objectives, Attempts, Requirements,
    Observations, Obstructions, and Decisions.
  - Relationships: `wouldSufficeFor`, `requires`, `motivatedBy`, `addresses`, `specializes`,
    `generalizes`, `tests`, `reuses`.
  - Reason provenance: explicit-user / agent / method-encoded / later-interpretation.

  Records reference MathJSON and proof nodes rather than copying them. Add commands through the single
  command service and persistence (migration). _Accept:_ schema invariants (e.g. `wouldSufficeFor` needs
  evidence or an explicit informal status; later interpretations are never contemporaneous).

- [ ] **N23 Deterministic explanation templates (refinement §3.4).** `packages/language` renders the
      template sentences over inquiry records using N04 for the mathematics. _Accept:_ golden tests.
- [ ] **N24 Method-created records and failure diagnostics (refinement §3.4, §6).** Add these behaviours:
  - Choosing "Try this theorem" creates an Attempt with missing-premise Objectives automatically.
  - Failed premise matches produce Obstructions naming the specific unmet condition.
  - Hypothesis-role investigation creates a `Determine` question for the statement with that hypothesis
    removed.
  - Conditional-lemma extraction ties into N12.

  _Accept:_ tests; no intention is attributed unless the action's stated semantics imply it.

## Phase 6 — Protocol, agent API, problem entry

- [ ] **N25 Complete command protocol (§18, §20.3).** Add one command envelope for every mutation: kernel
      operations with menu-sourced parameters, case split, sorry, delete, backtrack (cursor and with
      information), replay, library addition, and inquiry commands.
  - Stable compact aliases per snapshot (`g1`, `h2`, `s1`, `m3`).
  - Observe full / summary / delta-since-event.
  - Worker HTTP routes plus web proxy routes.
  - Payload-source enforcement: new mathematical content only from setup, approved generators,
    validated operations, or reviewed authoring.

  _Accept:_ HTTP tests; an agent-style scripted session completes an N16 corpus proof over HTTP.

- [ ] **N26 Manual problem and session creation (§4.1, §4.4 without LLM).** Add an API and landing page to
      create a problem with a statement, background profile, and domain/notation preferences, then
      manually enter an initial proof state. Declarations are chosen from sort menus; hypotheses and goals
      are entered as LaTeX parsed through the Compute Engine or as MathJSON. The user picks library layers
      and packs, reviews, and approves; only approval creates the root node. The landing page has three
      actions: new problem, upload artifact, fetch stored proof. _Accept:_ route tests and a component
      test for the approval gate.

## Phase 7 — Artifact

- [ ] **N27 Export / import (§19).** Add a versioned artifact schema covering all non-AI §19.2 sections:
      problem setup, library layers and addition events, initial state, the full tree with snapshots,
      selections, displayed menus, previews, edges and events, interaction events, inquiry records,
      solved status, pruned proof, sorry assumptions, final library, and translation dictionary. LLM call
      records are included if present. Add an exporter from the store, and an importer with full
      revalidation that creates a read-only session. Add upload and fetch APIs. _Accept:_ round-trip
      tests; a tampered artifact is rejected.
- [ ] **N28 Static viewers (§4.6, §16).** Add a full discovery-tree viewer, chronological playback, and a
      pruned-proof viewer (LaTeX and natural language, with the sorry assumption list and links to
      motivating inquiry records). All views read only stored snapshots. _Accept:_ tests assert no kernel,
      retrieval, or rendering-of-history recomputation of menus.

## Phase 8 — Human interface (apps/web)

- [ ] **N29 Workspace chrome and accessibility (§17.1).** Add:
  - a header with problem title, background summary, solved status, and branch breadcrumb;
  - colour families (variables red, hypotheses orange, goals blue, obligations/assumptions purple) plus
    polarity bevels, reinforced by icons, outlines, and labels;
  - an Escape key that clears selections;
  - a LaTeX/NL toggle, a raw MathJSON view, and "copy state JSON".
- [ ] **N30 Suggestion panel completion (§17.3).** Add:
  - result-application cards;
  - parameter menus for input-requiring moves;
  - expandable variant groups;
  - provenance and evidence badges;
  - previews rendered as LaTeX/NL state differences rather than JSON;
  - near-miss category and obligations display.
- [ ] **N31 Toolbar actions (§17.2).** Add delete previous move (with descendant confirmation),
      backtrack-with-information dialog, replay-a-sequence-here dialog, mark sorry, case split on
      selection, export, and open full tree.
- [ ] **N32 Library drawer (§17.1).** Add a drawer with layers, search/filter by kind and domain,
      artifact detail views (statement, premises, directions, variants, provenance, approval), and addition
      events.
- [ ] **N33 Abstraction and drag gestures (§8.3).** Add an abstract-selection gesture that turns a selection
      into a typed wildcard for retrieval only. Add drag gestures that show a preview before commit:
      result → expression (deep apply/rewrite), hypothesis → goal (use/specialize/rewrite), and term →
      binder or argument slot (instantiate).
- [ ] **N34 Inquiry and construction panels (refinement §10).** Add a compact inquiry panel (active
      objective, current attempt, unresolved constructions, top obstruction or requirement) and the actions
      "Use this", "Construct an object", "Find sufficient conditions", "Investigate this hypothesis", and
      "Try this method". Add a construction-task view with requirements by role.
- [ ] **N35 Move authoring without AI (§13.1, refinement §7).** Add:
  - a visual move-template editor: selection contract, patterns picked from selections, parameters from
    menus, required artifacts, plan as a kernel-operation sequence, class, and examples;
  - validation of examples by running the plan;
  - a draft → approved workflow with recorded review;
  - macro moves built from a recorded step sequence (N21 plans);
  - persistence in the move-discovery-draft layer.

  Approved moves become retrievable.

## Phase 9 — Hardening

- [ ] **N36 Migrations, privacy, deletion (§19.3).** Add an idempotent migration runner script, schema
      coverage for every new entity, private-by-default sessions, and session/export deletion APIs.
- [ ] **N37 Corpus and performance (§21.5–§21.6).** Extend the corpus across logic, algebra, number
      theory, sets, order, and a research-notation custom-operator case. Record deterministic coverage and
      interaction counts. Add performance budget tests for selection, suggestions, and previews.
- [ ] **N38 End-to-end mouse-only flows (§21.4).** Add Playwright flows against the memory worker (N00):
      solve a corpus problem mouse-only, delete an accidental move, backtrack with information, export,
      reimport, and view the pruned proof.

## Progress log

Entries are appended as tasks complete: `date — task — commit — notes`.

- 2026-09-25 — N08, N09 — kernel naming:
  - Kept `split-classical-cases`, not `case-split`.
  - `assume-hypothesis` is renamed from agentctl's `add-temporary-hypothesis`.

  New operations and API:
  - `close-by-contradiction`.
  - `close-by-accepted-inference`, with evidence `background-inference`.
  - `replace-goal`, which is weakening.
  - `suffices`, which is strengthening and adds a `P ⇒ G` obligation.
  - `drop-hypothesis`, which is strengthening.
  - `alphaEquivalent`.
  - `TransitionEvidence`, now returned by `applyTransition`.

  Follow-ups:
  - Protocol edges do not store `evidence` yet.
  - Retrieval still matches `close-by-hypothesis` exactly rather than up to alpha-equivalence.
  - The worker needs menu materialization (N14) for the new input-driven moves.
