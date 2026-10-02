# Polymorphic sorts (N47) — design

Status: proposal for review. Nothing here is implemented yet. Roadmap entry:
[`non-ai-roadmap.md` N47](./non-ai-roadmap.md).

This document says how library results and custom operators can be stated once for every suitable
sort ("transitivity of < for any ordered number system", "union of two sets of anything"), and
why each choice is the simplest that works for the planned packs. It is written for readers who
know the project but not type theory. Terms are defined when first used.

## 0. Summary

- **Proof states stay monomorphic.** Sort variables appear only in operator signatures and in
  library and kernel results. Every declaration in a proof state, construction task, or retrieval
  wildcard keeps a concrete ("ground") sort.
- **Plain MathJSON expressions do not change.** Sorts are never written inside expressions; typed
  binders use set terms such as `RealNumbers`. Polymorphism lives only in the JSON _metadata_
  (signatures, result parameters), so no stored expression needs migrating.
- **Polymorphism is rank-1 (prenex).** A result or operator lists its sort parameters up front,
  for example `K` or `T`. Each use substitutes concrete sorts for all of them at once. Nothing
  quantifies over sorts inside a sort or an expression.
- **Constraints are a fixed set of five number-system classes:** `numeric`, `ring`, `field`,
  `ordered`, `integral`. Each class is a closed list of built-in number sorts, for example
  `field` = ℚ, ℝ, ℂ. There are no user-declared typeclasses.
- **There is no numeric subtyping.** An explicit `Coerce` term replaces it; see §2.4.
- **The kernel checks one recorded sort instantiation.** `apply-result-*` operations carry an
  optional `sortInstantiation`, such as `{K: real}`. The kernel checks that it satisfies the
  classes and that every instantiation term has the instantiated parameter sort. If the field is
  absent, the kernel infers it deterministically, so stored monomorphic histories replay
  unchanged.
- **Checking never needs general unification.** Concrete sorts in contexts and opaque variables
  in results mean every sort question is a one-way match of a pattern against a known sort.

## 1. The current sort model and where monomorphism bites

### 1.1 What exists

`packages/mathjson-model/src/contracts.ts` defines:

- `Sort = PropositionSort | NamedSort | FunctionSort`.
  - `NamedSort` is `{kind: "named", id, arguments?}`. It is already a parametric constructor:
    `sort:set`, `sort:list` and `sort:sequence` take one argument, and `sort:tuple` takes n.
  - `FunctionSort` is `{kind: "function", signature: {parameters, result}}`.
  - `sortEquals` is structural equality.
- `Declaration` gives each local symbol one `Sort`. The roles are `universal-parameter`,
  `local-witness`, and `construction-metavariable`.
- `OperatorDeclaration` gives a custom operator one fixed `Signature`.
- `RetrievalWildcard` has an optional `sort`.
- The checker is `validatesAsSort` / `inferExpressionSort` / `inferTermConstructorSort`. It is
  bottom-up inference with checking against an expected sort for literals (`Set`, `Tuple`,
  `Function`). It treats built-ins ad hoc:
  - `RELATION_ARITIES` (`Less`, …) accept any numeric sort, provided all operands share it
    (`inferCompatibleOperandSort`).
  - `HOMOGENEOUS_TERM_ARITIES` (`Add`, `Divide`, `Abs`, …) return their operand sort.
  - `Element` checks `x : T` against `set<T>`, and `Subset` requires `set<_>`.
  - Numeric literals have a pseudo-sort `NumericLiteralSort` that fits any admissible number sort
    (`numericLiteralMatches`).
  - Standard sets map to member sorts (`STANDARD_SET_MEMBER_SORTS`, for example
    `RealNumbers → set<real>`).
- `builtinBinderSorts` and `binders.ts` (`binderShape`, `readBinderDeclaration`) give bound
  symbols their sorts (N01).

So the built-in operators are already polymorphic, but in a way that is hard-coded and cannot be
extended. Custom operators, result parameters and declarations are strictly monomorphic.

### 1.2 Where it bites

Each of the following was observed in the code or confirmed by a throwaway probe against
`parseStatementView`.

1. **The packs are duplicated per sort or simply missing.** `packages/library/src/packs.ts`
   states equality, order and arithmetic over `REAL_SORT`, sets over `ELEMENT_SET_SORT`, and
   divisibility over `INTEGER_SORT`. Its header says "a session over another number sort does not
   match these results." In a session with `n m : integer`:
   - the goal `n < m` validates, but `result:less-transitivity` cannot be instantiated, because
     `instantiateResultInContext` (kernel `results.ts`) rejects `n` for a `real` parameter;
   - retrieval's `bindingsTypeFit` (retrieval `filtering.ts`) returns `mismatch` for the same
     reason.
2. **The pack operators fix the element sort.** `Union`, `Intersection` and `Closure` have
   signatures over `set<element>`. `libraryPacksForOperators` offers a pack only when the session
   declares its operators _identically_, so a session over `set<integer>` cannot use the sets
   pack at all.
3. **There is no numeric subtyping.**
   - `n < r` with `n : integer` and `r : real` is rejected.
   - So is `r ∈ Integers` with `r : real`; there is no way to say "r is an integer".
   - N01 recorded this ("no numeric subtyping"), and nothing replaces it.
4. **Built-in rules are too lenient on concrete sorts.** The probe shows:
   - `n / m` with integers has sort `integer`, so `n/m = n` validates;
   - `Subtract` on naturals stays `natural`;
   - `Less` and `Abs` accept `complex`, because `NUMERIC_SORT_IDS` includes it.

   This is harmless today, but it matters as soon as a result is meant for "any field".

5. **Problem setup has a fixed menu.** `PROBLEM_SETUP_SORT_CHOICES` (protocol
   `problem-setup.ts`) lists 11 sorts chosen to match the packs. There is no set of integers, no
   sequence, no tuple, and no user-named sort. N26 recorded "no user-defined sorts".
6. **Some domains have no packs.** N37 recorded that combinatorics, linear algebra, real analysis
   and geometry have none, because of monomorphic sorts and missing operators. A linear-algebra
   pack would have to be written three times (ℚ, ℝ, ℂ). A finite-sets pack would have to be
   written once per element sort.
