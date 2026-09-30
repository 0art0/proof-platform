# Non-AI feature roadmap

Durable TODO list for every deterministic (no LLM) capability in
[`platform-design-plan.md`](../platform-design-plan.md) and
[`platform-design-refinement.md`](../platform-design-refinement.md) that is not yet implemented.
It was produced on 2026-09-25 from an audit of `main` at `618c1cf`.

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
- Checks per task: `npm run lint`, `npm run typecheck`, `npm test` (or `-w @proof/<pkg>` for one
  package), and `npx prettier --check .`. No live PostgreSQL is available in the development
  sandbox. Persistence is tested through the existing fake `SqlClient` and the in-memory store.

## Phase 0 — Local operability

- [x] **N00 In-memory proof store and worker mode.** Promote the test-only `MemoryProofStore` to a
      production `ProofStore` implementation in `apps/worker`. Select it with `PROOF_STORE=memory`, and seed
      the development session on startup. Add a Playwright config that runs `proof-workspace.spec.ts`
      against the memory worker, so e2e tests run without Postgres. _Accept:_ the worker starts with no
      database, and the memory store passes the same repository test-suite as today.

## Phase 1 — Mathematical representation (packages/mathjson-model, packages/language)

- [x] **N01 Term-language breadth (§5.2, §5.4).** Statement/term validation for `Function`/lambda
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
- [x] **N05 Session-level mathematical context (§7, §11).** Move `backgroundProfileSchema` into
      `packages/library` and re-export it from `llm`. Add `ProofState.assumptions`: universally closed
      additional assumptions, each with origin (sorry id, source goal/obligation) and a `StatementView`.
      Add obligation provenance (`premise-of-result`, `side-condition`, `user`, `case`), a transition
      evidence kind (`structural`, `library-result`, `background-inference`, `sorry`), and a proof-session
      metadata schema (problem statement, background profile, active library layer ids). _Accept:_
      schema tests; existing stored states still parse.

## Phase 2 — Kernel completion (packages/kernel)

- [x] **N06 Apply approved library results (§9, §12).** Add a `KernelEnvironment.results` catalog of
      structurally described results (parameters, premises, conclusion, directions). Add kernel operations:
  - `apply-result-backward`: instantiate a result so its conclusion matches a goal or obligation
    conclusion (exactly, up to alpha-equivalence). Its premises and side conditions become new goals or
    obligations in the same context. The transition is strengthening, or equivalence when the result is
    an `Equivalent`.
  - `apply-result-forward`: instantiate using hypotheses as premises and add the conclusion as a derived
    hypothesis. The transition is equivalence; an unmet premise becomes an obligation.

  Instantiations are validated for sort and scope. Evidence kind is `library-result` with the artifact id.
  _Accept:_ invariant tests; a result whose premise does not match is rejected with a specific diagnostic.

- [x] **N07 Obligations and sorries (§11).** Add these operations:
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

- [x] **N10 Deep, polarity-aware rewriting (§7.1, §9, §8.2).** Add these operations:
  - Rewrite with an `Equivalent` hypothesis or result at any proposition position. The transition is
    equivalence.
  - Rewrite with an implication `A ⇒ B`. Replacing `B` by `A` in a positive position is strengthening,
    and replacing `A` by `B` in a negative position is also strengthening. In a mixed position the rewrite
    is rejected.
  - Rewrite at an associative selection lens (contiguous operand range) using `packages/selections`
    splice.

  Polarity is computed by the same function the selection resolver uses (move it into mathjson-model or
  kernel, whichever keeps dependencies acyclic). _Accept:_ polarity property tests and golden rewrites.

- [x] **N11 Construction metavariables (refinement §5).** Add construction-task records with these fields:
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

