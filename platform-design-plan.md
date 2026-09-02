# Interactive Mathematical Discovery Platform

## Concrete Design and Implementation Plan

## 1. Executive summary

The platform is an interactive environment for discovering, applying, studying, and generalizing mathematically meaningful proof moves. Its primary interaction is pointing and clicking on terms, subexpressions, and logical substatements in a proof state, followed by selecting an applicable result or move from a short, ranked menu. Text entry remains available where genuinely needed, but the system is designed so that most proof development can be performed with the mouse.

The project is not intended to be a conventional formal theorem prover, an axiomatic proof checker, or a simplified frontend for an existing proof assistant. Its purpose is to make mathematical problem solving observable. By restricting the available actions at each step, recording all suggestions and choices, and exposing move implementations, the platform should reveal:

- Which conceptually meaningful moves are needed to solve a problem.
- Where those moves apply and where they fail.
- How a move can be expressed as a deterministic and inspectable algorithm.
- Which new moves are needed when the existing library reaches its limits.
- How key constructions and ideas arise during an actual search for a proof.
- How human and AI problem-solving behavior differs under the same interface.

The system uses an LCF-inspired trusted transition kernel, but aims only for the level of rigor ordinarily found in good mathematical writing. Deterministic computation is preferred whenever possible. LLMs are used for library construction, initial formalization, bounded semantic judgments, operation-plan generation, and move discovery, but they do not directly mutate proof state. Every change passes through explicit platform operations.

MathJSON is the ground truth for mathematical expressions. LaTeX and natural language are deterministic projections of it. The rooted proof tree is independently the ground truth for the proof-discovery process, containing static snapshots of proof states, selections, suggestion menus, previews, library changes, and decisions. The final artifact supports both documentary replay of the full search and a pruned presentation of the successful proof.

## 2. Philosophy and design principles

### 2.1 The process is the primary object

The principal object captured by the platform is not merely the final proof. It is the path by which a human or agent arrived at it: what was selected, what was available, what was suggested, what was tried, what failed, what was added to the library, and what new move was discovered.

The platform should therefore preserve unsuccessful but intentional work. Backtracking creates new branches rather than erasing old ones. Only a genuine accidental final move may be deleted explicitly.

### 2.2 The tool bends to the user

The system should adapt to ordinary mathematical notation and practice rather than force users into a narrow foundational language or one canonical formulation of every concept.

- Different formulations of the same theorem may coexist.
- Closely related theorem variants are welcome when they improve applicability.
- Custom notation should be introduced by extending MathJSON and its renderers.
- Nonstandard research constructs should not require reformulation into an unrelated supported idiom.
- Selections that are not literal tree nodes should be treated as virtual subexpressions when this is deterministic and reasonably simple.
- The interface should snap or fall back gracefully when a requested interaction is genuinely ambiguous.

### 2.3 Deterministic computation before LLM calls

Use deterministic algorithms for parsing, rendering, selection, polarity, matching, indexing, filtering, ranking, substitution, scope checking, deep replacement, replay, state transformation, and proof-path classification.

An LLM is used only when the necessary operation cannot be obtained adequately from deterministic computation, or when its role is inherently semantic or generative. Even then, its output is structured, bounded by a specific role, recorded, and converted into explicit platform operations before execution.

### 2.4 Semi-formal rigor with visible assumptions

The platform distinguishes deterministic structural validation, use of operator-approved library results, background-level informal inference, and user-selected sorries. The result may count as solved with sorries, but those sorries are displayed explicitly as universally closed additional assumptions in the final artifact.

The system never presents this as foundational proof certification. It presents an inspectable mathematical argument relative to an explicit background and any additional assumptions.

### 2.5 Human and agent parity

The human interface and agent interface use the same command layer and mathematical engine. A human selects rendered expressions with the mouse; an agent supplies compact statement identifiers and operand paths. Neither receives privileged state-mutation capabilities.

### 2.6 Information discipline

LLM roles receive only the context required for their specific task wherever possible. This reduces token use and helps distinguish a genuinely local suggestion from one tailored using knowledge of the entire problem.

A stateful proof agent is an explicit exception: when an LLM itself operates the platform, it must remember the problem, previous decisions, failed approaches, and current strategy. Its proposals are labeled as stateful-agent proposals rather than being represented as context-independent suggestions.

## 3. Mathematical and product scope

The platform should be able to represent and support work across:

- Textbook first-order logic.
- Olympiad-style problem solving.
- Undergraduate mathematics across domains, including algebra, analysis, number theory, combinatorics, linear algebra, geometry, sets, and functions.
- Higher-order functions and predicate-valued functions.
- Some research mathematics, including unfamiliar structures and notation through custom operators.

Representational breadth should be available early. The strength of deterministic automation will initially vary by domain and should expand through the discovery and implementation of general moves.

### Permanent non-goals

The following are not part of the project:

- Foundational proof reconstruction down to basic axioms.
- Conventional proof-assistant certification.
- Integration with Lean, Coq, Isabelle, or automated theorem provers.
- Real-time multiuser editing.
- A public move marketplace.
- Automatic promotion of proposed moves without review.
- Personalized or learned suggestion ranking.
- Mobile-first interaction.

Progressively broader deterministic automation is a long-term objective and remains central to the project.