7. **Sort probing is duplicated.**
   - The kernel (`termHasSortInContext`), retrieval (`termHasSort` in `filtering.ts`) and moves
     (`sortFilter` in `context-terms.ts`) each decide a term's sort by declaring a fresh
     predicate `SortProbe : (expected) → proposition` and validating `SortProbe(term)`.
   - None of them can answer "what is this term's sort?", only "is it this sort?".
   - Selections cannot report term sorts at all. N33 recorded: "term wildcards are unsorted until
     selections expose term sorts."

## 2. Goals and non-goals

### 2.1 Goals

- State a result or operator once over sort variables, and use it at any admissible sort.
- Keep the kernel the only place that accepts a transition. In particular, a result proved "for
  every ordered field" must never be applied at ℤ.
- Keep every existing stored state, operation, library artifact and v1 export valid, and
  importable with an identical replay.
- Unlock the new packs (§9) and a sort-builder menu in problem setup (§7).
- Expose term sorts to selections, retrieval and moves through one exported inference function.

### 2.2 Non-goals

- **Higher-rank polymorphism.** No quantifying over sorts inside a sort or expression, and no
  polymorphic hypotheses.
- **Sort variables in proof states.** A problem about "an arbitrary type" declares an opaque named
  sort instead (§7.2). Such sorts behave exactly like a sort variable fixed for the session.
- **Dependent sorts.** No `vector<K, n>` with a term index. Dimensions are premises or side
  conditions.
- **User-declared typeclasses or instances.** Abstract structures (groups, metric spaces) use
  explicit operation parameters and premises (§2.3).
- **Implicit numeric subtyping or automatic coercion search** in the kernel.
- **Generalizing derived results** (N12/N44 conditional lemmas) over sorts. They stay
  monomorphic.
- **A "universe" set term** that would allow typed binders over a sort variable (§5.5).

### 2.3 Constraints: a fixed set of number-system classes (recommended)

A sort parameter may carry constraints. Each constraint is a **class**: a named, closed list of
built-in sorts. A list of constraints means their intersection.

| Class      | Members (the class extension) | Built-ins it justifies on its own |
| ---------- | ----------------------------- | --------------------------------- |
| `numeric`  | ℕ, ℤ, ℚ, ℝ, ℂ                 | `Add`, `Multiply`, `Power`, `Sum` |
| `ring`     | ℤ, ℚ, ℝ, ℂ                    | + `Subtract`, `Negate`, `-1`      |
| `field`    | ℚ, ℝ, ℂ                       | + `Divide`, decimal literals      |
| `ordered`  | ℕ, ℤ, ℚ, ℝ                    | `Less`…, `Max`, `Min`             |
| `integral` | ℕ, ℤ                          | (truth only, e.g. divisibility)   |

`["ordered", "field"]` is ℚ, ℝ. An unconstrained parameter (`T`) ranges over every ground sort,
including `element`, sets, functions and user sorts.

**Why a closed list, not typeclasses.** Constraints do two jobs:

1. **Truth.** A density result `x < y ⊢ x < (x+y)/2` is true at ℚ and ℝ but false at ℤ. The
   kernel must refuse `{K: integer}`.
2. **Well-sortedness.** Inside a result, `Add(x, y)` with `x : K` must be accepted only when every
   admissible `K` accepts it.

The only operators whose typing depends on algebraic structure are the built-ins, and their
admissible sorts are exactly the five number sorts. A finite table therefore answers both
questions with no declarations, instances or resolution algorithm.

**The rule for built-ins is derived, not designed.** A built-in rule accepts a variable `K` iff it
accepts _every_ member of `K`'s extension. For example:

- `Less(x, y)` with `x y : K` needs `ext(K) ⊆ ordered`;
- the literal `-1 : K` needs `ext(K) ⊆ ring`;
- `0.5 : K` needs `ext(K) ⊆ field`.

This makes soundness a checkable property (§10, property P1).

**What about abstract structures?** Group theory and similar are handled the way the closure pack
handles topology: an opaque carrier sort plus explicit operations and premises. For example:

- `op : (T, T) → T` is a function parameter;
- a pack predicate `IsGroup(op, e)` is a premise of each result.

This needs no class machinery.

**Alternatives considered**

- **Typeclass-like declarations** (`class Group T where …`, plus instances). These are more
  expressive, but they need instance resolution, coherence rules, review UI for instances, and a
  way to keep instance selection static in history. Defer until a pack needs it.
- **Structure predicates as premises only** (no constraints; `IsOrderedField(K)` as an ordinary
  premise). This is unsound for built-ins: `Less` on an opaque `K` would have to be accepted
  blindly.
- **No constraints** (only unconstrained `T`). This is too weak: order and arithmetic, the main
  migration targets, need them.

### 2.4 Numeric subtyping: replaced by explicit coercion (recommended)

Implicit ℕ ⊂ ℤ ⊂ ℚ ⊂ ℝ ⊂ ℂ would turn every sort question into an inequality constraint.
Operators would need joins ("ℕ + ℝ is ℝ"), result matching would have to choose where to insert
upcasts, and the stored MathJSON would no longer say what is being compared. That conflicts with
"plain MathJSON is authoritative".

Instead, add one reserved built-in term:

```json
["Coerce", "n", "RealNumbers"]
```

- **Typing.** If `n : S` and the second operand is a standard number set with member sort `R`,
  then the term has sort `R`, provided `S` is strictly below `R` in the fixed chain ℕ < ℤ < ℚ < ℝ
  < ℂ. The target is a set term, which already exists, so the result sort is determined by the
  operands and needs no expected sort.
- **Rendering.** LaTeX renders `n` with no decoration. The natural-language form is "n" by
  default, or "n (as a real number)" in the explanatory register. This keeps the display plain
  for newcomers.
- **Parsing.** When parsing LaTeX finds a relation or arithmetic node whose operands have
  distinct number sorts, it wraps the lower operands in `Coerce` to the highest sort, then
  re-validates. This happens in `parseLatex` and worker draft validation. It is deterministic,
  happens once at input time, and the stored MathJSON then contains the coercion explicitly.
- **Library facts.** The arithmetic pack gets results that coercion preserves `<`, `+`, `·` and
  `=`.
- **Saying "r is an integer".** Use `["Exists", ["Element", "k", "Integers"], ["Equal", "r",
["Coerce", "k", "RealNumbers"]]]`. Pack predicates such as `IsInteger` can wrap this later.

## 3. Representation

### 3.1 Sorts

Keep `Sort` exactly as it is: ground sorts only. Add a superset type for places that may mention
sort variables:

```ts
type SortVariable = Readonly<{ kind: "variable"; name: string }>; // name: /^[A-Z][A-Za-z0-9]*$/
type PolySort =
  | PropositionSort
  | Readonly<{ kind: "named"; id: SortId; arguments?: readonly PolySort[] }>
  | Readonly<{ kind: "function"; signature: PolySignature }>
  | SortVariable;
type PolySignature = Readonly<{ parameters: readonly PolySort[]; result: PolySort }>;

type SortConstraint = "numeric" | "ring" | "field" | "ordered" | "integral";
type SortParameter = Readonly<{ name: string; constraints?: readonly SortConstraint[] }>;
type SortInstantiation = Readonly<Record<string, Sort>>; // ground sorts only
```

Every ground `Sort` is structurally a `PolySort`, so existing JSON parses under `polySortSchema`
unchanged.

Code that handles proof states keeps the ground `Sort` type: the kernel's state code, selections
bindings, problem setup, constructions and wildcards. TypeScript then forbids a variable from
reaching a state.

### 3.2 Where `PolySort` is allowed

| Stored object                                                        | New optional field                      | Sort field type               |
| -------------------------------------------------------------------- | --------------------------------------- | ----------------------------- |
| `OperatorDeclaration` (mathjson-model)                               | `sortParameters?: SortParameter[]`      | `signature: PolySignature`    |
| `LibraryResult`, `LibraryDefinition` (library `index.ts`)            | `sortParameters?: SortParameter[]`      | `parameters[].sort: PolySort` |
| `KernelResult` (kernel `results.ts`)                                 | `sortParameters?: SortParameter[]`      | `parameters[].sort: PolySort` |
| `apply-result-backward` / `-forward` operation (kernel)              | `sortInstantiation?: SortInstantiation` | ground                        |
| Displayed result suggestion and menu selection (retrieval, protocol) | `sortInstantiation?`                    | ground                        |
| `Declaration`, `RetrievalWildcard`, construction task sort           | none                                    | ground `Sort` (validated)     |

If `sortParameters` is absent, the object is monomorphic, and its sorts must then be ground. That
is exactly today's data, so no rows are rewritten. Library artifacts, operators and edges are
stored as JSONB rows (migrations `0005_library.sql`, `0001_proof_commands.sql`), so there is **no
SQL migration**. Only the schemas widen.

Validation rules, enforced by the schemas plus `admitLibraryArtifact`:

- Sort parameter names are unique within their declaration.
- Every variable used is declared, and every declared parameter is used.
- Constraint lists are non-empty subsets of the five classes and are kept sorted, so the JSON is
  canonical.
- **Determinacy.**
  - For an operator: every sort parameter occurs in at least one _parameter_ sort. So
    `EmptySet : () → set<T>` is rejected; the existing `["Set"]` literal already checks against an
    expected sort.
  - For a result: every sort parameter occurs in the sort of at least one result parameter that
    is free in the conclusion or a premise.
  - Together these mean the sort instantiation is always fixed by the term instantiation (§4.3).
- **No untyped binder over a variable sort** inside a polymorphic result (§5.5).

### 3.3 Examples

The sets pack's union, after migration:

```json
{
  "id": "operator:set-union",
  "symbol": "Union",
  "sortParameters": [{ "name": "T" }],
  "signature": {
    "parameters": [
      { "kind": "named", "id": "sort:set", "arguments": [{ "kind": "variable", "name": "T" }] },
      { "kind": "named", "id": "sort:set", "arguments": [{ "kind": "variable", "name": "T" }] }
    ],
    "result": {
      "kind": "named",
      "id": "sort:set",
      "arguments": [{ "kind": "variable", "name": "T" }]
    }
  }
}
```

Transitivity of `<`, after migration (unchanged fields elided):

```json
{
  "id": "result:less-transitivity",
  "sortParameters": [{ "name": "K", "constraints": ["ordered"] }],
  "parameters": [
    { "symbol": "x", "sort": { "kind": "variable", "name": "K" }, "...": "…" },
    { "symbol": "y", "sort": { "kind": "variable", "name": "K" }, "...": "…" },
    { "symbol": "z", "sort": { "kind": "variable", "name": "K" }, "...": "…" }
  ],
  "premises": [{ "expression": ["Less", "x", "y"] }, { "expression": ["Less", "y", "z"] }],
  "statement": { "expression": ["Less", "x", "z"] }
}
```

An operation applying it in an integer session (fields as today, plus one):

```json
{
  "kind": "apply-result-forward",
  "resultId": "result:less-transitivity",
  "instantiation": { "x": "a", "y": "b", "z": "c" },
  "sortInstantiation": { "K": { "kind": "named", "id": "sort:integer" } },
  "...": "…"
}
```

### 3.4 Sort constructors

Parametric constructors remain ordinary `NamedSort` ids with arguments, so no new kind of sort is
needed. A table in mathjson-model (`SORT_CONSTRUCTORS`) records each known id's arity. The menus
(§7), the renderers, and the admission of _new_ operators and results all use it:

| Constructor     | Arity | Notes                                                                       |
| --------------- | ----- | --------------------------------------------------------------------------- |
| `sort:set`      | 1     | existing                                                                    |
| `sort:list`     | 1     | existing                                                                    |
| `sort:sequence` | 1     | existing (`At` with a natural index)                                        |
| `sort:tuple`    | n ≥ 1 | existing                                                                    |
| `sort:vector`   | 1     | new, coordinates over a scalar sort; meaning comes only from pack operators |
| `sort:matrix`   | 1     | new, same                                                                   |

The base schema stays permissive about arity, so old data is never rejected on this basis.

## 4. Checking and inference

### 4.1 One elaboration pass

Replace the inner functions of `contracts.ts` with a single exported, pure, deterministic pass:

```ts
elaborate(expression, environment, expected?: Sort | PolySort):
  | { ok: true; sort: InferredSort; nodeSorts: ReadonlyMap<PathKey, Sort>;
      operatorInstantiations: ReadonlyMap<PathKey, SortInstantiation> }
  | { ok: false; diagnostic: SortDiagnostic }
```

- `validatesAsSort` and `isPropositionExpression` become thin wrappers, so every existing caller
  sees identical answers on monomorphic input (§10, property P5).
- `inferTermSort(term, declarations, operators)` is exported. It replaces the three sort probes
  (kernel `termHasSortInContext`, retrieval `termHasSort`, moves `sortFilter`). They then share
  one code path, and no longer construct a Zod schema per check.