- [x] **N12 Library store, layers, admission, derived results (§12.4).** Add a `LibraryRepository` (memory +
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
- [x] **N14 Result-application moves, plans, parameter menus (§13, §14.5, §17.4).** Moves become able to:
  - wrap N06 result application, N07 sorry, N08 case split, N09 weakening/strengthening, and N10 deep
    rewriting;
  - run multi-operation plans, validated atomically in sequence;
  - offer parameter menus generated from context only: disjunct index, instantiation terms (in-scope terms
    of matching sort drawn from the snapshot and selections), existential witnesses, rewrite direction and
    occurrence, and case-split propositions drawn from selected statements.

  Worker `materializeKernelOperation` must support every input-requiring move through menu choices.
  Arbitrary expression payloads are rejected (refinement §11). _Accept:_ the four previously unappliable
  moves are applicable via menu choices, end-to-end in the worker tests.

- [x] **N15 Discrimination tree and filtering (§14.1–§14.3).** Replace the one-level key with a real
      discrimination tree over preorder operator/arity paths with wildcard edges. Add secondary keys for
      polarity, section, and semantic role.
  - Typed unification against declared sorts.
  - Side-condition evaluation: a premise already available as a hypothesis creates no obligation;
    otherwise it becomes an obligation and lowers the rank.
  - Near-miss suggestions ("applies if …") in a separate category, with deterministic category diversity.

  _Accept:_ completeness tests (tree retrieval ⊇ brute-force matching on random patterns) and a
  performance test (≤150 ms query on a 1000-artifact catalog).

- [x] **N16 Starter domain packs and elementary corpus (§21.5, Stage 2 exit).** Hand-author approved
      results with variants for elementary logic, equality, order (transitivity, antisymmetry, monotonicity
      of addition), basic arithmetic identities, and sets (subset transitivity, union/intersection
      membership). Add a benchmark corpus of at least 8 elementary problems, each solved deterministically
      through the protocol layer by a scripted sequence of displayed suggestions. _Accept:_ corpus test
      proves every problem solved.

## Phase 4 — Discovery tree

- [x] **N17 Solved status, provability route, pruned proof (§16.5).** Pure functions over the stored
      tree:
  - a target is closed when every goal is discharged through equivalence/strengthening edges, including
    all case branches;
  - `solved(session)` reports the solution relative to background inferences and sorry assumptions;
  - the pruned proof is the minimal retained subtree along the chosen successful route, keeping its cases,
    dependencies, derived results, and universally closed assumptions.

  Weakening edges never count. _Accept:_ tests with weakening-only branches, partial case closure, and
  multiple alternative routes (choose the first-completed, documented).

- [x] **N18 Delete previous move (§16.2).** Add a repository command that removes the latest edge and child
      at the current leaf. If descendants exist, it requires `confirmDescendants`. The cursor returns to
      the parent, and deleted work is removed from history and export while a tombstone audit row is kept.
      _Accept:_ tests covering leaf and with-descendants cases.
- [x] **N19 Interaction events and preview coherence (refinement §12).** Add an ordered, node-anchored
      interaction-event log: selection changed, suggestions requested/displayed, preview requested, preview
      rejected, menu expanded, focus/objective changed, and "interaction ended without action".
  - Previews record content hashes of the library/move definitions they used.
  - Apply regenerates the preview (recorded) instead of applying stale definitions.

  _Accept:_ tests for ordering, idempotency, and the stale-definition path.

- [x] **N20 Backtracking with information (§16.3).** Given a proposition `P` from a descendant snapshot:
  - compute its free symbols, operators, and definitions;
  - find the closest ancestor where all are available, and list the other eligible ancestors;
  - create a new child of the chosen ancestor via `case-split` on `P`, auto-closing a case whose goal is
    `P` itself;
  - focus the remaining open case, leaving the original branch intact.

  _Accept:_ tests for ancestor choice, unavailable-symbol rejection, and the auto-close case.

- [x] **N21 Semantic replay (§16.4).** Record every applied step as a semantic plan: the move/result id,
      selections described by statement role + pattern match rather than raw paths, and parameters by menu
      origin. Replay a sequence onto a target node, re-matching each step. The report lists adapted steps,
      changed substitutions, new obligations, the first failure, and candidate repairs (alternate matching
      selections). Commit creates fresh nodes. _Accept:_ tests for replay onto an alpha-renamed/perturbed
      state and a failing step.

## Phase 5 — Inquiry language (refinement §3–§4, §6)

- [x] **N22 Inquiry records and store.** Add these records:
  - Questions (`Establish`, `Construct`, `Determine`, `Explore`), Objectives, Attempts, Requirements,
    Observations, Obstructions, and Decisions.
  - Relationships: `wouldSufficeFor`, `requires`, `motivatedBy`, `addresses`, `specializes`,
    `generalizes`, `tests`, `reuses`.
  - Reason provenance: explicit-user / agent / method-encoded / later-interpretation.

  Records reference MathJSON and proof nodes rather than copying them. Add commands through the single
  command service and persistence (migration). _Accept:_ schema invariants (e.g. `wouldSufficeFor` needs
  evidence or an explicit informal status; later interpretations are never contemporaneous).

- [x] **N23 Deterministic explanation templates (refinement §3.4).** `packages/language` renders the
      template sentences over inquiry records using N04 for the mathematics. _Accept:_ golden tests.
- [x] **N24 Method-created records and failure diagnostics (refinement §3.4, §6).** Add these behaviours:
  - Choosing "Try this theorem" creates an Attempt with missing-premise Objectives automatically.
  - Failed premise matches produce Obstructions naming the specific unmet condition.
  - Hypothesis-role investigation creates a `Determine` question for the statement with that hypothesis
    removed.
  - Conditional-lemma extraction ties into N12.

  _Accept:_ tests; no intention is attributed unless the action's stated semantics imply it.

## Phase 6 — Protocol, agent API, problem entry

- [x] **N25 Complete command protocol (§18, §20.3).** Add one command envelope for every mutation: kernel
      operations with menu-sourced parameters, case split, sorry, delete, backtrack (cursor and with
      information), replay, library addition, and inquiry commands.
  - Stable compact aliases per snapshot (`g1`, `h2`, `s1`, `m3`).
  - Observe full / summary / delta-since-event.
  - Worker HTTP routes plus web proxy routes.
  - Payload-source enforcement: new mathematical content only from setup, approved generators,
    validated operations, or reviewed authoring.

  _Accept:_ HTTP tests; an agent-style scripted session completes an N16 corpus proof over HTTP.

- [x] **N26 Manual problem and session creation (§4.1, §4.4 without LLM).** Add an API and landing page to
      create a problem with a statement, background profile, and domain/notation preferences, then
      manually enter an initial proof state. Declarations are chosen from sort menus; hypotheses and goals
      are entered as LaTeX parsed through the Compute Engine or as MathJSON. The user picks library layers
      and packs, reviews, and approves; only approval creates the root node. The landing page has three
      actions: new problem, upload artifact, fetch stored proof. _Accept:_ route tests and a component
      test for the approval gate.

## Phase 7 — Artifact

- [x] **N27 Export / import (§19).** Add a versioned artifact schema covering all non-AI §19.2 sections:
      problem setup, library layers and addition events, initial state, the full tree with snapshots,
      selections, displayed menus, previews, edges and events, interaction events, inquiry records,
      solved status, pruned proof, sorry assumptions, final library, and translation dictionary. LLM call
      records are included if present. Add an exporter from the store, and an importer with full
      revalidation that creates a read-only session. Add upload and fetch APIs. _Accept:_ round-trip
      tests; a tampered artifact is rejected.
- [x] **N28 Static viewers (§4.6, §16).** Add a full discovery-tree viewer, chronological playback, and a
      pruned-proof viewer (LaTeX and natural language, with the sorry assumption list and links to
      motivating inquiry records). All views read only stored snapshots. _Accept:_ tests assert no kernel,
      retrieval, or rendering-of-history recomputation of menus.

## Phase 8 — Human interface (apps/web)

- [x] **N29 Workspace chrome and accessibility (§17.1).** Add:
  - a header with problem title, background summary, solved status, and branch breadcrumb;
  - colour families (variables red, hypotheses orange, goals blue, obligations/assumptions purple) plus
    polarity bevels, reinforced by icons, outlines, and labels;
  - an Escape key that clears selections;
  - a LaTeX/NL toggle, a raw MathJSON view, and "copy state JSON".
- [x] **N30 Suggestion panel completion (§17.3).** Add:
  - result-application cards;
  - parameter menus for input-requiring moves;
  - expandable variant groups;
  - provenance and evidence badges;
  - previews rendered as LaTeX/NL state differences rather than JSON;
  - near-miss category and obligations display.
- [x] **N31 Toolbar actions (§17.2).** Add delete previous move (with descendant confirmation),
      backtrack-with-information dialog, replay-a-sequence-here dialog, mark sorry, case split on
      selection, export, and open full tree.
- [x] **N32 Library drawer (§17.1).** Add a drawer with layers, search/filter by kind and domain,
      artifact detail views (statement, premises, directions, variants, provenance, approval), and addition
      events.
- [ ] **N33 Abstraction and drag gestures (§8.3).** Add an abstract-selection gesture that turns a selection
      into a typed wildcard for retrieval only. Add drag gestures that show a preview before commit:
      result → expression (deep apply/rewrite), hypothesis → goal (use/specialize/rewrite), and term →
      binder or argument slot (instantiate).
- [x] **N34 Inquiry and construction panels (refinement §10).** Add a compact inquiry panel (active
      objective, current attempt, unresolved constructions, top obstruction or requirement) and the actions
      "Use this", "Construct an object", "Find sufficient conditions", "Investigate this hypothesis", and
      "Try this method". Add a construction-task view with requirements by role.
- [~] **N35 Move authoring without AI (§13.1, refinement §7).** Add:
  - a visual move-template editor: selection contract, patterns picked from selections, parameters from
    menus, required artifacts, plan as a kernel-operation sequence, class, and examples;
  - validation of examples by running the plan;
  - a draft → approved workflow with recorded review;
  - macro moves built from a recorded step sequence (N21 plans);
  - persistence in the move-discovery-draft layer.

  Approved moves become retrievable.

## Phase 9 — Hardening

- [x] **N36 Migrations, privacy, deletion (§19.3).** Add an idempotent migration runner script, schema
      coverage for every new entity, private-by-default sessions, and session/export deletion APIs.
- [x] **N37 Corpus and performance (§21.5–§21.6).** Extend the corpus across logic, algebra, number
      theory, sets, order, and a research-notation custom-operator case. Record deterministic coverage and
      interaction counts. Add performance budget tests for selection, suggestions, and previews.
- [x] **N38 End-to-end mouse-only flows (§21.4).** Add Playwright flows against the memory worker (N00):
      solve a corpus problem mouse-only, delete an accidental move, backtrack with information, export,
      reimport, and view the pruned proof.

## Progress log

Entries are appended as tasks complete: `date — task — commit — notes`.

- 2026-09-25 — N08, N09 — kernel naming:
  - Kept `split-classical-cases`, not `case-split`.
  - Renamed `add-temporary-hypothesis` to `assume-hypothesis`.

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

- 2026-09-26 — N00 — memory store, `PROOF_STORE=memory`, and `test:e2e:workspace`. Two of the five e2e
  tests fail at this point. Addressed in N29/N38.
- 2026-09-26 — N02–N04 — `createPresentation`, `parseLatex`, and the natural-language renderer.
  - `Limit` in its bare MathJSON form serializes badly; N01 should pick binder shapes the Compute Engine
    understands.
  - `mathlive-selection.ts` depends on the LaTeX strings produced by `renderMathJson`.
- 2026-09-26 — N13 — `generateVariants`.
  - Callers must index `output.source`, the family-tagged copy, and merge any existing family members.
  - Renderings are placeholders until they are wired to `packages/language`.
- 2026-09-26 — N06 — adds `apply-result-backward` (strengthening), `apply-result-forward` (equivalence),
  `matchResultConclusion`, and `KernelResult`. Open design points:
  - (a) Forward application that creates obligations is strictly a strengthening. Reclassify it or split
    the kind; decide in N14.
  - (b) Built-in `ForAll`/`Exists` take their bound symbol's sort from context declarations, so a capture
    rename fails unless the renamed symbol is declared. N01 must give quantifiers self-contained typed
    binders.
  - (c) The catalog is revalidated on every call; callers should narrow or cache it.
- 2026-09-26 — N15 — discrimination tree (`fn:<head>/<arity>`, `fnv:` variadic grouping for binary
  And/Or/Add/Multiply move patterns), typed unification, premise/side-condition evaluation, category
  diversity. Median ~5 ms over 1000 results. Follow-ups:
  - `rank` gains an "exact type fit" element at index 3; results with premises are now `applicable` with
    `rank[1] = 0` instead of `requires-input`.
  - e2e "goal only → `move:expand-hypothesis-conjunction` requires-input" still fails: the move has no
    target-slot pattern and protocol requires the primary pattern to be linked to a selection. Fix in
    moves (add a target-slot pattern) or relax the protocol rule.
  - Prose-only side conditions always become obligations; premise availability only checks hypotheses in
    the target's context.
- 2026-09-26 — N14 (moves part; worker wiring outstanding, box stays open) — `libraryResultToKernelResult`
  / `approvedKernelResults`, `generateParameterMenus`, `materializeMoveOperation` (all 29 kinds, menu
  choices only), `commandIdGenerator`, `materializeResultApplication`, `planMoveSequence`,
  `movePlanImplementationSchema`.
  - Remaining for N14 acceptance: worker replaces `materializeKernelOperation` with
    `materializeMoveOperation` + `commandIdGenerator`, builds `env.results` via `approvedKernelResults`,
    routes `source: "result"` suggestions through `materializeResultApplication`, passes the selected
    occurrence for equivalence suggestions; protocol/UI need a menu-choice payload.
  - Top-level `Implies` results always split into premises + conclusion, so they are no longer
    `rewrite-with-implication` sources.
  - N06(a) still open: proposed fix is kernel returns `strengthening` when obligations exist and
    `PRIMITIVE_TRANSITION_CLASSES` becomes a per-kind allowed set.
  - The plan implementation kind is not yet in the `MoveDefinition` union (N35). Forward/assumption premise
    matching is greedy (no backtracking).
- 2026-09-26 — N14 (worker wiring; completes N14) — the worker uses `materializeMoveOperation` +
  `commandIdGenerator`. Protocol adds `menuChoices` (menu item ids only) and `moveRequiresInputResponseSchema`
  (HTTP 422, nothing recorded). `menuSelection` is stored on previews, commands and edges for static
  history. A result suggestion authorizes `apply-result-*`/`rewrite-with-equivalence` only for that same
  result. choose-goal-disjunct, instantiate-universal-hypothesis, choose-existential-witness and
  rewrite-with-equality apply via menus end to end over HTTP.
  - `env.results` comes from `CORE_LOGIC_RESULTS` (same as retrieval), not the per-session library store;
    wire both to the store together.
  - Web has no menu picker yet; a 422 surfaces as `requires-input`.
  - `TransitionEvent` does not carry `menuSelection`.
- 2026-09-26 — N16 — `starterLibraryPacks()` (library `packs.ts`): elementary logic (7 results), equality
  (3), order (12), arithmetic (13), sets (5, with registered `Union`/`Intersection` operators); variants
  come from `generateVariants`, restricted per result to the useful transformations, and every result
  passes the schema and the global admission gate. `ELEMENTARY_CORPUS` (library `corpus.ts`, 14 problems)
  is solved over HTTP by `apps/worker/src/proof-http/elementary-corpus.test.ts` and checked with
  `analyzeDiscoveryTree`. The worker catalog is core logic plus every pack whose operators the session
  declares identically (`approvedCatalog`), shared by retrieval and materialization, with variant families.
  - Backward result suggestions that need an instantiation menu or create obligations (e.g. transitivity
    backward) rank below the catch-all moves and fall outside the 8-suggestion display, so the corpus
    uses forward application from hypotheses for them. Retrieval ranking should fix this; the HTTP
    suggestion request cannot raise the limit.
  - Equality results are not rewrite sources (the kernel rewrites only with equality hypotheses): derive
    the instance forward, then `rewrite-with-equality`. `generateVariants` derives an unapplicable
    right-hand-term backward pattern for equations; the packs re-derive equation-variant patterns.
  - Retrieval reports `requires-input` for forward parameters that materialization binds from
    hypotheses, and ignores premises split from an `Implies` statement (contrapositive variants).
  - Sorts are monomorphic: the packs are stated over `sort:real` and sets of `sort:element`.
- 2026-09-27 — N01 — mathjson-model `binders.ts` (`binderShape`, `readBinderDeclaration`) is the single
  binder contract, used by free names, substitution, statement validation, kernel alpha-equivalence,
  result matching and deep-rewrite location, and selection positions. Built-in binders:
  `ForAll`/`Exists` over a symbol or `["Element", x, S]`; `["Function", body, p1, …]`;
  `["Sum" | "Product", body, ["Limits", k, lo, hi] | ["Element", k, S]]`;
  `["Integrate", body, ["Limits", x, a, b]]`. `Limit` is `["Limit", ["Function", body, x], point]`,
  the shape the Compute Engine serializes. Domains and bounds are in the enclosing scope. Sort rules
  also cover `Apply`, `Tuple` (`sort:tuple`), `Set`/`List`, `At` (lists, `sort:sequence`, tuples,
  unary functions) and standard sets (`RealNumbers` → `set<real>`, …). Literals and untyped lambdas
  are checked against a known expected sort. The new heads and standard sets are reserved symbols.
  - Typed binders are self-contained, so capture renames validate without declarations (N06(b)).
    Kernel quantifier operations still accept only untyped binders; typed ones need a membership
    hypothesis or obligation, which is an operation-schema change.
  - `moves/context-terms.ts` and retrieval binder-path keys still use `BUILTIN_BINDER_SPECIFICATIONS`,
    so they ignore the new binders and typed declarations. Port them to `binderShape`.
  - CE `Sequence` (a splice) is unsupported; sequences are `sort:sequence` or unary functions.
  - A variable function head is still replaced only by a symbol; replacing it with a lambda needs an
    `Apply` form.
  - There is no numeric subtyping, and no function-space set constructor. Quantifying over functions
    uses a declared set of functions or an untyped binder with a declaration.
  - LaTeX renders typed lambdas as `\left(x \in \R\right) \mapsto …` and `Apply` as `f(…)`.
    `parseLatex` does not map the CE parse of `\int`/`\mapsto` (`Block`-wrapped `Function`) back to
    these shapes.
- 2026-09-27 — N19 — protocol `interaction-events.ts`: strict `recordInteractionEventRequestSchema`
  (client kinds: selection-changed, suggestions-requested/-displayed, preview-requested/-rejected,
  menu-expanded, focus-changed, objective-changed, interaction-ended-without-action) and
  `interactionEventSchema`, which adds the worker-assigned `sequence`, `stateId`, `actor` and
  `recordedAt` and the worker-only `preview-regenerated` kind. Migration `0007` adds
  `proof_interaction_events`, mirrored in `MemoryProofStore`. `POST` and `GET` on
  `/proof-sessions/:id/interaction-events` record and list events. A retried event ID replays the
  event; different content under the same ID gets 409. Sequences are allocated under the session
  lock. Deleting a move also removes events anchored at deleted nodes.
  - Previews carry `definitions`: `sha256` hashes of the canonical JSON of the move and library
    definitions used. The worker's `DefinitionCatalog` (`APPROVED_DEFINITIONS`, injectable into
    `createProofHttpService`) supplies retrieval, materialization and kernel results.
  - An apply whose preview was built from changed definitions records a regenerated preview
    (`<preview>:regenerated:<digest>`) and a `preview-regenerated` event atomically, then answers 409
    `preview-regenerated`. Repeating the same command applies the regenerated preview. Previews
    already applied are replayed, never regenerated.
  - The web workspace posts events through a serialized best-effort recorder. It covers selection,
    suggestions requested/displayed, preview requested, preview rejected (superseded or selection
    changed), cleared selection and expanded input menus. Focus and objective events have no web UI
    yet, and the web app has no GET proxy for the log.
  - Events reference suggestion sets and previews by ID only (a request precedes its set); only the
    anchor node is a foreign key. Deletion tombstones do not list removed interaction-event IDs.
