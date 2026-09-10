# Motivated proof discovery: framework and implementation refinement

This document develops the general framework requested in the design discussion. It supplements [the original platform plan](platform-design-plan.md), which remains the reference for the surrounding application, persistence, and deployment architecture. It specifies proposed refinements rather than describing implemented capabilities.

## 1. Decisions established in the discussion

The platform should make it possible to construct proofs entirely through meaningful point-and-click interactions. The intended correspondence is between what can be constructed through those interactions and what mathematicians would intuitively regard as motivated. A user who already knows a construction must develop it through the available interactions if it is absent from the assumed background.

The discovery record should preserve the selections that elicited suggestions, the alternatives displayed, and the choices made. It should also express intermediate objectives, obstructions, and strategies systematically.

Construction metavariables are part of the intended design. They represent choices still being developed, distinct from metavariables used only for retrieval.

Ordinary variable names are acceptable in the mathematical representation. Capture avoidance and scope checking remain necessary, but a special nameless representation or globally unique identifier for every bound variable is not a requirement.

Mathematical side conditions may be supplied through approved lemma applications and their hypotheses. They need not all be independently encoded as domain-specific kernel rules.

The pruned proof should be the smallest self-contained retained subtree supporting a valid proof, with its necessary assumptions and dependencies. It is not a search for a globally shortest proof outside the retained history.

Prose is allowed when developing new general moves. Each extension is recorded and reviewed. Ordinary proof discovery remains constrained by the available point-and-click operations.

The framework should be developed generally, without organizing the design around one particular mathematical example.

The remaining sections propose how to realize these decisions. Existing commitments to semi-formal rigor, plain MathJSON, deterministic ranking, visible sorries, a rooted discovery tree, one command service, and human–agent parity continue to apply. No proof-assistant integration is introduced.

## 2. Point-and-click as an operational account of motivation

### 2.1 What the restriction must accomplish

The meaningful restriction is on how mathematical content becomes available. An unrestricted expression builder can function as a virtual keyboard. A button that offers a complete unexpected construction can conceal the same intellectual step as typing that construction.

Accordingly, the allowed interactions, their parameter choices, and their generated suggestions must themselves have mathematical structure. Every introduced expression or construction should have a recorded origin in existing objects, an approved library operation, a recorded search, or a reviewed move extension.

The platform should support exploratory construction and trial choices. It should not require a successful justification of usefulness before a move can be attempted. It should make the construction process and the options offered visible enough to assess afterward.

Motivatedness is relative to the stated background, the available moves, and the suggestion policy. The desired equivalence with intuitive motivation is a design target to test and refine, not a theorem established simply by disabling text entry.

There are two complementary failure modes:

- The interface permits an intuitively mysterious jump through a permissive constructor, oversized menu, or opaque move. Refine that operation or its required disclosure.
- A mathematician can give a convincing motivated account that the interface cannot express. Identify and develop the missing general move or interaction.

This gives move-library development a concrete purpose: improve the correspondence in both directions.

### 2.2 Admissible sources of mathematical content

A discovery action can use an existing selected object, instantiate an approved result with available parameters, apply an approved constructor, introduce a scoped placeholder, derive constraints through an approved method, or choose from a recorded admissible suggestion set.

Availability and mathematical truth are independent. An expression can be available to examine without satisfying its desired properties. A candidate lemma can be available to investigate without being a fact.

Constructor parameters should be offered by mathematically meaningful selection contracts. Ordinary operations and constants may be broadly available where appropriate; the system should record how they are combined, not pretend that availability alone proves the combination was insightful.

The initial setup establishes the problem and background. Prose move-authoring is a separate recorded activity. Neither is an unrecorded channel for inserting a desired construction into an ongoing proof.

All ordinary discovery actions, including selecting objectives and strategies, should work without text entry. Keyboard accessibility may activate the same actions; it does not add an unrestricted mathematical input channel.

### 2.3 Suggestions and automation

A short menu is useful but does not itself establish motivation. A suggestion records its generating method, exact selections, allowed context, active objective when relevant, and parameter-generation process.

Repeated requests for alternatives are new events. Store the rejected menus and any explicit search expansion. A result found after substantial search should not be presented as the first locally obvious suggestion.