- `nodeSorts` uses the selection path convention (operand indices). Selections can then expose
  term sorts, which closes the N33 gap "term wildcards are unsorted".
- Each node is inferred once (memoized per pass). Today `inferCompatibleOperandSort` infers its
  operands and then re-validates each one with `validatesAsSort`, which is repeated work on deep
  terms.

### 4.2 Rigid and flexible variables

There are two kinds of sort variable in the checker:

- **Rigid variables** are the declared `sortParameters` of the result (or definition) being
  validated. Inside it, `K` is an unknown but fixed sort. It equals only itself, and built-in
  rules treat it through its class extension (§2.3). This is how a result's statement is checked
  once "for all K".
- **Flexible variables** are the `sortParameters` of a polymorphic _operator_. They get fresh
  copies at each application (renamed apart, for example `T@1.2` for the node at path `[1, 2]`).

**Application of a polymorphic operator `f : (P1, …, Pn) → R`.** Each operator application gets a
fresh substitution σ, which starts empty.

1. If an expected sort is known, match `R` against it to seed σ. This is how
   `["Union", ["Set"], A]` gets `T` from `A` or from context.
2. For each operand whose sort can be inferred bottom-up, match `Pi` against the inferred sort
   and extend σ. A conflict fails with "T is integer from operand 1 but real from operand 2".
3. Check the remaining operands with `validatesAsSort(operand, σ(Pi))`. These are literals,
   untyped lambdas and empty collections. If `σ(Pi)` still contains a flexible variable, fail
   with `sort-undetermined`: "cannot tell which sort T is in Dist(1, 2)". Built-ins keep their
   current literal leniency; only new polymorphic operators are strict, so there is no
   compatibility burden.
4. Check constraints. Each `σ(T)` must satisfy `T`'s classes.
   - A ground sort satisfies them by membership.
   - A rigid `K` satisfies them iff `ext(K) ⊆ ext(T)`, that is, `K`'s constraints imply `T`'s.
5. The result sort is `σ(R)`, and `operatorInstantiations[path] = σ`.

**Matching** `match(pattern, sort, σ)` is one-way first-order matching:

- a flexible variable binds, or is compared with its existing binding;
- `named` nodes compare id and arity, then recurse into the arguments;
- `function` nodes compare arity, then recurse into the parameters and the result;
- rigid variables and ground sorts compare by `sortEquals` (extended to compare variables by
  name).

No general unification is needed:

- contexts are ground, so every bottom-up inferred sort is ground or mentions only rigid
  variables;
- flexible variables occur only in the pattern side;
- so the occurs check can never fire, and no variable ever has to be bound to a sort containing a
  flexible variable.

This is the main simplification bought by keeping proof states monomorphic.

**Built-in rules for a rigid variable.**

- `HOMOGENEOUS_TERM_ARITIES` and `RELATION_ARITIES` keep requiring one common operand sort.
  Variables compare by name.
- The sort must be admissible for the operator: `isNumericSort` is replaced by a predicate table,
  for example "`Less` accepts ℕ ℤ ℚ ℝ ℂ today", and a rigid `K` passes iff `ext(K)` ⊆ that set.
  An unconstrained `T` has an infinite extension, so it never passes a numeric rule. It does pass
  `Equal`, `Element` against `set<T>`, `Set`/`List`/`Tuple`, and `Apply`.
- A numeric literal fits `K` iff it fits every member of `ext(K)`.
- `Limit`, `Sum` and `Product` use the same derivation. `Integrate` stays real-only.

### 4.3 Solving a result instantiation

`solveResultSorts(result, instantiation, targetContext, operators)` is exported from
mathjson-model and used by the kernel, retrieval and moves. It works in five steps:

1. For each free result parameter in declaration order, get the sort of the bound term with
   `inferTermSort` in the target's context, then `match(parameter.sort, termSort, σ)`.
   - If a term's sort is a bare numeric literal, defer it.
2. After all parameters, check each deferred literal against `σ(parameter.sort)`.
3. If a variable is bound only by literals (`3 + 0 = 3` against `add-zero`), choose the first
   member of its class extension, in the fixed order ℕ, ℤ, ℚ, ℝ, ℂ, that admits every such
   literal. This is sound because the result holds for every member. It is deterministic and
   independent of key order.
4. Check the classes of every `σ(K)`.
5. Determinacy (§3.2) guarantees the result is total whenever every term's sort is known.

The output is either σ or a diagnostic:

| Diagnostic                    | Example                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `sort-conflict`               | "x fixes K = integer but z is a real number"                                            |
| `sort-constraint-unsatisfied` | "K must be an ordered field (ℚ or ℝ); integer is not"                                   |
| `sort-undetermined`           | only when a term mentions undeclared symbols, which retrieval then reports as `unknown` |

### 4.4 Determinism and performance

**Determinism.**

- Every traversal is in operand order.
- σ is built in parameter order, and serialized with sorted keys.
- The literal tie-break is a fixed order.

**Performance.**

- Elaboration stays linear in expression size times sort size, and memoization removes today's
  repeated inference.
- Retrieval does one `solveResultSorts` per candidate instead of one schema-constructing probe per
  parameter, so suggestions should get _faster_.
- The polymorphic catalog is smaller than a per-sort duplicated one would be.
- The recorded N37 worst medians are 0.5 / 42 / 84 ms, against the §21.6 budgets of 50 / 150 /
  300 ms, so there is ample headroom.
- Acceptance: `corpus-performance.test.ts` stays within budget, with the migrated packs and the
  new pack added to the catalog.

## 5. Kernel and library

### 5.1 Kernel (`packages/kernel/src/results.ts`, `index.ts`)

- **`KernelResult` gains `sortParameters`.** `parseKernelResult` checks each parameter sort with
  `polySortSchema`, and checks premises and conclusion with those parameters as rigid variables
  (§4.2). `parameterDeclarations` builds probe declarations whose sorts may be rigid variables.
  This is internal: they are never states.
- **The operation schemas gain `sortInstantiation`** for `apply-result-backward` and
  `apply-result-forward`. It is optional, and must be absent for monomorphic results. Values are
  ground sorts, and the keys must be exactly the result's sort parameters.