## 4. End-to-end user journey

### 4.1 Landing page

The landing page offers three primary actions:

1. Enter a new mathematical problem.
2. Upload a previously exported proof artifact.
3. Fetch a stored proof from the database for exploration.

For a new problem, the user supplies:

- The problem statement.
- The assumed level and content of background knowledge.
- Optional domain or notation preferences.

### 4.2 Topic and vocabulary manifest

An LLM examines the problem and background and proposes a constrained manifest containing:

- Mathematical domains involved.
- Visible kinds of objects and structures.
- Notation and terminology.
- Background topics that appear relevant.
- Custom operators likely to be required.

The manifest is shown for approval. It should not contain a disguised solution or highly tailored intermediate lemmas.

### 4.3 Initial library construction

A librarian LLM receives the approved manifest and background profile and constructs a broad relevant library of:

- Definitions.
- Results.
- Techniques.
- Existing moves.
- Useful closely related variants of results.
- Natural-language and notation entries.

The user reviews, edits, removes, and approves library entries. This review is the main protection against hallucinated or inappropriately stated results.

The initial library should be built carefully enough that proof-time expansion is uncommon, although later additions remain permitted.

### 4.4 Initial proof-state construction

A proof-state formalizer receives the original problem and approved library and proposes:

- Variables and local declarations.
- Hypotheses.
- One or more goals.
- Required custom MathJSON operators.
- Formal and natural-language renderings.

The user reviews and approves the state before proof discovery begins.

### 4.5 Proof discovery

The user or agent selects one or more expressions or statements. The system:

1. Resolves the selections to MathJSON subexpressions or supported virtual selections.
2. Computes their types, logical polarity, locations, and context.
3. Queries the indexed library and move registry.
4. Filters candidates deterministically.
5. Ranks the remaining candidates deterministically.
6. Produces previews, including required obligations and expected proof-state changes.
7. Shows a short list of applicable results and moves.

The selected move is converted to primitive operations, validated by the kernel, and committed as a new child in the proof-discovery tree.

### 4.6 Completion and exploration

When the original goal has been closed by an acceptable path, the session is considered solved. The user can explore:

- The complete discovery tree.
- A chronological playback of the retained interaction history.
- A pruned proof containing only the successful strengthening and equivalence route, necessary case analysis, and explicit additional assumptions.
- The formal MathJSON representation.
- The deterministic LaTeX and natural-language presentations.

The complete proof artifact is stored and can be exported as JSON.

## 5. Authoritative mathematical representation

### 5.1 MathJSON as ground truth

All mathematical expressions are stored authoritatively as plain MathJSON. The Compute Engine is used to box, inspect, match, transform, and serialize expressions, but boxed or canonicalized representations do not silently replace stored MathJSON.

Canonicalization may be requested by a particular move or used transiently to build retrieval keys. It is never an automatic global normalization policy.

This allows expressions such as `x+1` and `1+x`, or different formulations of continuity, to remain distinct when that distinction is useful.

### 5.2 Terms

A term is an arbitrary well-formed MathJSON expression. The platform should support:

- Symbols and literals.
- Application.
- Function literals and lambda abstraction.
- Higher-order functions.
- Function and predicate variables.
- Function signatures and typed parameters.
- Tuples, records, sets, sequences, and indexed families.
- Integrals, limits, sums, derivatives, and binders.
- Domain-specific and custom operators.

### 5.3 Statements

Statements form a separate inductive TypeScript type implemented as a validated proposition-valued subset or view of MathJSON. It contains:

- Atomic predicates and relations.
- Equality and inequalities.
- Conjunction.
- Disjunction.
- Implication.
- Equivalence.
- Negation.
- Universal quantification.
- Existential quantification.
- Truth and falsity.
- Extensible custom proposition-valued operators.

There is no duplicate statement tree. The inductive statement API is a typed way of constructing and traversing the same authoritative MathJSON.

### 5.4 Higher-order logic

The platform uses classical logic and permits higher-order syntax where possible:

- Variables may have function or predicate types.
- Functions may be passed to and returned from other functions.
- Quantifiers may range over functions and predicates.
- Lambda expressions and applications are ordinary terms.
- Extensionality and other higher-order principles are approved library results rather than hard-coded foundational axioms, except for classical logical primitives.

The kernel checks bindings, declared signatures, well-formed application, and permitted statement construction. It does not implement a complete foundational higher-order logic.

### 5.5 Custom operators

When standard MathJSON lacks a required mathematical construct, the platform creates a custom operator. An operator definition contains:

- A unique internal identifier and display name.
- Arity or parameter schema.
- Input and output types or sorts.
- Binding and scoping behavior.
- LaTeX parse and serialization rules.
- Natural-language rendering rules.
- Optional domain and notation metadata.

Approved custom operators persist globally and are available to all future proofs. Stable operator identifiers are syntactic identities; they do not imply that the platform has established canonical equivalence between mathematical concepts.

## 6. Deterministic presentation

### 6.1 LaTeX

LaTeX is generated deterministically from MathJSON using the Compute Engine and an extensible LaTeX dictionary. Every custom operator must supply suitable serialization, and where input is supported, parsing rules as well.

The displayed LaTeX is a projection, not a second mathematical source of truth.

### 6.2 Natural language