Deterministic automation is still preferred. Routine calculations can be bundled when their operation sequence and relevant premises remain inspectable. Determinism alone does not justify hiding a substantive construction or an extensive search inside a move.

### 2.4 What a completed record establishes

A participant may already know the successful construction. The recorded interactions can still demonstrate a route by which it is obtainable from the declared resources. They do not establish that this was the participant's original psychological discovery process. When collecting research data, distinguish a reconstruction of a known argument from an attempt at an unfamiliar problem where that information is available.

Keep the original convention that sorries permit completion relative to explicit additional assumptions. Such completion does not supply a motivated account of the omitted mathematics. In particular, assuming the original goal cannot establish that a proof of it has been motivated from the original background. Display the assumptions and unresolved explanatory content with any claim about the artifact's scope.

Similarly, admitting a result or reviewing a new method changes the resources relative to which later discovery is assessed. The extension history remains part of that assessment.

## 3. A small language of mathematical inquiry

### 3.1 Mathematical content and inquiry records

Keep MathJSON as the authoritative representation of expressions and statements. Add structured records describing what the participant is trying to accomplish with those expressions. These records reference mathematical objects; they do not introduce a competing expression language.

The core vocabulary should be small:

| Record      | Meaning                                               | Principal contents                                                                  |
| ----------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Question    | Something to establish, construct, decide, or explore | Kind, mathematical references, local context, connection to the original problem    |
| Objective   | A question currently being pursued                    | Question reference, focus, intended outcome, whether logically required or elective |
| Attempt     | A method tried toward an objective                    | Method, selections, displayed suggestion, parameters, child objectives, status      |
| Requirement | A condition relevant to an attempt or construction    | Proposition, scope, necessary/sufficient/heuristic role, evidence                   |
| Observation | Something learned or noticed                          | Mathematical or diagnostic content, source, evidence status                         |
| Obstruction | A specific difficulty in a particular attempt         | Failed requirement or mismatch, affected method, evidence, potential responses      |
| Decision    | A choice about how to continue                        | Selected action, alternatives, optional selected reason, participant and time       |

An obstruction may reference an observation rather than duplicate its content. An objective is a focused use of a question rather than a second copy of the question.

### 3.2 Question constructors

Begin with four question forms:

- `Establish(P)`: seek an argument for a proposition in a recorded context.
- `Construct(m, T, C)`: develop an object of sort `T` satisfying requirements `C`.
- `Determine(P)`: investigate whether `P` or its negation can be established.
- `Explore(objects, aspect)`: investigate a selected structure, relationship, hypothesis, or family without requiring a predetermined conclusion.

Refutation is expressible by establishing a negation or constructing a counterexample. More specialized interface phrases can expand into these forms.

An elective question does not become an obligation needed to finish the original proof. The connection is recorded explicitly: a question may be sufficient for a goal, a special case, a possible source of information, or merely an exploratory direction. Claims about logical relationships require their own justification.

### 3.3 Relationships

Use different relationship types for mathematical support and heuristic motivation:

| Relationship                  | Interpretation                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| `wouldSufficeFor`             | Establishing these claims would establish that claim under specified assumptions       |
| `requires`                    | A method or construction needs the referenced condition or dependency                  |
| `motivatedBy`                 | A participant or method selected this action in response to the referenced observation |
| `addresses`                   | An attempt is intended to address a particular obstruction                             |
| `specializes` / `generalizes` | A recorded substitution or transformation relates questions                            |
| `tests`                       | An experiment or subsidiary attempt investigates a question                            |
| `reuses`                      | A method or result is imported with its context and dependencies                       |

`wouldSufficeFor` is a mathematical assertion and needs validated evidence or an explicit informal status. `motivatedBy` records a reason for considering an action and never serves as proof of its conclusion.

These relationships can be graph-shaped metadata over a rooted discovery tree. Equal states and replayed attempts retain distinct historical nodes; this does not replace the tree with shared proof-state nodes.

### 3.4 A compositional language for explanations

Generate explanations from the inquiry records using deterministic sentence templates. Useful forms include:

- “To establish [question], try [method] on [selected objects].”
- “This method would suffice if [requirements] were established.”
- “This attempt is blocked because [specific unmet requirement].”
- “To address [obstruction], investigate [new question].”
- “This construction is required to depend only on [available parameters].”
- “This choice satisfies [requirements] by [results or operations].”
- “This attempt was abandoned after [observation]; the next attempt uses [change].”