- **`instantiateResultInContext`:**
  1. σ is the given `sortInstantiation`. If it is absent, σ comes from `solveResultSorts` on the
     instantiation terms; with no sort parameters σ is empty, which is today's path.
  2. Check every class constraint.
  3. Check every instantiation term against `σ(parameter.sort)`, using `inferTermSort`.
  4. A given σ is not required to equal the inferred one. When a variable is bound only by
     literals, any admissible member is correct, because the result holds for every member.
     Step 3 is what keeps a recorded σ honest: a σ inconsistent with the terms fails it.
  5. Substitute the terms as today. Statements contain no sorts, so σ is never substituted into
     MathJSON.
- **New `KernelDiagnosticCode`s:** `sort-instantiation-invalid`, `sort-constraint-unsatisfied`,
  `sort-conflict`.
- **`TransitionEvidence` does not change.** The kernel's success result echoes the σ it used, as
  `sortInstantiation`, next to `resultId`, so the protocol can store it on the edge.
- **The output state is still re-validated in full** by `createExecutableProofStateSchema`. That
  final check is independent of the polymorphic code: no ill-sorted state can be produced even
  if solving had a bug. The class check is the extra guard for _truth_, which re-validation
  cannot see.

### 5.2 Static history

New edges record σ in two places:

- the operation (`sortInstantiation`);
- the kernel result echo, stored with the edge and the command record.

Displayed suggestions record the σ they were computed with. Playback and the viewers read σ from
storage and never re-solve it.

Old edges have no σ. The kernel infers it during replay, and the stored child is reproduced
exactly, because statements do not contain sorts. The N27 importer therefore replays both v1 and
v2 artifacts (§8).

### 5.3 Library (`packages/library`)

- **Schemas.** `rawResultSchema` and `rawDefinitionSchema` gain `sortParameters` and a
  result-parameter schema allowing `PolySort`. `createLibraryResultSchema` validates under rigid
  variables.
- **Admission gate** (`admitLibraryArtifact`). Three new deterministic checks, with
  `LIBRARY_ADMISSION_DIAGNOSTIC_CODES`:
  - `sort-parameter-unused` / `sort-parameter-undeclared`;
  - `sort-parameter-undetermined` (determinacy, §3.2);
  - `sort-variable-in-untyped-binder` (§5.5).

  Background classification is unchanged: a polymorphic result's domains and level are authored
  as today.

- **Variants** (`variants.ts`). Every transformation (contrapositive, converse, symmetric
  equality, curried/uncurried bundling, forward/backward) is independent of sorts, so
  `generateVariants` copies `sortParameters` from the source. A test checks that every requested
  variant of every migrated result is admitted with identical sort parameters.
- **Derived results** (`derived.ts`). These are extracted from a session's monomorphic
  declarations, so they never have `sortParameters`. No change.
- **Operator environments.** `mergeLibraryOperators` and `libraryPacksForOperators` compare
  declarations by canonical JSON, as today. A session created after migration declares the
  polymorphic `Union` and uses it at any element sort.
- **Legacy sessions.** A session created before migration declares the old monomorphic `Union`
  over `set<element>`. For these, `libraryPacksForOperators` also offers
  `specializePack(pack, σ)` when the session's operators equal the pack's operators specialized
  at some σ. Here σ is read off by matching the signatures, for example `{T: element}`.
  - Specialization substitutes σ into operator signatures and result parameter sorts, and drops
    the satisfied `sortParameters`. It is deterministic.
  - A golden test pins `specializePack(sets, {T: element})` byte-for-byte to the pre-migration
    `starterLibraryPack("pack:sets")` JSON, captured before migration. Legacy sessions therefore
    see exactly what they saw before.

### 5.4 Moves, authored moves and macros (`packages/moves`)

- **`libraryResultToKernelResult`** (`result-adapter.ts`) carries `sortParameters` across.
- **`materializeResultApplication`** and **`completeInstantiation`** (`materialize.ts`):
  - solve σ from the matched bindings;
  - build each remaining parameter's menu from in-scope terms whose sort matches
    `σ(parameter.sort)`;
  - if a variable is still unbound, list terms of every admissible sort; choosing a term fixes
    the variable;
  - re-solve after menu choices, and reject an inconsistent combination as `requires-input`, with
    the conflict as the reason;
  - put the final σ in the operation.
- **Authored move templates (N35)** name results by id, and never pin σ: it is solved per
  application. Recorded examples and macros store complete operations, including σ, and replay
  them exactly.
- **`quantifierSort`** reads a context declaration, so it stays ground. N46 typed binders are
  independent of this work.

### 5.5 Binders inside polymorphic results

An untyped binder `["ForAll", "x", body]` takes `x`'s sort from the declarations in scope. In a
kernel result, that bound symbol is listed as a parameter that never gets instantiated (see the
comment on `KernelResult`). After instantiation, the target context would have to declare `x` at
the sort `σ(K)`, which nothing guarantees.

Rule: polymorphic results may bind variable-sorted symbols only with **typed binders over a
set-valued parameter**, for example `["ForAll", ["Element", "y", "A"], …]` with `A : set<T>`.
Admission rejects anything else.

Typed binders over standard sets (`RealNumbers`) are unaffected. A "universe of K" set term is a
non-goal for now; no planned pack needs it, because the laws are prenex.

## 6. Retrieval and selections

- **Discrimination tree** (`discrimination-tree.ts`). Keys stay free of sorts: `fn:<head>/<arity>`,
  `sym:`, `lit:`, `*`. Expressions contain no sorts, so a polymorphic pattern indexes exactly like
  its monomorphic predecessor, and the completeness test (tree ⊇ brute force) is unaffected.
  Retrieval stays an over-approximation; sorts are filtered afterwards.
- **Typed filtering** (`filtering.ts`). `bindingsTypeFit` becomes a joint check: call
  `solveResultSorts` on all bound parameters together.
  - A conflict or unsatisfied class gives `mismatch`. A variable left open only because a term
    mentions undeclared (for example enclosing-bound) symbols gives `unknown`.
  - The `sortCache` key becomes term ⊕ σ-relevant pattern.
  - The rank element "exact type fit" (index 3) keeps its meaning.
  - Monomorphic results go through the same function with an empty σ and get identical fits.
  - Using `nodeSorts` from the subject's elaboration also turns many of today's `unknown` fits
    for bound variables into `exact`. This is a ranking change, so it is reviewed against the
    golden file (§10).
- **Suggestions** carry `sortInstantiation` when the result is polymorphic. Near-miss reasons
  gain plain sentences: "Applies to ordered number systems; here the numbers are complex."