- 2026-09-27 — N20 — `512e8f2` — protocol `backtracking.ts`: `analyzeBacktrack` and
  `planBacktrackWithInformation` are pure functions over stored nodes and edges. They report `P`'s free
  symbols, operator heads and source declarations, trace the source target's lineage up the path, and list
  every strict ancestor (closest first) with `eligible`, `wellFormed` and `unavailableSymbols`. A symbol is
  available when the lineage target declares it with the same sort and it is not only bound there (the
  kernel pre-declares quantified symbols). The closest eligible ancestor is chosen unless `ancestorNodeId`
  names another. The plan is `split-classical-cases` on the lineage target plus `close-by-hypothesis`
  (`<id>:auto-close`) on the case whose conclusion is alpha-equivalent to `P` or `Not P`; focus goes to
  the remaining case.
  - Worker `backtrackWithInformation` prepares each step with `prepareProofCommand` against its own parent
    before writing, inserts ordinary node/edge/event/command rows, moves the cursor, and records a
    worker-only `backtracked-with-information` interaction event (migration `0008`; `MemoryProofStore`
    now checks kinds). The event makes the command idempotent: identical retry replays; conflicting
    content gets 409 `backtrack-with-information-conflict`; stale cursor 409; deleted step
    `command-deleted`. HTTP: `POST /proof-sessions/:id/backtrack-analysis` and
    `/backtrack-with-information` (201/200 replay, 422 unavailable symbols, 400 invalid). Tests assert
    the original branch's rows stay byte-identical.
  - Gaps: §16.3 step 5 (reattach existing work under the case) is left for N21. Auto-close only handles
    the case hypothesis itself. Focus is returned and recorded but there is no session focus field. The
    source node is never a candidate. Kernel steps carry no `moveId`. No web UI or proxy yet (N31).