The natural-language layer is an extensible deterministic renderer in the compositional style associated with Ganesalingam's work on mathematical language. It contains:

- Renderers for statement constructors.
- Exact MathJSON-to-language entries.
- MathJSON-pattern templates.
- Operator-specific renderers.
- Domain terminology packs.
- Binder naming and referring-expression rules.
- Precedence, plurality, article, and agreement rules.
- Problem-local overrides.

An LLM may propose a translation or template. Once approved, it is added to the persistent dictionary and future rendering is deterministic. Different expressions and formulations may have different entries; no canonical concept registry is required.

## 7. Proof states and logical position

A proof state contains:

- Local variables and declarations.
- Hypotheses.
- One or more open goals.
- Pending obligations.
- The assumed background profile.
- The active library and any proof-time additions.
- Additional assumptions created by user-selected sorries.
- Focus and selection state for the current interaction.

Each hypothesis and goal has a stable statement identifier within its stored state snapshot.

### 7.1 Polarity

Polarity is computed deterministically over statement constructors:

- Goals begin in positive position.
- Hypotheses begin in negative position.
- Negation reverses polarity.
- The antecedent of implication reverses polarity.
- The consequent preserves polarity.
- Quantifiers preserve polarity.
- Non-monotone contexts may be marked mixed.
- Term positions are neutral but retain their semantic role.

Polarity informs highlighting, deep inference, theorem direction, applicability, and ranking.

## 8. Selection and interaction semantics

### 8.1 Exact subtree selections

An exact occurrence is identified by:

- Proof-state snapshot.
- Declaration, hypothesis, goal, or obligation identifier.
- Operand path into its MathJSON expression.
- Type and polarity.

Operand paths distinguish identical expressions occurring in different locations.

### 8.2 Virtual subexpression selections

A mouse selection that is not exactly a stored MathJSON subtree should first be treated as a virtual subexpression when extraction and reinsertion are deterministic and not excessively complex.

A virtual selection lens records:

- The selected MathJSON fragment.
- The containing expression.
- The covered operand paths or display range.
- A deterministic extraction operation.
- A deterministic replacement operation.

Initial support should cover:

- Contiguous operands under associative operators such as addition, multiplication, conjunction, and disjunction.
- Complete argument ranges.
- Complete sides of relations.
- Other MathLive selections that yield a well-formed fragment with an unambiguous splice operation.

If a deterministic selection lens cannot be constructed, snap to the smallest enclosing genuine MathJSON subtree. The interface highlights the actual interpreted selection before suggestions are generated.

Selections spanning unrelated regions become a multiselection rather than one excessively broad enclosing expression.

### 8.3 Selection gestures

Recommended interactions are:

- Click: select the smallest semantic expression at the pointer.
- Repeated click or an expansion gesture: select its semantic parent.
- Modifier-click: add or remove a selection.
- Drag: select a visible range and attempt to construct a virtual subexpression.
- Abstract selection: replace the selected fragment with a typed or untyped metavariable for retrieval only.
- Escape or toolbar action: clear selections.
- Drag a result onto an expression: preview deep application or rewriting.
- Drag a hypothesis onto a goal: preview use, specialization, or rewriting.
- Drag a term onto a binder or argument slot: preview instantiation or application.

All non-obvious gestures show a state-difference preview before committing.

## 9. The transition kernel

The kernel is a small trusted state-transition layer. It verifies operations and state relationships, not derivations down to foundational axioms.

Its primitive responsibilities include:

- Validate MathJSON and statement structure.
- Validate declarations, scopes, binders, and signatures.
- Perform capture-safe substitution.
- Extract and replace subexpressions at operand paths or supported selection lenses.
- Construct logical statements.
- Introduce and instantiate quantifiers.
- Introduce variables and hypotheses.
- Add derived facts.
- Apply approved library results through matching and instantiation.
- Rewrite terms and statements in permitted logical positions.
- Split conjunctions, disjunctions, implications, existentials, and cases.
- Close a goal by an available fact, contradiction, or accepted inference.
- Create and discharge obligations.
- Record the transition class and resulting state.

An LLM-generated plan is accepted only as a sequence of these operations. The LLM never edits proof-state storage directly.

## 10. Equivalence, strengthening, and weakening

For a transition from state `S` to state `T`:

- **Equivalence:** `S` is provable exactly when `T` is provable.
- **Strengthening:** proving `T` is sufficient to prove `S`.
- **Weakening:** proving `S` would imply `T`, but proving `T` does not establish `S`.

Weakening is a bona fide move class. It is not called exploratory. It supports mathematically useful actions such as temporarily adding an unproved hypothesis or replacing a goal with an easier one.

Only equivalence and strengthening edges count toward a provability path. Weakening branches remain part of the discovery tree and may reveal an intermediate proposition, construction, counterexample, missing condition, or new move. Their information can later be incorporated soundly through backtracking, case analysis, or a discharged obligation.

## 11. Background inference, obligations, and sorries

When the kernel cannot validate an LLM-proposed semantic step deterministically, a quick attestor receives the exact local before-and-after inference and the relevant portion of the background profile.

It returns a structured judgment containing:

- Correct, incorrect, or uncertain.
- Whether the step falls within the assumed background.
- Assumptions used or introduced.
- Relevant background item or classification.
- Confidence and concise rationale.