- **Abstraction wildcards (N33).** `RetrievalWildcard.sort` stays ground. Once selections expose
  term sorts, the abstract-selection gesture can set the wildcard's sort to the selected term's
  sort instead of leaving it unsorted. The worker's sort-match check in `proof-http/shared.ts`
  then compares the full sort, not just proposition versus term. A wildcard bound to a
  polymorphic parameter feeds its sort into `solveResultSorts` like a term would.
- **Selections** (`packages/selections`):
  - `contextPosition` and `scopedBindings` read custom-operator signatures. For a polymorphic
    custom binder, the bound operand's sort is `σ(parameter)`, with σ taken from the
    elaboration's `operatorInstantiations` at that node. A proposition-sorted parameter (needed
    for polarity) is never a variable, because classes are number systems.
  - The selection descriptor gains an optional ground `sort` for term selections, from
    `nodeSorts`.
  - `binderShape` already handles every built-in binder, so N46 and N47 do not touch the same
    binder code.

## 7. Problem setup and UI

### 7.1 A sort builder instead of a fixed list

Replace `PROBLEM_SETUP_SORT_CHOICES` (protocol `problem-setup.ts`) with a menu built from parts.
Nothing is typed by hand, and the depth is limited to 3.

- **Base:**
  - Proposition;
  - Number, then ℕ / ℤ / ℚ / ℝ / ℂ;
  - Element of a kind of object (`sort:element`, or a user-named sort, §7.2).
- **Constructor:**
  - Set of …;
  - Sequence of …;
  - List of …;
  - Pair/Tuple of … (2–4 components);
  - Function from … to …;
  - Predicate on …;
  - Vector over … / Matrix over … (scalars must be a field; offered when a pack declares them).

The draft schema stores the choice as a small tree of menu ids:

```json
{ "symbol": "A", "sort": { "constructor": "set", "of": { "number": "integer" } } }
```

Today's 11 flat ids (`"real"`, `"set-of-elements"`, …) remain valid shortcuts in a "Common
choices" group, so existing drafts and e2e specs still parse. `problemSetupSort` maps a tree to a
ground `Sort`. The options endpoint (`GET /problem-setup/options`) returns the parts instead of a
flat `sorts` list. The flat list stays as the shortcut group, so the web form can be migrated in
the same stage.

### 7.2 User-named sorts

"Add a kind of object" creates `sort:user:<slug>`. The display name is typed by the user; the slug
is derived from it. These are opaque named sorts, so they belong to no class.

This closes the N26 gap and covers "let G be a group" (carrier `sort:user:g`, plus operations and
premises). It is typed text, but it names a sort, not an expression or a sort term, so it does not
weaken the "no free-typed sorts" rule. The problem review shows it, and the approval digest covers
it.

### 7.3 Rendering for newcomers (`packages/language`)

- **`sortNoun`** (`terminology.ts`) learns:
  - `sequence` / `list` / `tuple` / `vector` / `matrix`, for example "sequence of integers" and
    "vector over the real numbers";
  - user sorts, by display name;
  - variables, as "an element of K" with a class gloss.
- **Class glosses** are fixed plain phrases:
  - `ordered` + `field`: "an ordered number system (ℚ or ℝ)";
  - `numeric`: "a number system";
  - unconstrained `T`: "any kind of object".

  The word "class" or "typeclass" never appears.

- **A new `renderSortLatex(sort)`** gives:
  - `\mathbb{N}` … `\mathbb{C}`;
  - `\mathcal{P}(\mathbb{Z})` for `set<integer>`;
  - `\mathbb{R}^{\mathbb{N}}` for a sequence;
  - `A \to B` for functions;
  - `\mathbb{R}^{n}` for vectors.

  Variables render as their letter.

- **Result cards** show the solved instantiation next to the term instantiation, as "with K = ℤ".
  The authored `renderings` of a polymorphic result are written generically, for example "For x,
  y, z in an ordered number system K: …". The natural-language view of the _instantiated_
  statement is the ordinary renderer applied to concrete MathJSON, so it needs no polymorphic
  logic.

## 8. Artifacts (N27)

- **Bump `PROOF_ARTIFACT_VERSION` to 2.** The v1 schema is strict, so an older importer would
  reject the new optional fields. New exports are v2.
- **The importer accepts `artifactVersion: 1 | 2`.**
  - A v1 artifact must contain no `sortParameters`, `sortInstantiation` or `variable` sorts. Any
    such field is a `version-mismatch` rejection, because it cannot have been produced by v1.
  - Otherwise v1 is imported through the same code path. Every edge is replayed with σ inferred
    (§5.2).
  - There is no up-conversion: imported rows are stored exactly as exported, and the digest is
    unchanged.
- **Tamper resistance.**
  - The `sha256` digest covers everything, as today.
  - If the digest is recomputed, a forged `sortInstantiation` is still caught by replay: the
    kernel rejects a class violation or a σ inconsistent with the terms, and a mismatch between
    σ and the stored edge or command fails the "reproduces stored edge" check.
  - Add these tamper cases to the existing 16:
    - σ violating a class;
    - σ inconsistent with the terms;
    - σ removed from one edge but not from its command record;
    - a polymorphic library addition whose `sortParameters` were edited;
    - a v1 artifact carrying a v2 field.
- **The translation dictionary** stores operator presentations, which are unchanged.
  `operatorEnvironment` stores polymorphic signatures verbatim.

## 9. Pack migration and the new pack

### 9.1 Existing packs (`packs.ts`)

| Pack                    | Becomes                                                                                                   | Notes                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `pack:elementary-logic` | unchanged                                                                                                 | propositions only                                                           |
| `pack:equality`         | `T` unconstrained                                                                                         | equality symmetry and transitivity hold at every sort                       |
| `pack:order`            | `K: [ordered]`; the monotonicity of `+` results use `[numeric, ordered]` (= ℕ ℤ ℚ ℝ)                      | the main win: integer and rational sessions get the order results           |
| `pack:arithmetic`       | commutativity, associativity, identities and distributivity use `K: [numeric]`; inverse laws use `[ring]` | `x·1 = x` holds in ℕ…ℂ                                                      |
| `pack:sets`             | `Union`, `Intersection` over `set<T>`; results over `T`                                                   | legacy sessions get `specializePack(…, {T: element})`                       |
| `pack:closure`          | `Closure : set<T> → set<T>`                                                                               | same legacy treatment                                                       |
| `pack:divisibility`     | `Divides` over `K: [integral]`                                                                            | `sort:integer` sessions unchanged; natural-number sessions gain the results |