- 2026-09-27 — N11 — `b3841f4` — construction tasks (refinement §5). mathjson-model adds
  `ProofState.constructions`: strict, status-discriminated `ConstructionTask` records (origin
  `existential-goal` or `auxiliary-request`, sort, scope, `allowedDependencies` over scope declarations and
  task ids, requirements with role/evidence/`attemptId`, candidates, and resolution/abandonment records),
  branded task/requirement/candidate/attempt ids, and obligation provenance `construction-requirement`.
  `attestationIdSchema` moved to mathjson-model.
  - A placeholder is a registered operator derived from its task, applied Skolem-style to its allowed
    declarations (`["m", "eps"]`), so later variables cannot leak into the choice. State validation
    rejects closed placeholders left in statements and placeholders in assumptions, and checks an acyclic
    transitive task-dependency graph, in-scope requirements, the role/evidence rule (heuristic ⇔ no
    evidence; `target` evidence only for sufficient; necessary needs an attestation), and candidate
    sort/scope.
  - Kernel `CONSTRUCTION_OPERATION_KINDS` (separate from `KERNEL_OPERATION_KINDS`), all via
    `applyTransition`: `introduce-placeholder` (equivalence when dependencies cover the sequent's free
    symbols, else strengthening), `add-requirement`, `add-candidate`, `resolve-placeholder`
    (strengthening; capture-free substitution; remaining sufficient requirements become obligations;
    never closes a target) and `abandon-placeholder` (only when unused). `mark-sorry` rejects targets
    mentioning an open placeholder. fast-check properties: no requirement becomes a hypothesis, and
    introduction is an equivalence exactly when dependencies are complete.
  - Gaps: no moves, menus, protocol helpers, routes or UI for construction operations (`planMoveSequence`
    rejects them; N25/N34). No withdraw-requirement or candidate-generator record. Typed binders are not
    supported by `introduce-placeholder`. Selections, retrieval and `moves/context-terms` do not register
    placeholder operators; rendering shows them as plain applications; discovery-tree edges report them as
    structural; `sorryClosure`/`derived.ts` do not see placeholder heads.
  - The kernel property tests in `obligations.test.ts` and `deep-rewrite.test.ts` run close to vitest's
    5 s timeout under machine load.
- 2026-09-28 — N22 — `e7c2f7a` — protocol `inquiry.ts`: strict records for questions (`establish`,
  `construct`, `determine`, `explore`), objectives, attempts, requirements, observations, obstructions,
  decisions, relationships (`wouldSufficeFor`, `requires`, `motivatedBy`, `addresses`, `specializes`,
  `generalizes`, `tests`, `reuses`) and explicit status changes, with branded `InquiryRecordId`s. Records
  reference mathematics by identity only (node + target, statement, operand-path occurrence, N11 task or
  requirement). Reasons carry provenance `explicit-user`, `agent`, `method-encoded` (naming its method)
  or `later-interpretation`.
  - A command `{ commandId, nodeId, records }` records up to 32 records at an anchor node; a record may
    reference only earlier records. `prepareInquiryCommand` is pure: it validates every reference against
    stored nodes, suggestion sets, transitions and earlier records, and assigns sequences.
  - Invariants: `wouldSufficeFor` needs a non-weakening transition covering the targets it changed, an
    established sufficient N11 requirement, or an explicit `informal` status. Heuristic requirements have
    no logical support. `explicit-user`/`agent` provenance must match the actor. A later interpretation
    concerns only earlier commands; intention-bearing relations are contemporaneous only when their
    `from` records are in the same command. fast-check covers the provenance/contemporaneity rule.
  - Worker `recordInquiryCommand`/`listInquiryRecords` insert atomically under the session lock;
    identical retries replay, conflicts get 409 `inquiry-command-conflict`. Migration `0009` adds
    `proof_inquiry_records` (mirrored in `MemoryProofStore`) with GIN-indexed referenced node/record ids;
    "Delete previous move" removes dependent records recursively. HTTP: `POST
/proof-sessions/:id/inquiry-commands` and `GET /proof-sessions/:id/inquiry-records`.
  - Gaps: HTTP always records as the human web actor (agent provenance only via the repository; N25).
    Library methods are checked against the approved catalog only. No attestation store, no strategy
    records. Unassigned construct objects are not linked to later N11 tasks. Inquiry command ids are a
    separate namespace. Deletion can remove part of an inquiry command, after which replay gets 409. Ten
    `proof-repository` helpers are now exported. No web proxy or UI (N34).