The interface can construct these records through cards, selections, and menus. Users do not need to complete a form before each routine move. Choosing “Try this theorem” can automatically create the corresponding attempt and its missing-premise objectives.

Do not fabricate intentions from actions. Record whether a reason came from an explicit user selection, an agent decision, an objective encoded in the chosen method, or a later suggested interpretation. Later commentary should not be presented as a contemporaneous reason.

The language is extensible through typed templates referencing existing objects. Free prose from move authoring does not automatically become mathematical content or a new live discovery command.

## 4. Strategies as inspectable methods

A strategy is a reusable method for organizing questions and attempts. It may contain ordinary proof moves, construction steps, subsidiary investigations, and responses to failure.

A strategy template contains:

- The question forms and selected features that make it relevant.
- Its required mathematical background and applicability conditions.
- The intermediate objectives it proposes and their intended relationships.
- Its parameter choices and how those choices are generated.
- Success conditions, recognizable obstructions, and possible continuations.
- Any bounded search or repeated step, including its stopping conditions.
- A default level of presentation detail and an expandable operation trace.

Strategies should be partial. They can leave an object unresolved or a question unanswered. The participant can revise or abandon them while preserving the attempt.

Generic strategy families include backward reasoning from a result, accumulating construction requirements, comparing special cases, strengthening a statement, choosing an extremal object, exploiting an available symmetry, and analyzing a failed induction step.

Strategy relevance is not a theorem that the strategy will succeed. A recognized pattern may justify offering a method without establishing that its proposed intermediate claims are true.