If the step is judged correct and within the assumed background, it is recorded as an informal background inference and the platform proceeds automatically.

If it is more substantial, the user may mark the obligation as a sorry. A sorry is a meta-level extension of the ambient assumption set, not an ordinary weakening edge in the proof path. Suppose the obligation occurs under local variables `x1,...,xn` and local hypotheses `H1,...,Hk`, with conclusion `G`. The additional assumption exported is the universally closed form:

`for all x1,...,xn, (H1 and ... and Hk) implies G`.

Only variables and hypotheses on which the obligation depends should be included where dependency analysis is available.

A result is considered solved even when it contains user-selected sorries. The final artifact states clearly that it is solved relative to the listed additional assumptions. Only the universally closed form of each sorry is shown in the final assumption list, although the discovery record retains the local event needed to explain where it arose.

## 12. Library design

### 12.1 Artifact classes

The library contains four related but distinct artifact types:

- **Definition:** introduces mathematical notation or a concept.
- **Result:** states reusable mathematical content.
- **Technique:** describes a heuristic proof strategy or construction.
- **Move:** gives an algorithmic proof-state transformation.

A result is mathematical content; a move is a method that may depend on one or more results. Keeping them separate makes it possible to determine whether progress came from knowing an additional fact, recognizing an application, or inventing a new algorithm.

### 12.2 Result data

A library result contains:

- MathJSON statement.
- Deterministic LaTeX and natural-language renderings.
- Premises and side conditions.
- Permitted application directions.
- Matching patterns.
- Type and polarity requirements.
- Domain and background classification.
- Provenance and approval state.
- Related definitions, results, techniques, and moves.
- Optional variant-family membership.

### 12.3 Closely related variants

Closely related formulations are stored independently when they improve matching or interaction. Examples include forward, converse, contrapositive, local, global, curried, uncurried, pointwise, specialized, and differently bundled forms.

Variants may be grouped with an optional family identifier, but they are not deduplicated or forced into a canonical statement. Every variant is indexed separately. The UI may display the best-matching member with an expandable related-forms group, while materially different applications remain separate suggestions.

### 12.4 Proof-time additions

Proof-time suggestion services, move executors, humans, and stateful proof agents may add results to the library.

Every addition is an explicit, visible library-addition event:

1. Construct a general MathJSON statement.
2. Remove accidental problem-specific naming where appropriate.
3. Classify the entry and its background level.
4. Check that an imported or assumed result lies roughly within the assumed background.
5. Record its origin and approval.
6. Add it to the active library.
7. Resume retrieval or move execution.

If an external result falls outside the background, it may not be silently added. The background must first be explicitly revised. A result proved during the current session may be indexed separately as a derived result, carrying a dependency on the proof node that established it rather than being treated as assumed background.

The evolving library has visible layers:

- Persistent global library.
- Initial problem library.
- Proof-time background additions.
- Results derived in the current proof.
- Closely related variants.
- Draft additions associated with move discovery.

A result added during a session becomes available from that time onward, including after backtracking. Earlier suggestion menus remain stored exactly as originally displayed; requesting suggestions again creates a new event using the enlarged library.

## 13. Move design and discovery

### 13.1 Move template

A move is a persistent, inspectable template containing:

- Name and mathematical description.
- Selection contract, including number and roles of selections.
- MathJSON matching patterns.
- Type, polarity, and context requirements.
- Side conditions.
- User parameters, preferably selected from menus.
- Required library results and definitions.
- Deterministic plan or plan-generation procedure.
- Transition class: equivalence, strengthening, or weakening.
- Preview renderer.
- Positive examples.
- Negative examples and counterexamples.
- Discovery context and provenance.
- Approval status.

A standard visual authoring form should let users create a move without writing implementation code where possible.

### 13.2 Implementations

A move may be implemented by:

- A fully deterministic transformation.
- A deterministic template with parameter search.
- A deterministic matcher followed by an LLM-generated kernel-operation plan.
- A bounded informal inference accepted through the background-attestation policy.

The conceptual move remains stable even if its implementation later becomes more deterministic.

### 13.3 New move discovery

If no existing library result or move applies, a stronger model may propose a new general move using the minimal useful local situation plus the stateful agent's explicit strategy when agent mode is active.

The candidate should:

- Be natural and conceptually meaningful.
- Abstract away problem-specific constants where possible.
- State its applicability conditions.
- Identify required results or background principles.
- Supply at least two positive examples and one negative example or boundary case.
- Give an inspectable operation-plan template.
- Explain how the current situation motivated it.

After discussion and approval, the move is stored permanently together with its discovery context. Automatic promotion without review is not permitted.

## 14. Retrieval, filtering, and ranking

### 14.1 Indexing

Use a discrimination tree or equivalent structural index over MathJSON. Index keys may include:

- Selected operator sequence and arity.
- Raw subtree shape.
- Transient normalized shape.
- Ancestor operators and semantic role.
- Type or higher-order function signature.
- Logical polarity.
- Proof-state section.
- Number and relationship of selections.
- Abstracted metavariables.
- Available relevant hypotheses.

The index operates over every theorem variant and move pattern.

### 14.2 Filtering

After structural retrieval, filter candidates through:

- Exact or variation-aware MathJSON matching.
- Typed unification.
- Binder and scope checks.
- Polarity requirements.
- Side-condition evaluation.
- Selection-contract compatibility.
- Availability of required library dependencies.

### 14.3 Deterministic ranking

Rank candidates with a deterministic, inspectable lexicographic policy such as:

1. Guaranteed applicability.
2. No new obligations.
3. Exact type and polarity fit.
4. Structural specificity.
5. Expected direct progress on open goals.
6. Locality of the transformation.
7. Curated library priority.
8. Stable identifier tie-break.

Do not use personalized or automatically learned ranking. Interaction data may guide later human redesign of moves and ranking rules.

### 14.4 Fallback hierarchy

The suggestion hierarchy is:

1. Deterministic library matching and ranking.
2. Deterministic move applicability checks.
3. A single-pass lightweight LLM shortlist of existing candidates when deterministic applicability is insufficient.
4. LLM construction of a selected move's kernel-operation plan.
5. General move discovery when no available move is adequate.
6. Explicit proof-time library addition when an appropriate background result is missing.

The LLM fallback is triggered automatically when deterministic suggestions are empty and may also be available as an explicit user action.

### 14.5 Preview

Top candidates receive previews showing:

- Why the result or move applies.
- Which expressions matched which parameters.
- The proposed kernel-operation sequence.
- Expected proof-state difference.
- New variables, goals, hypotheses, or obligations.
- Transition class.
- Whether an LLM or informal attestation is involved.

Preview generation may occur concurrently with candidate filtering, but no state is changed until the move is committed.

## 15. Separation of concerns and LLM context

### 15.1 Stateful proof agent

When an LLM operates the platform, it is a stateful proof agent. It may retain:

- The original problem and background.
- Current strategy.
- Facts and constructions discovered.
- Failed approaches.
- Pending ideas.
- Important previous selections.
- Branches worth revisiting.
- Library additions and candidate moves.

This durable state should be stored as explicit summaries and decisions in the platform rather than only in an ever-growing hidden conversation transcript. The platform does not attempt to store hidden chain-of-thought.

The agent uses the same selection, suggestion, application, library, backtracking, replay, and export commands as a human.

### 15.2 Scoped services

Specialized services use allowlisted context envelopes:

| Role | May receive | Normally withheld |
| --- | --- | --- |
| Topic extractor | Problem and background | Proof search and future history |
| Initial librarian | Approved topic and vocabulary manifest, background | Exact goal wording where not needed |
| Proof-state formalizer | Problem and approved library | Authority to change the library silently |
| Move shortlister | Selections, polarity, local types, candidate cards | Original problem, remote branches, unrelated library |
| Move executor | Chosen move, selections, required local context | Unrelated history and alternative suggestions |
| Attestor | Exact local before-and-after inference, background slice | Overall proof history |
| Background gatekeeper | Candidate result and background profile | Why the current proof wants the result |
| Generality reviewer | Move template and independent examples | Original discovery problem where avoidable |

Suggestion services and executors may add library results, but they do so through explicit library-addition commands and the background gate rather than by silently enlarging their own context or mutating storage.

### 15.3 Minimal context construction

For a local suggestion or execution request:

- Begin with selected MathJSON fragments.
- Include the parent statement only when polarity or binding requires it.
- Include only declarations of free variables used by the fragments.
- Include hypotheses requested by the move's applicability contract.
- Replace unrelated expressions with typed placeholders.
- Rename problem-specific symbols when their names are irrelevant.
- Avoid including the original problem or full tree by default.
- Allow the service to return an explicit insufficient-context request for a permitted category.

### 15.4 Honest provenance

The artifact distinguishes:

- Deterministic suggestion.
- Minimal-context LLM suggestion.
- Stateful-agent proposal.
- User proposal.
- Proof-time library addition.
- Derived result.
- Background-attested inference.
- User-selected sorry.

For every LLM call, store the role, exact structured context supplied, output, any bounded context extension, acceptance decision, and resulting operation. A viewer may expose a "What the model saw" panel.

This does not claim access to or reproducibility of hidden model reasoning. It makes the platform-controlled information boundary inspectable.

## 16. Proof-discovery tree

### 16.1 Structure

The retained discovery history is a rooted tree, and that tree is the ground truth for the proof-discovery process. Equal proof states reached by different routes remain distinct nodes because their discovery histories differ.

Each edge records:

- Pre-move proof-state snapshot.
- Active selections and selection lenses.
- Query abstractions.
- Complete displayed suggestion list in order.
- Applicability and ranking explanations.
- Previews requested or generated.
- Chosen result or move.
- Parameters.
- LLM context and structured output where applicable.
- Kernel operations.
- Library additions.
- Attestations, approvals, obligations, or sorries.
- Post-move proof-state snapshot.
- Transition class.

### 16.2 Deleting an accidental move

A visible "Delete previous move" action removes the latest move at the current leaf when it was a genuine accident. It removes the associated child and interaction from the exported discovery record and returns to the parent state.

If descendants would be removed, confirmation is required. A short local undo may be offered, but deleted accidental work does not appear in the final documentary replay.

This is distinct from backtracking, which preserves the prior branch.

### 16.3 Backtracking with information

Backtracking may be invoked at any time; it is not restricted to false, falsifiable, or stuck goals.

Given a proposition `P` discovered in a descendant:

1. Determine the free variables, operators, and definitions used by `P`.
2. Find the closest ancestor where they are all available.
3. Allow the user or agent to select a different sensible ancestor.
4. Insert a classical case split on `P` versus `not P`.
5. Attempt to replay or reattach existing work under the relevant case.
6. Close a case when the current goal follows there, including the common case where assuming `P` immediately closes a goal `P`.
7. Focus the remaining open case.

The original branch remains in the discovery tree. Classical excluded middle is always available.

### 16.4 Replay

Replay operates on semantic move plans rather than raw clicks or obsolete operand paths. Each step is matched again against the target branch. The preview reports:

- Steps that adapted successfully.
- Changed substitutions.
- New obligations.
- The first step that failed.
- Possible repairs or alternate selections.

Replaying a sequence creates new nodes in the target branch rather than graph sharing.

### 16.5 Solved state and pruned proof

A proof is solved when the root goal is closed along a retained route containing only equivalence and strengthening transitions, relative to the approved background and any explicit sorry assumptions.

Case splits may create multiple goals in one proof state. All required cases must be closed. Weakening edges do not count toward the provability route.

The pruned proof is the minimal retained strengthening/equivalence structure needed to establish the root, together with necessary cases, background inferences, derived results, and universally closed sorry assumptions. It omits abandoned and weakening-only branches while the full discovery tree preserves them.

## 17. Human interface

### 17.1 Workspace layout

The main workspace should contain:

- Problem title, background summary, solved status, and current branch breadcrumb.
- Variables and declarations section.
- Hypotheses section.
- Goals section.
- Obligations or sorry status.
- Ranked result and move panel.
- Expandable library drawer.
- Access to the proof-discovery tree.

Suggested visual families are:

- Variables: red.
- Hypotheses: orange.
- Goals: blue.
- Obligations and additional assumptions: purple or a distinct neutral treatment.

Positive and negative logical positions may use subtle inward and outward bevel treatments corresponding to goal-like and hypothesis-like roles. Color must not be the only signal; outlines, icons, and labels should support accessibility.

### 17.2 Toolbar

The main toolbar includes:

- Clear selections.
- Abstract selected expressions.
- Copy proof state as JSON.
- View raw MathJSON.
- Toggle formal LaTeX and natural language.
- Delete previous move.
- Backtrack.
- Replay a sequence here.
- Open full discovery tree.
- Export proof.

### 17.3 Suggestion panel

Each suggestion card shows:

- Result or move name.
- Short explanation of applicability.
- Matched selections.
- Expected state change.
- New obligations or library additions.
- Equivalence, strengthening, or weakening classification.
- Deterministic, LLM-assisted, or stateful-agent provenance.
- Preview and apply actions.

Related theorem variants may be grouped behind an expandable control.

### 17.4 Minimal typing

The UI should prefer:

- Selecting existing objects rather than naming them.
- Parameter menus populated from the current context.
- Clickable metavariable instantiations.
- Drag-and-drop application.
- Suggested binder names.
- Structured library and move forms.

Text entry remains available for entering the original problem, correcting natural language, defining genuinely new notation, discussing a move, or overriding a generated proposal.

## 18. Agent interface

The agent API is text-based, compact, and uses the same command handlers as the React UI.

It should support:

- Observe full state, compact summary, or delta since an event.
- List declarations, hypotheses, goals, obligations, and active library layers.
- Select statement operand paths or display ranges.
- Create virtual selections and abstractions.
- Request suggestions.
- Preview and apply a result or move.
- Add a library result.
- Propose or create a move.
- Create a case split.
- Backtrack.
- Replay a move sequence.
- Mark an obligation as a sorry.
- Delete the latest accidental move.
- Inspect the discovery tree.
- Export the complete artifact.

Use compact stable aliases for the current snapshot, statements, selections, moves, and suggestions. Responses should default to state deltas and identifiers rather than repeat large natural-language statements. Complete MathJSON remains available on request.

The agent protocol should be a stable JSON command protocol over HTTP, with optional streaming for long-running LLM work. The web interface calls the same API.

## 19. Persistence and final proof artifact

### 19.1 Static documentary replay

Reproducibility means displaying what happened, not recomputing historical behavior. Store complete snapshots and outputs. Static replay does not rerun retrieval, ranking, translation, models, or moves.

There is no requirement to pin historical model, prompt, package, or schema versions solely to reproduce computation.

### 19.2 Export contents

The self-contained proof artifact contains:

#### Problem setup

- Original problem statement.
- Assumed background.
- Setup edits.
- Topic and vocabulary manifest stages.

#### Library construction

- Every initial library proposal stage.
- Definitions, results, techniques, moves, and variants proposed.
- User or agent edits, removals, and approvals.
- Translation and notation entries.
- Final initial library.

#### Initial proof state

- Proposed variables, hypotheses, and goals.
- Formal and natural-language views.
- Corrections and approval.

#### Discovery history

- Full retained proof tree.
- Complete proof-state snapshots.
- Every selection and abstraction.
- Every displayed suggestion list.
- Ranking and applicability explanations.
- Previews.
- Chosen moves and parameters.
- Kernel-operation plans.
- LLM context envelopes and structured outputs.
- Library additions and derived results.
- Branching, backtracking, and replay events.
- Informal inferences and user-selected sorries.