- 2026-09-28 — N21 — `ee4b0cc` — protocol `semantic-replay.ts`: `deriveSemanticStep` builds a strict
  `SemanticStep` from records stored at apply time (parent/child snapshots, edge, displayed suggestion
  set): move or result id with direction and substitutions, each selection as slot/target/statement
  role/occurrence plus a fragment whose free declared symbols are its pattern variables, menu parameters
  by origin and value, the operation, transition class and created obligation conclusions.
  - `planSemanticReplay` re-matches each step on the snapshot the previous replayed step produced, using
    the new kernel export `matchExpressionPattern` (binder-aware, sort-checked). Candidates are classed
    identical / renamed / conflict / shape-only and ranked by match, carried target and hypothesis
    correspondence, role and path. Symbol and statement-id correspondences carry forward; menu parameters
    are re-chosen by mapped value, then origin, then pattern instance. Each step is materialized and
    validated by `prepareProofCommand` as an ordinary `apply-kernel-operation` (`<replay>:replay:<n>`),
    creating fresh records.
  - The report marks steps exact or adapted, with new/changed substitutions, changed parameters, created
    obligations (`inSource`), alternatives, and the first failure with repair candidates that callers
    can force through `overrides`; later steps are not-attempted.
  - Migration `0010` adds `proof_replay_steps` (mirrored in memory) holding each replayed step's plan,
    report and request, so replayed branches can be replayed again and the commit is idempotent.
    Worker `previewSemanticReplay` (writes nothing) and `commitSemanticReplay`; HTTP `POST
/proof-sessions/:id/replay-preview` and `/replay` (201/200 retry, 422 failed step with report and
    nothing written, 409 conflict/stale, 400 bad request).
  - Tests include a fast-check property that replay is invariant under symbol/goal-id renaming and
    declaration order, a perturbed target, a failing step repaired by overrides, and the N20 follow-up
    (§16.3 step 5): replaying the original branch onto the focused case after backtracking.
  - Gaps: steps applied without a displayed suggestion (backtracking splits and auto-closes, raw kernel
    commands) have no plan and fail as `step-not-replayable`. Plans of ordinary steps are derived when
    needed; only replayed steps persist one. Later-step candidate ids include predicted statement ids, so
    previews must use the commit's `commandId` for overrides to carry. The whole report is not persisted.
    Deletion tombstones do not list removed replay-step rows. Assignment search is capped at 24 attempts
    per step. No web dialog (N31).
- 2026-09-28 — N23 — `13635e2` — language `inquiry-explanation.ts`: `createInquiryExplainer` renders the
  refinement §3.4 template sentences over stored inquiry records, using N04 for all mathematics. Input is
  explicit stored data (`InquiryExplanationContext`: node snapshots, records by id, transitions by child
  node, method names, displayed-suggestion labels); missing data is named by id, so rendering is total.
  Language sits below protocol, so the input is a structural `InquiryRecordView`; protocol's
  `inquiry-language-contract.test.ts` (N24) asserts at compile time that `InquiryRecord` is assignable.
  - One template per record kind and relation, plus `explainSufficiency`. Requirement roles are phrased
    separately. Every reason shows its provenance; method-encoded reasons read as the method's objective,
    and later interpretations always read "On a later interpretation, …". Evidence wording names
    equivalence, strengthening, weakening ("does not by itself show sufficiency"), sorry and informal
    status. Goldens cover 46 fixture records and an 8 × 4 relation/provenance matrix.
  - Gaps: placeholders render as plain applications; "the next attempt uses [change]" is not rendered (no
    record links successor attempts); raw ids appear in evidence and fallback phrases; result conditions
    are named by position only. No web UI (N34).
- 2026-09-28 — N24 — `bf630c3` — retrieval result suggestions store `predictedObligations` (unavailable
  premises and side conditions, with `applicationPremiseIndex`). `inquiry.ts` adds a `result-condition`
  math reference (validated against the stored displayed match) and an `inquiry-method` method reference
  (`try-result`, `investigate-hypothesis`, `extract-conditional-lemma`). protocol `inquiry-methods.ts`
  holds pure derivations to one inquiry command each:
  - `deriveTryResultInquiry` ("Try this theorem"): reuses or creates the Establish question and required
    objective, records an attempt (result + displayed suggestion), an Establish question, required
    objective and `requires` relation per premise target the application created, `wouldSufficeFor` with
    transition support, and per stored unmet condition an `unmet-condition` observation naming it plus an
    obstruction that the premise objective `addresses` (method-encoded reason).
  - `deriveHypothesisInvestigation`: `Determine(target withoutHypotheses:[h])` by identity, an elective
    objective, and `tests` against an existing Establish question.
  - `planConditionalLemma` + `deriveConditionalLemmaInquiry`: N17 route analysis over the node's subtree;
    closures through `mark-sorry`/`close-by-assumption` are refused.
  - No derivation records `motivatedBy`, decisions, status changes or non-method provenance (fast-check).
    Worker `executeTryResultCommand` applies the move and records `<commandId>:try-result` in one
    transaction; `investigateHypothesis`; `extractConditionalLemma` is the minimal N12 hook
    (`extractDerivedResult` → draft derived-layer artifact → inquiry command, linked by id, idempotent,
    not atomic). HTTP: `POST /commands` accepts `inquiryMethod: "try-result"` and returns
    `inquiryRecords`; `POST /proof-sessions/:id/hypothesis-investigations`.
  - Gaps: no HTTP route for conditional lemmas (library store not wired into the HTTP service); the lemma
    is always a draft, keeps every hypothesis, and the caller supplies renderings. Objective reuse matches
    only the exact node and target. More than about 4 unmet premises exceeds the 32-record command limit.
    Suggestion sets stored earlier have no `predictedObligations`. Premise-free result rewrites are not
    treated as "Try this theorem". The `requires-input` path is untested. No agent actor over HTTP; no web
    UI (N34).
- 2026-09-29 — N25 — `a4a2b25`, `0bdda72` — protocol `command-protocol.ts`: a strict
  `protocolCommandEnvelopeSchema` `{ commandId, actor (human|agent), basis?: { nodeId, suggestionSetId? },
command }`. Kinds: `request-suggestions`, `preview`, `apply` (menu items by id or alias;
  `inquiryMethod: "try-result"`), `kernel-operation` (any kernel or N11 construction operation, with
  aliases for targets, hypotheses and statements), `case-split`, `sorry`, `delete-previous-move`,
  `backtrack`, `backtrack-with-information`, `replay`, `record-inquiry`, `investigate-hypothesis`,
  `extract-conditional-lemma` and `add-library-result`. Each dispatches to the existing repository
  function; the suggestion/preview/apply flows moved to `proof-http/shared.ts` and back both the old
  routes and the envelope.
  - Aliases are pure functions of a stored snapshot: `g`/`o` goals and obligations in state order, `h`
    hypotheses by first appearance, `s` in the display order of the latest `suggestions-displayed` event,
    `m` per menu round. fast-check covers determinism, JSON round trips and alias↔id injectivity. Aliases
    resolve against the stored snapshot of `basis.nodeId`; failures on an old basis are 409 `stale-alias`,
    unknown aliases 422, cursor-bound kinds without a basis 400 `basis-required`.
  - Payload sources: MathJSON arrives by `occurrence` (snapshot, target, statement, operand path) or raw
    with a `source`. Raw `setup` and `approved-generator` payloads are rejected; `validated-operation`
    must occur verbatim in the snapshot; `reviewed-authoring` is accepted only from a human. Library
    additions must be human `reviewed-authoring` by the approving reviewer.
  - HTTP: `POST /proof-sessions/:id/protocol-commands` (201/200 replay) returns
    `{ commandId, kind, actor, replayed, cursor, aliases, delta, result }`. `GET
/proof-sessions/:id/observe?view=full|summary|delta`: full (node, aliases, open targets, displayed
    suggestions, cursor `{ nodeId, stateId, eventSequence, inquirySequence }`), summary (LaTeX-free lines),
    delta (`sinceNode` + `afterEvent`/`afterInquiry`). The library store is wired into the HTTP service and
    startup (memory and Postgres). Web proxies `/api/proof-sessions/[sessionId]/protocol-commands` and
    `/observe`. An agent-style session using only observe and aliased envelope commands solves
    `corpus:modus-tollens` and `corpus:equality-chain`.
  - Gaps: no authentication (the actor is trusted as sent, including through the proxy). No unified event
    log; the delta cursor is node + interaction/inquiry sequences. Records inside `record-inquiry` use
    stored ids, not aliases. `kernel-operation` has no generated ids or menus; construction operations
    still have no moves or menus. Cursor `backtrack` records no actor. Observe reads whole event and
    inquiry logs. Generator and derived-variant library additions are rejected rather than regenerated;
    `global` layer additions are refused; retried library additions send a new `occurredAt` (replay
    untested). The web adapter validates the observed node only structurally. No UI.