**Result ids are kept.** Each migrated result is a _conservative generalization_: specializing it
at the old sort gives back the old result exactly. A test checks this for every migrated result,
comparing `specialize(new, σ_old)` with the captured pre-migration JSON. So old histories, which
name these ids, keep their meaning.

### 9.2 New pack: `pack:linear-algebra` (vectors over a field)

This is the most valuable new pack, for three reasons:

- it is impossible to state once without polymorphism, since it would otherwise need three copies
  for ℚ, ℝ and ℂ;
- it exercises a parametric constructor, a constrained variable and polymorphic operators
  together;
- it fills a domain the design plan names (§3), using only prenex laws, which the term language
  already supports.

Real analysis needs operators over ℝ more than it needs polymorphism (§9.3). It can follow
without further sort work.

**Operators.** Each has `sortParameters: [{name: "K", constraints: ["field"]}]`, with
`V = vector<K>` and `M = matrix<K>`:

| Symbol        | Signature                              | LaTeX         | NL                           |
| ------------- | -------------------------------------- | ------------- | ---------------------------- |
| `VectorAdd`   | `(V, V) → V`                           | `#1 + #2`     | "the sum of #1 and #2"       |
| `Scale`       | `(K, V) → V`                           | `#1 #2`       | "#1 times #2"                |
| `ZeroVector`  | `(V) → V` (zero of the same dimension) | `\mathbf{0}`… | "the zero vector"            |
| `Linear`      | `((V) → V) → proposition`              | —             | "#1 is linear"               |
| `MatrixApply` | `(M, V) → V`                           | `#1 #2`       | "#1 applied to #2"           |
| `Compose`     | `((V) → V, (V) → V) → ((V) → V)`       | `#1 \circ #2` | "the composite of #1 and #2" |

`ZeroVector` takes a vector argument only so that `K` is determined (§3.2). An alternative is a
dimension premise; this is open question Q4.

**Example results.** All are prenex, with `K: [field]`.

- `vector-add-commutativity`: `VectorAdd(u, v) = VectorAdd(v, u)`.
- `scale-distributes-over-vector-add`:
  `Scale(a, VectorAdd(u, v)) = VectorAdd(Scale(a, u), Scale(a, v))`.
- `scale-one`: `Scale(1, v) = v`. The literal `1` checks against rigid `K`, because every field
  member admits it.
- `scale-scale`: `Scale(a, Scale(b, v)) = Scale(Multiply(a, b), v)`. This uses built-in
  `Multiply` at `K`, which `field` ⊆ `numeric` allows.
- `linear-additive`: `Linear(f) ⊢ f(VectorAdd(u, v)) = VectorAdd(f(u), f(v))`.
- `linear-homogeneous`: `Linear(f) ⊢ f(Scale(a, v)) = Scale(a, f(v))`.
- `linear-composition`: `Linear(f), Linear(g) ⊢ Linear(Compose(f, g))`, using a polymorphic
  `Compose : ((V) → V, (V) → V) → ((V) → V)`. An untyped lambda such as
  `["Function", f(g(x)), x]` cannot be used here. Its parameter sort is not inferable bottom-up,
  and a typed binder over `vector<K>` would need the universe set that §5.5 excludes.
- `linear-zero`: `Linear(f) ⊢ f(ZeroVector(v)) = ZeroVector(v)`.

Corpus additions (N37 style), each solved by scripted displayed suggestions over HTTP:

- "a linear map sends `u + u` to `f(u) + f(u)`" over ℝ;
- the same problem over ℚ, which shows one pack serving two sorts;
- "the composite of linear maps is additive".

### 9.3 Follow-ups made cheap by this design

- **`pack:finite-sets`.** `Card : set<T> → natural` and `Finite : set<T> → proposition`. Results
  include `Card(A ∪ B) + Card(A ∩ B) = Card(A) + Card(B)` and monotonicity of `Card` under `⊆`.
  It needs no class.
- **`pack:sequences`** over ℝ. `TendsTo : ((natural) → real, real) → proposition`, with limit
  arithmetic.
  - It is monomorphic, unless open question Q1 extends it to `[ordered, field]`.
  - It needs the `Coerce` lemmas when indices meet real values.

## 10. Staged implementation plan

Each stage is one well-defined subtask with the file ownership listed. A stage is done when
`npm run verify` passes, and when `npm run test:e2e:workspace` also passes for any stage touching
web or worker.

The property tests named here use fast-check (`packages/*/src/*.test.ts`):

- **P1 parametricity.** For random polymorphic statements over random declared sort parameters:
  if the statement checks with rigid variables, it checks under every σ. σ ranges over every
  member of each constrained class, and over random ground sorts (named, set, function, user)
  for unconstrained variables.
- **P2 instantiation preserves well-sortedness.** For a random admitted polymorphic result,
  random admissible σ, and random terms with sort `σ(param)` in a random ground context, the
  instantiated premises and conclusion validate in that context.
- **P3 no ill-sorted transition.** Random `apply-result-*` operations, including wrong σ, wrong
  terms, missing σ, extra keys and class violations, are never accepted unless an independent
  oracle agrees: enumerate the class members, check each term with `inferTermSort`, and confirm
  the output state validates.
- **P4 class guard.** A density-style `[ordered, field]` result is rejected at ℕ and ℤ, whatever
  the terms are.
- **P5 monomorphic invariance.** For random monomorphic statements and environments,
  `elaborate`-based validation gives the same answer as the pre-change checker, which is kept as
  a test-only oracle copied into the test file. All existing golden validation tests stay
  unchanged.
- **P6 conservative migration.** `specialize(migrated, σ_old)` deep-equals the captured
  pre-migration JSON, for every migrated result and pack.
- **P7 determinism.** σ solving and the elaboration output do not depend on the key order of
  object inputs, and are stable across runs.
- **P8 replay.** An operation with σ omitted produces the same child state and the same echoed σ
  as the operation with the recorded σ.

### S1 — Sort model and elaboration (mathjson-model)

**Owns:** `packages/mathjson-model/src/contracts.ts`, a new `packages/mathjson-model/src/sorts.ts`
(PolySort, classes, match, substitute, `solveResultSorts`, `SORT_CONSTRUCTORS`), the `index.ts`
exports, and tests.

**Delivers:**