#### Final material

- Solved status.
- Pruned proof.
- Universally closed additional assumptions from sorries.
- Final library and translation dictionary.
- Discovered moves and their discovery contexts.
- Deterministic LaTeX and natural-language presentation.

### 19.3 Database model

A PostgreSQL database should store a mixture of relational metadata and MathJSON/JSONB payloads. Principal entities are:

- Problem.
- Background profile.
- Topic and vocabulary manifest stage.
- Custom operator.
- Translation entry.
- Library artifact and variant family.
- Library construction stage.
- Move definition.
- Proof session.
- Proof-state node.
- Transition edge.
- Selection and selection lens.
- Suggestion set and suggestion item.
- Preview.
- Library-addition event.
- Obligation and sorry assumption.
- LLM call and context envelope.
- Replay operation.
- Exported proof artifact.

The proof tree is stored directly rather than deduplicated into a DAG. Large static snapshots may be compressed, but replay must not depend on recomputation.

Because proofs may contain unpublished research, operational data should remain private by default. Any use as a research dataset should be separately opt-in and support export and deletion.

## 20. Technical architecture

### 20.1 Stack

Recommended implementation stack:

- TypeScript throughout.
- React with Next.js for the web application.
- MathLive for mathematical interaction and rendering.
- `@cortex-js/compute-engine` for MathJSON boxing, matching, manipulation, typing, and LaTeX serialization.
- PostgreSQL with JSONB for persistent proof and library data.
- A background worker for LLM calls, indexing, initial construction, and preview generation.
- Server-sent events or equivalent streaming for long-running construction and suggestion tasks.
- Runtime schemas, such as Zod schemas, for every command, LLM output, and stored artifact.

### 20.2 Monorepo organization

Suggested packages and applications:

- `apps/web`: React interface, proof viewer, and landing flow.
- `apps/worker`: asynchronous LLM and indexing work.
- `packages/mathjson-model`: term, statement, declaration, proof-state, and custom-operator types.
- `packages/kernel`: primitive state operations and transition classification.
- `packages/selections`: operand paths, virtual selection lenses, abstraction, and reinsertion.
- `packages/library`: definitions, results, techniques, variants, and background admission.
- `packages/moves`: move schemas, plan generation, preview, authoring, and replay.
- `packages/retrieval`: discrimination tree, filtering, matching, and deterministic ranking.
- `packages/language`: LaTeX adapters and deterministic natural-language rendering.
- `packages/protocol`: shared commands, responses, events, and export schemas.
- `packages/llm`: role-specific context builders, structured calls, attestation, and stateful-agent memory.

### 20.3 Command architecture

All mutations pass through one command service. A command:

1. Resolves the active proof state and selections.
2. Validates authorization and prerequisites.
3. Builds any required deterministic or LLM plan.
4. Validates the resulting primitive operations.
5. Produces a preview where required.
6. Applies the operation atomically.
7. Stores the new proof node, edge, and interaction record.
8. Returns a compact state delta.

No React component, model worker, or agent client writes proof-state rows directly.

### 20.4 Compute Engine boundary

Use a thin adapter around the Compute Engine:

- Stored values remain plain MathJSON.
- Boxing is explicit and temporary.
- Canonicalization is opt-in.
- Custom operator and LaTeX dictionaries are registered centrally.
- Transformations return plain MathJSON plus diagnostics.
- The adapter owns compatibility with Compute Engine API changes.

This boundary preserves approved expression structure without requiring historical version pinning.

## 21. Testing and quality criteria

### 21.1 Mathematical core

Use property-based and golden tests for:

- Scope and binder correctness.
- Capture-avoiding substitution.
- Statement construction and polarity.
- Exact operand-path replacement.
- Virtual selection extraction and reinsertion.
- Custom operator serialization.
- Move preconditions and transition classification.
- Equivalence, strengthening, and weakening path behavior.
- Universal closure of sorry assumptions.
- Semantic replay adaptation.

### 21.2 Retrieval

Test:

- Discrimination-tree completeness for supported patterns.
- Variant retrieval.
- Typed and higher-order matching.
- Deep occurrence matching.
- Multiple selections and abstraction.
- Deterministic stable ranking.
- No suggestion of moves with unavailable dependencies.

### 21.3 LLM boundaries

Test role context builders for both presence and absence:

- Required selected expressions are included.
- Unrelated hypotheses are excluded.
- Original problem and remote branches are absent where prohibited.
- Stateful-agent proposals are labeled correctly.
- Malformed or adversarial LLM output cannot mutate proof state.
- Library additions always appear as explicit events and pass the required admission policy.

### 21.4 Interface

Test:

- Mouse-only completion of representative flows.
- Selection expansion and snapping feedback.
- Virtual selections under associative operators.
- Drag-and-drop previews.
- Color-independent accessibility.
- Deleting an accidental move.
- Full and pruned proof exploration.
- Static replay without recomputation.

### 21.5 Benchmark corpus

Maintain a representative corpus across:

- Elementary logic.
- Algebra.
- Number theory.
- Combinatorics.
- Linear algebra.
- Real analysis.
- Geometry.
- At least a few research-style notation and representation cases.

The corpus should measure representational adequacy, suggestion quality, move reuse, amount of typing, deterministic coverage, and the points where new moves become necessary.