- 2026-09-29 — N37 — `7b79da8` — `BENCHMARK_CORPUS` = `ELEMENTARY_CORPUS` + `EXTENDED_CORPUS` (library
  `corpus.ts`, 37 problems): logic 5, algebra 4, number theory 5, sets 3, order 3, research notation 3.
  New packs `pack:divisibility` (`Divides` over `sort:integer`) and `pack:closure` (`Closure`, the
  research-notation case with N02 metadata `\operatorname{cl}(…)`, parse trigger and prose template),
  admitted through the global gate and offered only when their operators are declared.
  - `apps/worker/src/proof-http/benchmark-corpus.test.ts` (replacing `elementary-corpus.test.ts`; harness in
    `corpus-harness.testing.ts`) solves every problem over HTTP from displayed suggestions and checks each
    with `analyzeDiscoveryTree` and `prunedProof`. Per-problem interactions, displayed rank of the chosen
    suggestion, kernel operations and transition classes are compared with the golden
    `corpus-coverage.golden.json` (regenerate with vitest `-u`). Totals: 124 steps, 180 selections, 124
    suggestion requests, 142 preview requests, 18 menu choices, 124 applies, 0 typed expressions; 29 of 124
    choices were not ranked first. 31 catalog results are used; unused ones are listed in the golden.
  - `corpus-performance.test.ts`: §21.6 budgets (selection 50 ms, suggestions 150 ms, previews 300 ms) on
    the median of 7 runs after 2 warm-ups, at every step of the longest problem per domain. Worst medians
    under parallel load: 0.5 / 42 / 84 ms.
  - Gaps: backward applications needing an instantiation menu still rank outside the 8 displayed
    suggestions (scripted forward instead). Set equations rewrite right to left only via a direction menu.
    `apply-result-forward` edges are classified as equivalence even when they create obligations (N06(a)).
    No script uses a derived variant. Combinatorics, linear algebra, real analysis and geometry have no
    packs yet (monomorphic sorts, no operators).
- 2026-09-29 — N30 — `7f3d539` — the suggestion panel is split out of `stored-proof-workspace.tsx` into
  `suggestion-panel.tsx`, `suggestion-card.tsx`, `suggestion-badges.tsx`, `parameter-menu.tsx` and
  `preview-details.tsx`, with a pure web-local `preview-diff.ts`. Badges (glyph + text label + `data-*`,
  never colour alone) show source, provenance, match, retrieval category (immediate / near miss / needs
  input, from `applicability` and `predictedObligations`), transition class and evidence
  (`transitionEvidenceOf` over the stored preview operation). Result cards preview and apply, show the
  instantiation as LaTeX `x ↦ t`, and list predicted obligations. Variant groups keep their stored position
  with an `aria-expanded` toggle. Previews render as statement differences in the chosen LaTeX/NL view
  (goals closed/added, before → after targets, new obligations with provenance, sorries, chosen inputs).
  - Parameter menus: after the legacy preview's 422 `requires-input`, the panel fetches the menus with a
    `preview` envelope to `/protocol-commands` (records nothing), offers only returned items, and submits
    `menuChoices` by item id; one `menu-expanded` event per newly displayed parameter.
  - Gaps: displayed suggestions carry no provenance field; result suggestions have no expected transition
    class before preview; previews and edges do not store `TransitionEvidence`; the legacy `move-previews`
    proxy drops the 422 menus (hence the second request); construction-state changes are not shown in
    diffs; menu term labels render as LaTeX in the NL view; the menu round trip is covered only by
    component tests with mocked `fetch` (the development seed has no menu move).
- 2026-09-29 — N26 — `08f9076` — protocol `problem-setup.ts`: a strict `problemDraftSchema` (title,
  statement, background profile, domain/notation preferences, library layer ids, starter pack ids,
  declarations as symbol + sort from the fixed `PROBLEM_SETUP_SORT_CHOICES` menu, hypotheses and goals as
  `{format: "latex"}` or `{format: "mathjson"}`), plus review, approval, options and diagnostic schemas.
  Drafts stay in the browser until approval (no migration; no row or root node exists before approval).
  - Worker `validateProblemDraft` is pure: it parses LaTeX with the Compute Engine dictionary plus the
    selected packs' parse triggers, checks duplicates, reserved symbols, pack-operator clashes, undeclared
    symbols (`pack-not-selected` names the pack), each statement, and the whole root via
    `createProofNodeSchema`. The review is the exact root node, operators, metadata, active packs and a
    `sha256` digest. `approveProblemSession` revalidates, answers 409 `review-stale` on a digest mismatch,
    and creates session + root through `initializeProofSession` in one transaction; identical retries
    replay, different content gets 409 `session-conflict`. HTTP: `GET /problem-setup/options`, `POST
/problem-drafts/validate`, `POST /proof-sessions`.
  - Web: `/` is the landing page (new problem → `/problems/new`; upload artifact disabled until N27; fetch
    stored proof → `/sessions?id=`). The workspace moved unchanged to `/sessions/[sessionId]` (e2e specs
    updated). The entry form has live LaTeX/MathJSON parse feedback, sort menus and layer/pack pickers;
    every edit clears the review. `problem-entry.spec.ts` joins `test:e2e:workspace`. fast-check covers
    validation totality and digest order-independence; a component test proves the approval gate.
  - Gaps: LaTeX source is not kept; no custom operators beyond packs, no user-defined sorts; untyped
    quantifier variables must be declared; layer ids are documentary and approval records no
    library-addition events; the Compute Engine warns about a duplicate `Divides` dictionary entry with
    `pack:divisibility`; no authentication. One unreproduced e2e flake (`proof-workspace.spec.ts:124`,
    navigation during first compile) was seen once.
  - Risk: `corpus-performance.test.ts` (N37) exceeded its 150 ms suggestion budget (medians 167–199 ms)
    in two `verify` runs made while parallel verify and Playwright runs loaded the machine; it passes on a
    quiet machine. Consider running performance budgets in a separate serial vitest project.
- 2026-09-29 — N31 — `76759ef` — the stored workspace gets a "Proof actions" row (`toolbar-action-bar.tsx`).
  Every action sends one N25 envelope through `POST /api/proof-sessions/[id]/protocol-commands` as the
  human web actor with `basis.nodeId`, then reloads the current node (checked against `cursor.nodeId`) and
  history. Pure builders live in `toolbar-actions.ts`; case split and backtrack send the one exactly
  selected proposition by `occurrence`, never raw MathJSON. Unavailable actions stay visible, disabled with
  a reason.
  - Delete previous move lists the nodes and descendants to remove (`planPreviousMoveDeletion` over stored
    history) and requires a confirmation checkbox when there are descendants. Backtrack with information
    lists every ancestor closest first with eligibility and unavailable symbols. Replay a sequence here
    picks an off-line path, lists its stored steps, and on 422 `replay-failed` shows the report with repair
    candidates and retries with `overrides`. Export links to N27's proxy; "Open full discovery tree" is
    disabled until N28. Dialogs are modal with focus management; Escape closes them without clearing the
    selection. Refusals read "`<action>` rejected (`<code>`): `<message>`".
  - `toolbar-actions.spec.ts` creates a fresh session per test through the N26 approval API.
  - Gaps: no web proxy for `backtrack-analysis` or `replay-preview` and no dry-run envelope, so the ancestor
    listing is computed in the browser with `analyzeBacktrack` (advisory; the worker recomputes on commit)
    and replay shows a report only on failure or after commit. No replay `focus` choice. Case split and
    backtrack need an exact single proposition. Actions stay enabled for read-only imported sessions.