- §3.1–§3.2 schemas, with ground-only refinement on `Declaration` and `RetrievalWildcard`;
- `elaborate`, `inferTermSort`, and polymorphic operator application;
- rigid-variable built-in rules;
- the `Coerce` typing rule;
- the class table.

**Accept:** P1, P5, P7, and unit golden cases for every diagnostic.

### S2 — Kernel instantiation (after S1; after N39 lands in `kernel/index.ts`)

**Owns:** `packages/kernel/src/results.ts`, the parts of `packages/kernel/src/index.ts` covering
the operation schema, diagnostics and the result echo, `packages/moves/src/result-adapter.ts`,
and tests. The kernel's `termHasSortInContext` delegates to `inferTermSort`.

**Accept:**

- P2, P3, P4, P8;
- all kernel tests unchanged;
- `matchResultConclusion` still ignores sorts, as its contract says.

### S3 — Library schemas, admission, variants, migration (after S1; parallel with S2)

**Owns:** `packages/library/src/{index,additions,variants,packs}.ts` and tests.

**Delivers:**

- `sortParameters` on results and definitions;
- the three admission checks;
- variants carrying sort parameters;
- `specializePack`, with legacy-operator matching in `libraryPacksForOperators`;
- migration of the packs in §9.1.

Capture the pre-migration pack JSON fixture as the _first_ commit of this stage.

**Accept:** P6; every migrated result and variant is admitted; the fixture golden matches.

### S4 — Retrieval, materialization, selections, worker wiring (after S2 and S3)

**Owns:**

- `packages/retrieval/src/{filtering,index}.ts`;
- `packages/moves/src/{materialize,context-terms}.ts` (`sortFilter` delegates);
- `packages/selections/src/index.ts`;
- the protocol suggestion, menu and edge schemas (`command-protocol.ts`, `parameter-menus.ts`);
- worker `approved-catalog.ts` and `proof-http/shared.ts`.

**Delivers:** joint typed fit, recorded σ on suggestions and edges, menus filtered by σ, selection
term sorts, and sorted abstraction wildcards.

**Accept:**

- the retrieval completeness test is unchanged;
- an integer-sorted session gets `less-transitivity` suggested and applied over HTTP, with σ
  stored on the edge;
- a menu test over an unresolved variable;
- the full benchmark corpus solves with **unchanged scripts**;
- `corpus-coverage.golden.json` changes only in reviewed, explained places. The expected changes
  are added candidates and ranks in integer-sorted number-theory problems, and `unknown → exact`
  fits. Real- and element-sorted problems are expected to be byte-identical.
- the performance budgets hold.

### S5 — Problem setup, rendering, coercion input (after S1; parallel with S2–S4)

**Owns:**

- `packages/protocol/src/problem-setup.ts`;
- worker `problem-setup.ts` and `problem-setup-routes.ts`;
- `packages/language/src/{terminology,latex,natural-language}.ts`;
- the web problem-entry form and suggestion-card σ display (`apps/web/src/features/…`).

**Delivers:** the sort builder and user sorts (§7), `renderSortLatex`, sort nouns, and `Coerce`
rendering and insertion at parse time.

**Accept:**

- old flat sort ids still validate;
- fast-check that every builder tree of depth ≤ 3 maps to a schema-valid ground sort;
- the component test for the builder;
- `problem-entry.spec.ts` is extended with a set-of-integers declaration.

### S6 — Artifacts, new pack, corpus (after S4; the S6a and S6b halves can run in parallel)

**S6a owns** `packages/protocol/src/artifact.ts` and worker `artifact-import.ts` /
`artifact-export.ts`.

- **Delivers:** v2, acceptance of v1, and the new tamper cases.
- **Accept:** a v1 fixture exported _before_ S2 is committed in S2 and imports with an identical
  replay; a v2 round trip; every tamper case is rejected.

**S6b owns** `packages/library/src/{packs,corpus}.ts` (the new pack sections only) and the worker
corpus golden.

- **Delivers:** `pack:linear-algebra` (§9.2), plus coercion lemmas in the arithmetic pack, and
  three or more corpus problems.
- **Accept:** the corpus solves over HTTP; the golden is extended; the performance budgets hold.

**Parallelism:**

```
S1 → {S2 ∥ S3 ∥ S5}
S2 + S3 → S4
S4 → {S6a ∥ S6b}
```

S3 and S6b both touch `packs.ts`, but they are sequential.

## 11. Open questions

**Q1. Should built-in rules be tightened on concrete sorts?** Today the checker accepts:

- `Divide` on ℕ/ℤ, returning ℕ/ℤ;
- `Subtract` on ℕ;
- `Less`, `Max`, `Min` and `Abs` on ℂ (with `|z| : ℂ`).

_Recommendation:_ yes, in S1, with these rules:

- `Divide` on ℕ/ℤ is ill-sorted; use `Coerce` to ℚ;
- `Subtract` on ℕ is ill-sorted;
- order on ℂ is ill-sorted;
- `Abs : ℂ → ℝ`.

No corpus, pack or e2e data uses these forms. Add a one-off script that reports any stored session
that would stop validating, and run it before merging. If you prefer zero risk to stored data,
keep the lenient rules. Constrained variables still give the right sorts (§2.3), but concrete
statements stay loose.

**Q2. Should explicit `Coerce` be part of N47, or deferred?** _Recommendation:_ include it, but
keep it minimal:

- the typing rule (S1);
- invisible LaTeX rendering and parse-time insertion (S5);
- four preservation lemmas (S6b).

Without it, the migrated order pack still cannot relate an integer to a real. Mixed-sort input
would keep failing at problem entry, which is the most visible monomorphism complaint.

**Q3. Which new pack comes first?** _Recommendation:_ `pack:linear-algebra` over a field (§9.2),
with `pack:finite-sets` (§9.3) as a small second pack in S6b if time allows. Sequences and limits
over ℝ follow as their own roadmap item, because they mainly need operators, not polymorphism.

**Q4. How should `ZeroVector` be determined?** Options are the zero vector "like v" (argument
form), or a nullary `ZeroVector` whose `K` comes from the expected sort (return-type
polymorphism). _Recommendation:_ the argument form. It keeps determinacy simple, at the cost of a
slightly odd LaTeX rendering (`\mathbf{0}`, ignoring the argument).

**Q5. Should user-named sorts (§7.2) be in N47?** _Recommendation:_ yes. They are what makes "an
arbitrary set of objects" or "a group's carrier" expressible without sort variables in states, at
little cost: one builder entry, one sort noun, and the review display.