### 21.6 Performance targets

Suggested targets for the interactive path are:

- Deterministic selection feedback should feel immediate.
- Indexed suggestions should normally appear within roughly 150 milliseconds.
- Deterministic previews should normally appear within a few hundred milliseconds.
- LLM fallback should stream progress and never block basic proof-state interaction.
- Static tree navigation and replay should use stored snapshots and feel immediate.

## 22. Implementation sequence

This is a vibe-coding project, so the sequence is organized around thin working slices rather than staffing or calendar estimates.

### Stage 1: MathJSON interaction spike

- Store a MathJSON statement as ground truth.
- Render it with MathLive.
- Select exact nested subexpressions.
- Recover operand paths.
- Support a contiguous associative virtual selection.
- Replace the selection and render the result.
- Fall back visibly to the nearest subtree when needed.

Exit condition: selection, transformation, and rendering are reliable enough to support the central point-and-click interaction.

### Stage 2: Proof-state and kernel slice

- Implement the statement view over MathJSON.
- Add variables, hypotheses, goals, and polarity.
- Implement primitive logical and term operations.
- Add equivalence, strengthening, and weakening.
- Store proof nodes and edges.
- Add a small hand-authored library and move set.

Exit condition: several elementary proofs can be completed deterministically without an LLM.

### Stage 3: Retrieval and workspace

- Build the proof-state UI and selection gestures.
- Implement the discrimination tree.
- Add abstraction, multiple selections, deep inference, and previews.
- Add theorem variants and grouped display.
- Add the library drawer and toolbars.

Exit condition: representative proof exploration is primarily mouse-driven and suggestions are fast and inspectable.

### Stage 4: Initial construction and LLM roles

- Add topic-manifest generation and review.
- Add staged initial library construction and approval.
- Add proof-state formalization and approval.
- Add role-specific context builders.
- Add lightweight fallback shortlisting.
- Add kernel-plan generation and fast attestation.

Exit condition: a natural-language problem can reach an approved interactive proof state without allowing an LLM to mutate mathematical data directly.

### Stage 5: Evolving library and stateful agents

- Add explicit proof-time library additions.
- Add background admission checks.
- Add derived-result dependencies.
- Add persistent agent strategy state.
- Complete the compact agent protocol.
- Record and display suggestion provenance and model context envelopes.

Exit condition: an LLM agent can operate the same platform statefully, enlarge the library transparently, and remain fully visible in the discovery record.

### Stage 6: Branching, backtracking, and replay

- Implement arbitrary backtracking.
- Insert classical case splits at appropriate ancestors.
- Add semantic move-sequence replay.
- Add weakening branches and provability-path calculation.
- Add delete-previous-move behavior.

Exit condition: information discovered in one branch can be incorporated into another without losing the original search history.

### Stage 7: Move discovery and authoring

- Add the move template editor.
- Add stronger-model move proposal.
- Add examples, counterexamples, and generality review.
- Persist approved moves with discovery contexts.
- Expand deterministic domain packs from observed limitations.

Exit condition: a missing operation can be turned into a reusable, inspectable move and applied to a structurally different problem.

### Stage 8: Proof artifact and hardening

- Complete static replay.
- Add full and pruned proof viewers.
- Add JSON import, export, upload, and database retrieval.
- Add universally closed sorry summaries.
- Complete accessibility, privacy controls, performance work, and corpus testing.

Exit condition: an exported artifact provides a faithful, self-contained account of the problem, available knowledge, proof search, library evolution, and final argument.

## 23. Definition of a successful first release

The first serious release succeeds when it can demonstrate all of the following:

- A user enters a problem and assumed background.
- A staged, reviewable initial library and proof state are generated.
- MathJSON remains the authoritative source throughout.
- Most proof interaction occurs through selection, menus, and drag-and-drop.
- Exact and limited virtual selections work reliably.
- Suggestions are fast, deterministic where possible, short, ranked, and explained.
- Library results and general moves are visibly distinct.
- Related theorem variants improve matching without overwhelming the interface.
- Humans and stateful agents use the same commands.
- Proof-time services may transparently add background-appropriate results.
- Equivalence, strengthening, and weakening are all represented correctly.
- Backtracking, classical case splitting, and semantic replay work.
- Sorries permit completion but appear as explicit universally closed assumptions.
- A newly needed general move can be proposed, discussed, approved, stored, and reused.
- The complete discovery process and the pruned proof can be explored statically.
- The proof can be exported, stored, fetched, and reopened.

## 24. Technical references

- MathJSON format: <https://mathlive.io/math-json/>
- MathLive interaction and MathJSON extraction: <https://mathlive.io/mathfield/guides/interacting/>
- Mathfield selection API: <https://mathlive.io/mathfield/api/>
- Compute Engine expressions and serialization: <https://mathlive.io/compute-engine/guides/expressions/>
- Compute Engine patterns and rules: <https://mathlive.io/compute-engine/guides/patterns-and-rules/>
- Compute Engine functions and higher-order function literals: <https://mathlive.io/compute-engine/reference/functions/>
- Custom functions and symbols: <https://mathlive.io/compute-engine/guides/augmenting/>
- Custom LaTeX dictionaries: <https://mathlive.io/compute-engine/guides/latex-syntax/>