- 2026-09-29 — N27 — `a5497cc`, `3a593ff` — protocol `artifact.ts`: a strict, versioned
  (`artifactVersion: 1`) `ProofArtifact` with `problemSetup`, `initialState`, `library` (operator
  environment, addition events, background revisions, final library), `tree` (snapshots, edges, events,
  command records, displayed suggestion sets, previews, replay steps, id-only tombstones),
  `interactionEvents`, `inquiryRecords`, `final` (N17 analysis, pruned proof, sorry assumptions),
  `translationDictionary` (stored operator presentations) and `llmCalls`, plus a `sha256` digest of the
  canonical JSON of the rest. `ARTIFACT_SESSION_ID_FIELDS` lists the only session-naming fields.
  - Export copies stored rows only, sorted by code units so repeated exports are identical.
    `importProofArtifact` revalidates in order: version, digest, strict schema, unique ids and one rooted
    tree, suggestion sets, re-prepared previews, every edge replayed through `prepareProofCommand`
    reproducing the stored child/edge/event/command, replay steps, tombstones, interaction anchors,
    inquiry commands via `prepareInquiryCommand`, background revisions and admission of every library
    addition, LLM call records, and recomputed final material and dictionary. The first failure rejects
    with a code and path and writes nothing.
  - Imported sessions keep every record id under `session:artifact:<digest prefix>`; re-uploading is
    idempotent. Migration `0011` adds `proof_sessions.read_only` and `proof_artifact_imports` (mirrored in
    memory). Both stores wrap every transaction in `guardReadOnlySessions`, so every write to a read-only
    session rolls back as `session-read-only` (409), including the envelope, inquiry, deletion,
    backtracking, replay, interaction events and library additions.
  - HTTP: `GET /proof-sessions/:id/export` (attachment) and `POST /artifacts` (≤ 16 MiB; 201, 200 identical
    re-upload, 422, 409 id collision); web proxies `GET /api/proof-sessions/[sessionId]/export` and `POST
/api/artifacts`. The landing page's "Upload artifact" works and "Fetch stored proof" offers "Download
    artifact". Tests: a full round trip; 16 tamper cases each rejected both by digest and after recomputing
    the digest; read-only enforcement across stores and 11 HTTP routes; fast-check for canonical JSON and
    session rebasing; an e2e export-and-upload.
  - Gaps: no UI marks an imported session read-only and `GET /proof-sessions/:id` does not expose the flag.
    Read-only is enforced by the worker, not a database trigger. Library rows are read in separate
    transactions. Additions and revisions share no sequence (timestamp ordering). No LLM store is wired
    (`llmCalls: []`). Setup edits and manifest stages are not stored. Revalidation uses the current approved
    catalog, so artifacts built on since-changed definitions may be rejected. Re-exporting an imported
    session returns the source's global library statically. No authentication.
  - Test-suite risk: under heavy parallel load, `proof-workspace.spec.ts:271` (spec files share
    `session:development`) and `:124` (dev-server navigation), the N37 suggestion budget and once the
    kernel `obligations.test.ts` 5 s timeout failed; all pass on a quiet machine (two full e2e runs: 16
    passed, only `:166` failed).
- 2026-09-29 — test hardening — `245b729` — e2e tests that record suggestions or mutate proof state build
  their own session through the N26 approval API (`apps/web/e2e/fixtures.ts` `createIsolatedSession`),
  so specs no longer race over `session:development`, which the suite now only reads (the reset
  `beforeEach` is gone). `apps/web/e2e/global-warmup.ts` (Playwright `globalSetup`) compiles every page
  and route the specs use before tests start. The N37 budgets moved to a serial vitest project
  (`apps/worker/vitest.perf.config.ts`, `npm run test:perf`), excluded from the parallel `npm test` and
  chained into `npm run verify`; budgets and measurement are unchanged. The kernel obligations property
  test has an explicit 30 s timeout (0.65 s alone). Under a concurrent `npm test`, the e2e suite and perf
  project were stable. The known modifier-multiselection failure is now `proof-workspace.spec.ts:176`
  (body unchanged).
- 2026-09-29 — N28 — `ca66c56`, `8f18ab8` — routes `/sessions/{id}/tree`, `/playback` and `/proof` read
  only the session's stored artifact through `readStoredProofArtifact` (`exportProofArtifact` +
  `parseProofArtifact`); imported read-only sessions work and are marked read-only. View models live in
  `apps/web/src/features/discovery-viewer/` (`tree-layout.ts`, `playback-timeline.ts`,
  `pruned-proof-view.ts`, `inquiry-context.ts`).
  - Tree: every retained node and edge including abandoned branches; edges show the chosen stored
    suggestion (or operation kind), transition class and stored route evidence; the detail panel shows the
    stored snapshot and stored displayed suggestion set in stored order. Playback merges stored
    transitions, interaction events and inquiry records with button and arrow/Home/End stepping. The
    pruned-proof viewer shows `final.prunedProof` in LaTeX/NL, the sorry assumptions it depends on (and
    separately those on abandoned branches), and links steps to motivating inquiry records rendered with
    `createInquiryExplainer`. The toolbar's "Open full discovery tree" is now a link.
  - No recomputation: solved status, route, pruned proof and sorry lists come from `artifact.final`.
    `no-recomputation.test.tsx` replaces kernel, move planning, retrieval and protocol discovery/preview
    functions with throwing spies and renders all three views; shown menus equal stored entries exactly;
    a static test forbids viewer imports of kernel, moves, retrieval or library. An e2e test follows the
    tree link for an isolated session and renders all three pages.
  - Gaps: transition events store no timestamp and export sorted by id, so playback is causal rather than
    wall-clock order (needs a stored per-session transition sequence). Abandoned-branch edges have no
    stored evidence. `.toolbarNote` CSS is now unused.
- 2026-09-29 — e2e fix — `c560aaa` — the long-standing `proof-workspace.spec.ts:176` failure
  ("modifier multiselection controls two-selection applicability", open since N15) is fixed without
  changing the test. Root cause: `move:expand-hypothesis-conjunction` had its only pattern on the
  hypothesis slot, so a goal-only selection never retrieved it. The move gains a target-slot pattern
  (wildcard `t`) through a new optional `extraPatterns` catalog field; retrieval's context gate offers
  the partly filled move only when a local `And` hypothesis exists; and a move suggestion's specificity
  is the max over its unresolved slots' patterns (`slotSpecificity`), so the default limit no longer
  crowds it out behind catch-all `requires-input` moves. Pattern count 33 → 34; the N37 coverage golden
  is unchanged. The workspace e2e suite now passes with zero failures.