This draws on the proof-planning distinction between methods and failure analysis: a failed precondition can suggest a missing lemma or a change of conjecture. The proposal here is to expose that organization to a participant and preserve it as discovery data. [Planning and Patching Proofs](https://www.pure.ed.ac.uk/ws/files/408829/Planning_and_Patching_Proof.pdf)

## 5. Construction metavariables and requirements

### 5.1 What a placeholder means

A construction metavariable denotes a choice still to be made. It is neither an arbitrary universally quantified variable nor a fact that an appropriate object already exists.

The object may be a term, function, predicate, or proposition. This gives auxiliary functions, invariant predicates, and candidate lemmas a common construction framework. For an invariant, requirements can express initial validity, preservation, and usefulness. A candidate lemma has separate obligations to establish it and to show how it contributes to the target. These obligations remain open while the candidate is developed; representing them does not provide a universal synthesis algorithm.

A construction task records:

- The originating existential goal or auxiliary construction request.
- The object's sort, display name, and local scope.
- The declarations and other choices on which it may depend.
- Its desired properties and all accumulated requirements.
- The attempts that produced those requirements.
- Available candidate constructions and their provenance.
- Its status: unresolved, partially specified, resolved, or abandoned.

Plain MathJSON may represent an occurrence through a registered placeholder constructor referring to the task. A placeholder task can have a stable record identifier without requiring special identifiers for ordinary bound variables.

Distinguish universal variables, locally chosen witnesses, construction metavariables, and retrieval wildcards in validation and presentation. Identical-looking names do not make their logical roles interchangeable.

### 5.2 Three kinds of requirement

For an intended property `P(m)`, distinguish:

- Necessary condition `N(m)`: an argument establishes that `P(m)` implies `N(m)`. This can exclude candidates but does not suffice to finish the construction.
- Sufficient condition `S(m)`: an argument establishes that `S(m)` implies `P(m)`. Constructing an object satisfying `S` can finish the task, subject to all remaining obligations.
- Heuristic condition `H(m)`: a property worth investigating, with no established implication yet. It must not silently become an assumption.

The implications are contextual judgments, not just labels on formulas. Multiple conditions may be sufficient only jointly, and a requirement may depend on other assumptions or unresolved tasks.

Adding a promising requirement can make a construction problem harder or impossible. Preserve the earlier task so the condition can be reconsidered or removed through an explicit new attempt. A failed search is not evidence that the requirement is impossible.

### 5.3 Operations

Provide explicit operations to introduce a placeholder, derive a requirement, propose a heuristic requirement, introduce dependent subsidiary constructions, generate candidates with an approved method, test a candidate, and resolve the task.

Resolving a task substitutes the chosen construction through its dependent statements and validates scope, allowed dependencies, signatures, and remaining obligations. It does not close the task merely because a term fits its type.

Check dependencies transitively. Two placeholders must not evade restrictions through each other, and ordinary substitution must not introduce cyclic definitions. Recursively defined objects require an appropriate explicit construction principle and its obligations.

A construction can finish with a term, an admissible definition, or a legitimate choice from an existence result. The platform should not require every mathematical object to have a closed-form expression.

### 5.4 Parameter generation

Candidate generators should address recorded requirements. Examples of general families include combining compatible bounds, selecting an available extremal object, assembling a function from permitted operations, or satisfying a finite collection of structural constraints.

The generator records which constraints it targeted, the available operations, and the alternatives it considered or displayed. A scoped LLM may implement an approved generator, but its output must satisfy that generator's contract and pass the usual mathematical checks.

Gowers's discussion explicitly connects motivated existential choices with metavariables and accumulated conditions. Ganesalingam and Gowers also describe postponing choices while preserving quantifier dependencies. These support treating unresolved choices as a core feature of discovery. [Structured motivated proofs](https://gowers.wordpress.com/2025/09/22/creating-a-database-of-motivated-proofs/), [A fully automatic problem solver with human-style output](https://arxiv.org/html/1309.4501v1)

## 6. Making general discovery moves concrete

Each move should have a trigger, a visible output, and an explicit account of what that output establishes.

| Move family                                | Trigger and interaction                                              | Result and limitation                                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Work backward from a result                | Select a target and a result whose conclusion matches                | Create its undischarged premises as contextual obligations and record why they suffice                           |
| Collect construction requirements          | Select a placeholder and a desired property or attempted method      | Derive necessary or sufficient conditions, or propose explicitly heuristic ones                                  |
| Isolate an uncontrolled quantity           | Select an expression that prevents an estimate or construction       | Create a bound or auxiliary-object task with the required dependency restrictions                                |
| Combine constraints                        | Select compatible requirements and an approved constructor           | Produce a candidate and obligations establishing that the requirements hold together                             |
| Test the role of a hypothesis              | Select a hypothesis and the question in which it appears             | Investigate the statement with that hypothesis removed; a counterexample or proof can explain its role           |
| Compare special cases                      | Select a family and permitted instantiations                         | Record similarities and differences; suggest a generalization without treating it as proved                      |
| Repair an induction attempt                | Select the failed step and the induction hypothesis                  | Expose missing information and generate candidate strengthened statements with new base and step obligations     |
| Choose an extremal object                  | Select a candidate class and an available ordering or measure        | Create the required existence and attainment obligations, then permit the licensed choice                        |
| Normalize using a symmetry                 | Select a structure and an approved transformation                    | Record preservation conditions and any obligations needed to transfer the result back                            |
| Extract a conditional lemma                | Select a claim obtained in an attempt                                | Retain its assumptions, close permitted variables, and make its dependence on the establishing argument explicit |
| Repair a conjecture after a counterexample | Select the conjecture, counterexample, and relevant features         | Generate constrained variants; the repaired statement remains a question                                         |
| Transfer a method                          | Select a prior method and corresponding objects in the current state | Replay an adapted attempt with fresh checks and explicit differences                                             |

These are template families, not promises of complete automation across every domain. Domain packs supply applicable results, constructors, orderings, and structural comparisons.

For hypothesis testing, failure to prove the stronger statement establishes nothing about necessity. A counterexample must be checked against the precise statement being investigated. Likewise, failure of one induction strategy does not establish failure of induction in general.

The output of failure analysis should identify a specific unmet condition, failed match, forbidden dependency, or checked counterexample whenever possible. “The model is uncertain” and “no proof found within this search” are valid observations with more limited implications.

## 7. Move authoring and extension during discovery

### 7.1 Allowed prose authoring

When existing moves are insufficient, a participant may enter a recorded authoring activity and describe a new general move in prose. The system translates that description into a proposed template, examples, applicability conditions, and operation plan for review.

The current proof may motivate the proposal. There is no claim that the proposal arose independently of the proof. A generality review should nevertheless assess the template on other situations and boundary cases.

After approval, the move is available for subsequent interactions in the same session and for appropriate later sessions. Record the extension event, the approved definition, and the first use. Do not rewrite earlier menus or claim the move was in the original library.

### 7.2 What review examines

Review should distinguish mathematical correctness from suitability as a general discovery move:

- Does the operation plan respect the mathematical rules and required assumptions?
- Are the triggers and parameters intelligible from the stated input context?
- Does the method retain a problem-specific construction as an unexplained constant or encoded special case?
- Which parts are routine execution, search, or a substantive construction method?
- Can the proposed method be applied meaningfully to independently selected situations?
- Are its failure conditions and limitations visible?

Abstracting variable names or supplying two similar examples is useful evidence but cannot certify generality. Review remains a mathematical judgment, recorded with its rationale.

Some approved moves will encapsulate substantial mathematical ideas. Their description should say so. If the intended discovery account must explain that idea from a weaker background, its construction must itself be developed through available moves or a recorded further extension.

Do not require move authoring to recurse indefinitely into smaller moves. The declared background and reviewed method vocabulary supply the starting point for the account. The artifact makes those starting resources and subsequent extensions inspectable.

### 7.3 Three kinds of extension

Keep these separate:

- A macro packages an existing recorded method; its expansion remains available.
- A new heuristic proposes a reusable way to choose questions or actions; its success is not guaranteed.
- A new mathematical result or construction principle extends available knowledge and must pass the background-admission policy.

A method requiring an unavailable result cannot acquire that result merely by being approved as a move. Conversely, admitting a result does not establish that a particular application of it was motivated.

## 8. Names, scopes, and lemma-based guards

Ordinary names can remain authoritative in MathJSON. Use explicit binder scope rules, deterministic fresh-name selection when required, and capture-avoiding substitution. Resolve an occurrence using its enclosing binders and location, rather than comparing its display text across unrelated contexts.

The requirement is deterministic hygiene, not a mandatory choice of UUIDs or de Bruijn indices. Names generated by an LLM still need checking because collisions can also arise during substitution, importing a lemma, and replaying work in a new context.

Mathematical guards should normally come from the premises of the result that licenses an operation. Nonzero conditions for cancellation, sign conditions for inequalities, and existence conditions for choosing an object can all be handled through ordinary approved results and contextual obligations.

The kernel checks that the appropriate result was instantiated and that its premises were discharged or remain explicit. It need not contain a second independent implementation of every domain rule.

Parsing and displaying a partial expression does not establish that it is defined. Any inference that needs definedness must obtain it through the chosen mathematical policy and supporting results.

## 9. Logical support, informal evidence, and pruning

Each proof-relevant claim and transition retains its local context and evidence. Equivalence, strengthening, and weakening describe logical direction. Deterministic validation, approved-result application, background attestation, and explicit sorry assumptions describe how that direction or claim is supported.

The existing policy allowing bounded background-attested inferences can remain. Subsequent deductions preserve their dependency on those inferences. Nothing in this refinement upgrades them to foundational certification.

An attestation of a construction's correctness does not supply its missing construction history or make it an admissible suggestion. The generation contract and the mathematical evidence answer separate questions.

Construction tasks and heuristic requirements do not disappear simply because a branch reaches a convenient proposition. All requirements necessary for the selected proof route must be resolved or explicitly accounted for under the existing sorry policy.

A derived result reused outside an attempt must retain or discharge that attempt's assumptions. Finding that its variable names are available in an ancestor is insufficient. Replay produces fresh instances with fresh validation; historical nodes are not silently reattached under different assumptions.

Pruning starts from the chosen successful argument, retains its required cases and transitive dependencies, and removes material unnecessary to that argument. If alternative retained arguments exist, proof selection and minimization operate within that history. The first implementation should state its pruning criterion and not claim a stronger global minimality guarantee than it provides.

The pruned view should retain links to the motivational records for its significant constructions. A failed branch can be unnecessary for validity yet explain the successful choice. Such context remains available through those links in the full discovery record; it need not be inserted into the logical proof as a premise.

## 10. Interaction design

The existing proof workspace remains the primary view. Add a compact inquiry panel showing the active objective, current attempt, unresolved construction choices, and the most relevant obstruction or next requirement.

The participant can select an object and choose an action such as “Use this,” “Construct an object,” “Find sufficient conditions,” “Investigate this hypothesis,” or “Try this method.” Labels expand into the structured records described above.

Suggestion cards should state both their proposed mathematical effect and their intended role in the active inquiry. Where there is no declared strategy, ordinary local exploration remains available.

Show a small, deterministically selected variety of suggestions: moves that apply immediately, promising applications with missing premises, construction methods, and investigations of a recorded obstruction. Explain why a candidate belongs in its category. Preserve access to further candidates through recorded interactions.

Routine actions should not require an extra explanation click. More significant strategic choices can expose optional reason cards derived from the selected method and current observations. Reasons are adopted only by an explicit choice or by the stated semantics of the chosen action.

The final viewer should support the successful proof, the construction history of any selected object, and the retained discovery chronology through the same stored artifact. These are views over recorded information, not model-generated reconstructions of what the participant must have thought.

## 11. Human and agent parity

Humans and agents use the same command service and action contracts. An agent can select a statement, invoke a method, choose a generated candidate, or enter the explicit authoring workflow. It cannot bypass construction restrictions by submitting an arbitrary expression in a parameter field.

Discovery command parameters should ordinarily refer to current objects, selections, constructor choices, or candidates previously generated for that state. Commands introducing new mathematical payloads require an explicit authorized source: setup, an approved generator, a validated operation, or reviewed authoring.

Stateful agents may keep strategy summaries, but prose in those summaries does not itself become an available term, premise, or move. Scoped services receive the relevant structured objective or obstruction only when their contracts permit it.

Store what each service received and produced. This exposes the platform-controlled information boundary; it cannot establish that a pretrained model had no prior familiarity with the problem or construction.

## 12. Durable records and command behavior

### 12.1 Record events without requiring a proof-state change

Suggestions, selections, rejected previews, objective changes, observations, and authoring discussions may occur without a mathematical transition. Give them their own ordered interaction events anchored to a proof node.

Each suggestion interaction records:

- Its proof snapshot and active library/move definitions.
- Exact selections, virtual lenses, abstractions, and active inquiry references.
- The generation method, permitted context, and any recorded search expansion.
- The ordered menu actually displayed and previews requested.
- The selected action or the fact that the interaction ended without one.

Derived state changes, inquiry changes, and their events should be committed through the same validated command service. Only the mathematical portion of a command invokes mathematical transition rules; changing focus need not be presented as a proof step.

### 12.2 Coherent application

A preview references the state and approved definitions against which it was created. Applying it checks that those references still match. If they do not, generate a fresh preview and record the change instead of silently applying a different operation.

Retries should not duplicate accepted commands or construction resolutions. Use command identifiers and atomic persistence for the accepted change and its event record. Long-running generation can complete independently, but its result must be checked against the state to which it will be applied.

### 12.3 Static export

Extend the existing self-contained artifact with question, attempt, requirement, placeholder, obstruction, decision, strategy, and authoring records.

Keep explicit artifact schema identifiers and the exact mathematical/move definitions needed to interpret the record. Store the presentation material necessary for documentary replay. This does not require rerunning historical models or preserving a runnable installation of every old dependency.

The product continues to use PostgreSQL and JSONB. Development orchestration state remains outside the product data model.

## 13. Implementation plan

The sequence below refines the original stages. Each slice should produce an observable capability and test its semantic boundary before expanding coverage.

### Slice 1: Contracts for mathematical and inquiry state

Define the statement context, name/scoping rules, construction-task lifecycle, requirement roles, inquiry records, and permitted discovery command inputs. Specify which operations change logical obligations and which merely organize investigation.

Exit condition: the contracts distinguish an unresolved choice, a conjecture, a fact, a sufficient requirement, and a heuristic preference; arbitrary mathematical content cannot enter through an ordinary selection command.

### Slice 2: Deterministic proof with durable interaction history

Extend the interaction spike into a small proof-state workflow with approved result applications, contextual obligations, proof nodes, independent interaction events, and a basic static export/viewer. Strengthen occurrence mapping as notation support expands.

Exit condition: a proof can be completed, exported, reopened, and inspected with the menus and selections that actually occurred, including interactions without committed moves.

### Slice 3: Inquiry language and initial strategy templates

Implement the four question constructors, objectives, attempts, requirements, observations, and deterministic explanatory templates. Add a small set of general methods such as backward reasoning and hypothesis investigation.

Exit condition: a participant can create and revise an intermediate objective, encounter a specific obstruction, and initiate a related investigation entirely through the interface. The record distinguishes inferred commentary from adopted intentions.

### Slice 4: Construction metavariables

Implement permitted dependencies, accumulated requirements, candidate generation through approved constructors, partial specifications, contextual substitution, and resolution. Preserve alternative attempts when requirements are reconsidered.

Exit condition: an existential or auxiliary construction can be developed incrementally; a necessary or heuristic condition cannot be mistaken for a sufficient solution; illegal or cyclic dependencies are rejected.

### Slice 5: Failure analysis and information transfer

Add structured failed-premise diagnostics, conditional lemma extraction, comparison of attempts, and semantic replay. Connect these to weakening branches, case splits, and the existing provability-route calculation.

Exit condition: a discovery in an unsuccessful attempt can motivate a new attempt, and any reused mathematical result carries its required assumptions. Pruning preserves all logical support and links back to relevant motivation.

### Slice 6: Retrieval organized around inquiry

Index approved results, methods, and construction patterns. Implement deterministic ranking with useful category diversity, near-miss applications, and previews of new requirements. Record menu expansions and search limits.

Exit condition: suggestions explain both where they apply and which current objective or obstruction they address, without losing ordinary local exploration.

### Slice 7: LLM roles and prose move authoring

Add setup formalization, bounded generators, shortlisting, attestation, and the explicit move-authoring workflow. Apply background admission separately from method review. Enforce the same discovery restrictions for stateful agents.

Exit condition: a reviewed general move can be developed during a session, applied afterward, and reused elsewhere with its provenance intact. Neither prose memory nor an arbitrary model output bypasses construction or evidence requirements.

### Slice 8: Broader methods and artifact hardening

Expand domain packs and general strategies based on observed gaps. Complete the construction-history viewer, pruned-proof presentation, privacy controls, accessibility, import validation, and performance work.

Exit condition: the artifact supports inspection of the successful argument, the origin of its significant constructions, the attempted alternatives, and the evolution of the available methods.

## 14. Evaluation

### 14.1 Mathematical invariants

Test capture avoidance, scope and quantifier dependencies, placeholder resolution, dependency cycles, conditional lemma reuse, result premises, all required cases, and propagation of informal and sorry dependencies.

Test that necessary conditions and failed searches cannot close construction tasks, that heuristic requirements cannot become facts implicitly, and that derived results cannot escape branch assumptions.

### 14.2 Fidelity of the discovery account

Test preservation of selection origins, displayed menus, rejected previews, objective changes, authoring extensions, and adapted replay. Static viewing must not regenerate missing historical content.

Test that later interpretations are labeled as later, and that a method's stated purpose is not automatically attributed to the participant's private intention.

### 14.3 Adequacy of the motivation framework

Use two complementary review exercises across mathematical domains:

- Attempt to express convincing motivated arguments and document the missing interactions.
- Attempt to encode unexplained constructions through permissive menus or moves and document the loopholes.

Assess whether a reader can trace the significant objects and lemmas back to the operations, questions, and available knowledge that produced them. Do not equate a low click count, a proof's correctness, or a model's confidence with motivatedness.

### 14.4 Generality and usefulness

Review proposed moves on independently selected situations and boundary cases, preserving the distinction between mathematical validity and heuristic effectiveness. Measure reuse, construction coverage, frequency of useful failure diagnoses, menu quality, interaction burden, and required authoring extensions.

These observations should guide human revision of methods and deterministic ranking. They do not introduce automatically learned ranking.

## 15. Questions to resolve through implementation

No further foundational decision is needed to begin the framework above. The following are implementation questions to test rather than reasons to postpone the design:

- Which constructor and strategy families provide enough freedom without behaving as unrestricted input channels?
- How much inquiry structure can be recorded automatically without misattributing intentions or burdening interaction?
- Which recurring obstructions admit reliable deterministic diagnosis?
- How should method review distinguish useful abstraction from a renamed special-case solution?
- Which parts of a successful construction's motivation should be expanded by default in the pruned viewer?

The answers should refine the operational account of motivation while preserving the agreed boundaries: constrained discovery, explicit construction, reviewable extensions, and an honest record of what happened.