- 2026-09-29 — N32 — `8aabb29` — worker `proof-http/library-routes.ts` adds read-only `GET
/proof-sessions/:id/library` (the approved catalog for the session's operators with its variant
  families, then stored global and session layers from `listLibrary`, or the import record's
  `finalLibrary` for an imported session) and `GET /proof-sessions/:id/library/events` (addition events in
  sequence order, admitted and rejected, with diagnostics). Nothing re-runs admission or variant
  generation. Web proxies and `readSessionLibrary`/`readSessionLibraryEvents` validate a structural
  schema (`library-drawer/api-contract.ts`).
  - `LibraryDrawer` (toggle + non-modal `<aside>`, mounted with a 2-line edit) has a pure view model:
    search over ids, names, descriptions, domains, renderings and provenance; filters by kind, domain and
    layer; grouping by layer with counts; text labels for approval, provenance and source. The detail view
    renders statement and premises with `StatementView` (LaTeX/NL), side conditions, directions, technique
    steps, a navigable variant family, provenance and approval. An "Addition events" tab lists admitted
    and rejected events. Escape closes the drawer only when focus is inside it, so the proof selection is
    kept.
  - Gaps: read-only (no add/author/approve UI; the N25 envelope handles additions). Catalog and stored
    artifacts are not deduplicated by id. Variant families come only from the approved catalog. No
    auto-refresh after additions made elsewhere. The worker casts the import record's JSON library to
    library types (validated at import). No e2e spec yet.
- 2026-09-29 — N34 — `d644f9f` — web `features/inquiry-panel`: a compact "Inquiry" panel mounted after the
  suggestion panel. It reads stored inquiry records through the new `GET
/api/proof-sessions/[id]/inquiry-records` proxy (`readInquiryRecords`, paged by `after`) and folds them
  with `currentInquiryStatus` (`inquiry-summary.ts`) into the active objective, current attempt, top
  obstruction or next requirement, and the snapshot's open `constructions`, worded by
  `createInquiryExplainer`. Later-interpretation relationships never select what is shown and are listed
  apart. `ConstructionTaskView` groups requirements by role (necessary / sufficient / heuristic) with
  candidates, status, scope, dependencies and outcome.
  - Actions, each one N25 envelope as the human web actor with no free-typed mathematics: "Investigate
    this hypothesis" (`investigate-hypothesis`), "Try this method" (`apply` with `inquiryMethod:
"try-result"` on the previewed result suggestion), "Construct an object" (`kernel-operation`
    `introduce-placeholder` on a selected existential goal), "Find sufficient conditions"
    (`record-inquiry`: Explore question + elective objective, no reason), "Use this" (`record-inquiry`: a
    manual attempt on the active objective). `inquiry-panel.spec.ts` investigates a hypothesis and
    constructs an object against the real kernel.
  - Gaps: no dedicated "sufficient conditions" question form (records Explore/`relationship`); no "used
    for" relation (records an attempt); "Try this method" covers library results only and needs an
    existing preview; construct dependencies are computed client-side and not editable; no
    add-requirement/add-candidate UI; status folding is client-side over all records; the panel is stacked
    below the suggestion panel.
- 2026-09-29 — N36 — `850bf9f` — idempotent migration runner (`npm run migrate`; `schema_migrations` by
  name and sha256, one transaction per file, advisory lock, changed-checksum and missing-file abort,
  `--status`, `--baseline`). The Postgres worker verifies at startup that every migration is applied and
  refuses to start otherwise; `PROOF_AUTO_MIGRATE=true` applies pending ones. `schema-coverage.test.ts`
  checks the stores' SQL against migrated tables and columns, that every memory-store entity has a table,
  and that the session-deletion table list covers every `session_id` table in dependency order.
  - Migration `0012` adds `proof_sessions.visibility` (private by default for new, imported and seeded
    sessions). Exporting a private session needs `?confirmPrivateExport=true` (403
    `private-export-unconfirmed` otherwise); `GET`/`PATCH /proof-sessions/:id/visibility`.
    `DELETE /proof-sessions/:id` hard-deletes a session and every dependent row (proof tables, inquiry,
    replay, interaction events, import record, session library, session-owned LLM records) in both stores;
    idempotent (204, then 404) and allowed on read-only imported sessions. Web DELETE and visibility
    proxies. The archived agentctl fixes (`release(true)` and the 0003 provenance constraint) were already
    present; the coverage test asserts they stay.
  - Gaps: visibility is not access control until authentication exists (anyone with a session id can
    read or delete it). Exports are not stored server-side. Nothing was run against live PostgreSQL.
- 2026-09-30 — export acknowledgement and e2e determinism — `9ebfadd`, `e5724d8` — N36 made the toolbar
  Export link and the landing "Download artifact" return 403 for private sessions. Both now read the
  session's visibility, export shared sessions directly, and ask "This session is private. Export it
  anyway?" before requesting `?confirmPrivateExport=true` (shared `ExportAction` in
  `stored-proof-workspace/export-action.tsx`).
  - E2E timeouts after N34/N36 were not a code regression (bisect: `proof-workspace.spec.ts:290` took the
    same time before and after, and with the inquiry panel unmounted). The `next dev` server stalled
    under load, serving compiled chunks in 17–27 s at high CPU with growing RSS.
    `playwright.proof-workspace-memory.config.ts` now runs `next build --webpack && next start`; the
    workspace e2e suite passes 20/20 in about 1.4 min. Click retries were replaced by a `data-hydrated`
    marker (`features/hydration/use-hydrated.ts`). The other two Playwright configs still use `next dev`.
- 2026-09-30 — N38 — `1ae642e` — `apps/web/e2e/mouse-only-flows.spec.ts` (+ `mouse-helpers.ts`), in the
  memory-worker config. One isolated-session test solves `corpus:conjunction-swap` with pointer
  interactions only: an accidental split is deleted through the confirmation dialog, a backtrack with
  information adds a case split, the original branch is finished with close-by-hypothesis, the session is
  exported through the private-session acknowledgement, reimported through the landing file chooser, and
  the read-only pruned proof (4 steps, no sorry dependency) and tree (6 nodes, 1 abandoned) are checked.
  MathLive selection uses the existing set-selection-then-`pointerup` convention, not a pixel drag. No UI
  gaps were found; a non-empty sorry list is not exercised.
- 2026-09-30 — N35 (backend; the editor UI is still open) — `e57aea3`, `716cd76` — moves `authoring.ts`
  (subpath export `@proof/moves/authoring`): a strict `authoredMoveTemplateSchema` (selection contract,
  patterns, parameters, required artifacts, a plan of 1–16 primitive steps, declared class, runnable
  examples). The contract and parameters are the first primitive's; later steps replay recorded
  N21-shaped selections, parameters and operations, re-matched on the previous state.
  `validateMoveTemplate` runs every example through `materializeMoveOperation`, `planMove` and a
  `planMoveSequence` cross-check, requires the declared class to equal the class composed from the kernel
  steps, and compares goals, obligations and class up to alpha-renaming (≥ 2 positive and 1 negative
  examples). `macroFromSemanticSteps`/`recordedMacroExample` build macros from recorded steps (fast-check:
  a recorded macro reproduces its outcome on alpha-renamed states).
  - Library artifact kind `move` (template, digest, author, review) is admitted only in
    `move-discovery-draft`; drafts and reviews are append-only addition events. Envelope commands
    `author-move-draft` and `review-move-draft` (human, `reviewed-authoring`); `GET
/proof-sessions/:id/authored-moves` and `POST /proof-sessions/:id/authored-moves/validate`. Approval
    re-validates and records the definition digest; rejections and change requests are recorded reviews.
    Approved single-step moves join the session-scoped catalog (`planMove`/`prepareProofCommand` carry
    `environment.moves`) and apply end to end over HTTP; drafts are never retrievable; re-approval changes
    the definition hash, so N19 regeneration applies.
  - Gaps: multi-step macros are validated, stored and approvable but not retrievable or applicable (one
    edge carries one kernel operation; apply a macro as a semantic replay). Macros cannot contain
    library-result steps. No promotion beyond `move-discovery-draft`, no withdrawal, and the author may
    review their own draft. Artifact import revalidates with the base catalog and may reject sessions
    that applied an authored move. No web proxy for the two new routes and no UI yet.
