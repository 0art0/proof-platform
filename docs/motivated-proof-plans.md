# Motivated proof plans

A strong model writes a whole structured, motivated proof of the problem first. The platform then
walks that proof one step at a time, and Jev turns each step into actions the platform already
offers: a selection, one of the displayed suggestions, and items from its menus. The person steps
through the walk and sees what every step produced. A step that no displayed action can carry out
is reported as a missing move. This is the failure mode of refinement §2.1: "a mathematician can
give a convincing motivated account that the interface cannot express."

This document refines design plan §13, §15 and §18, refinement §2, and
`docs/ai-agents-architecture.md`. `docs/ai-endpoints.md` documents the routes as they ship.

## 1. Roles and boundaries

| Role              | Model (default)     | Sees                                                                       | Produces                                |
| ----------------- | ------------------- | -------------------------------------------------------------------------- | --------------------------------------- |
| `proof-planner`   | `openai/gpt-6-luna` | problem, background, active constants, session library, initial state      | one structured proof (§2), or a refusal |
| `step-translator` | `typesafe-ai/jev`   | one plan step, its enclosing claim, the focused sequent, candidate actions | a probability over the candidates (§4)  |

- **The planner is a stateful proof agent** (design plan §15.1). It is the one role that receives
  the original problem. Its output is a static record: the stored, validated plan is never
  regenerated or rewritten, and later steps are translated from the stored copy.
- **The translator has minimal context** (§15.3). It never sees the problem text, the rest of the
  plan or other branches, only the step, the claim the step is part of proving, the focused goal and
  the deterministically computed candidates.
- **Neither role mutates proof state.** Jev only chooses among displayed suggestions and displayed
  menu items. The platform previews the choice through the ordinary preview path, and the person
  applies it. The commit is an ordinary command through the command service and the kernel, with an
  `agent` actor (`actor:proof-planner`), so history keeps the stateful-agent provenance apart from
  human choices (§15.4). A choice the person makes from the alternatives instead is a human command.
- **Deterministic work runs first.** Candidate enumeration, menu generation, numbering, scoping
  checks, statement parsing and step-realization checks are all deterministic. Jev is called only
  when there is more than one thing to choose from.

## 2. The structured proof format

### 2.1 What we take from Lamport

Lamport's structured proofs ("How to Write a Proof", 1993; "How to Write a 21st Century Proof",
2012; the TLA+ proof language) rest on a few ideas. Each one is useful here for its own reason.

1. **Hierarchy.** A proof is a sequence of numbered steps. Each step asserts something and has its
   own proof, which is either a leaf (a `BY` justification) or a further sequence of steps. A reader
   can stop at any level. In the UI the plan is a collapsible tree. In the translator, a step's
   sub-proof bounds the work its translation may do.
2. **Every step is an assertion.** Every step states exactly what it claims, not what to "do". This
   lets the platform check a step: when the claim parses in the session's notation, whether the
   step has been carried out is a deterministic test (§3.3), not a judgement.
3. **A closed set of step forms.** `SUFFICES`, `ASSUME`/`PROVE`, `CASE`, `PICK`, `WITNESS`, `QED`
   and the plain assertion each have a fixed effect on the current goal. That effect is what
   translates into moves. A closed set also makes a missing move precise: we know which form was
   wanted, on what goal.
4. **Every proof ends in a QED step**, which proves the enclosing goal from the steps before it. In
   a goal-directed platform this is the step that closes the focused goal, and it is the natural
   checkpoint.
5. **Explicit citations with lexical scope.** A leaf proof names the facts it uses: earlier steps,
   assumptions and library results. A step may cite only facts in scope: the problem's hypotheses,
   earlier siblings of itself and of its ancestors, and the assumptions of enclosing `CASE` and
   `SUFFICES ASSUME` steps. The validator enforces this. The translator uses the citations to choose
   which statements to select.
6. **Numbering by level, `⟨level⟩index`.** The platform derives the numbers from the structure. The
   model never writes them: it names steps with labels and cites labels.
7. **A short prose sketch first**, for the reader who wants only the idea.

### 2.2 What we add for motivated proofs

Lamport's format justifies steps. It does not motivate them. Following Gowers's motivated proofs
and refinement §2, every step that makes a choice also says why that choice is natural at that
point. The format keeps motivation strictly separate from justification: `motivation` is a
`motivatedBy`-style reason and never counts as evidence (refinement §3), while `by` is the
justification.

The format also keeps the platform's distinctions visible (`AGENTS.md`). A leaf justification says
whether it relies on approved library results (`by.results`), on facts in scope (`by.facts`), or on
background knowledge outside the library (`by.background`, a candidate background inference that
the platform will not accept silently). A step the model cannot justify must say so in
`by.background`. There is no "obvious".

### 2.3 Step forms and their effect on the goal

Every step list proves one goal, its **focus**. The top-level list proves the theorem. The list
under a `CASE` proves the enclosing goal under the case condition. The list under a plain assertion
proves that assertion.

| Form       | Lamport                                       | Effect on the focus                                                                    | Typical platform moves                                                                          |
| ---------- | --------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `suffices` | `SUFFICES [ASSUME NEW x, A] PROVE P`          | the focus becomes P (under the new variables and assumptions); later siblings prove it | introduce implication/universal/negation, apply a result backward, rewrite the goal, `suffices` |
| `have`     | plain step `⟨n⟩k. P`                          | P becomes a hypothesis of the focus                                                    | apply a result forward, modus ponens, rewrite a hypothesis, instantiate a universal             |
| `cases`    | `CASE` steps with a QED citing exhaustiveness | the focus splits into one goal per case                                                | split a disjunctive hypothesis, split on a proposition                                          |
| `case`     | `CASE P`                                      | (child of `cases` only) the case's condition is a hypothesis of its goal               | (the split itself)                                                                              |
| `pick`     | `PICK x : P(x)`                               | a new variable x and hypothesis P(x) from an existential hypothesis                    | unpack an existential hypothesis                                                                |
| `witness`  | `WITNESS t`                                   | an existential focus `∃x. P(x)` becomes `P(t)`                                         | choose an existential witness                                                                   |
| `assume`   | `ASSUME A PROVE P` (local lemma)              | the implication `A ⇒ P` becomes a fact for later siblings                              | none yet: needs a claim (cut) move, so it is reported (§3.4)                                    |
| `qed`      | `QED`                                         | the focus is closed                                                                    | close by hypothesis, by contradiction, by reflexivity, apply a result backward                  |

Structural rules, checked deterministically:

- Every step list ends with exactly one `qed` step, and `qed` is never anywhere else.
- `cases` has at least two children, all of form `case`; `case` appears only under `cases`; a
  `cases` step is the last step of its list before `qed`, or the list's last step.
- `suffices`, `pick` and `witness` have leaf proofs only (their sub-proof would prove the reduction,
  which the platform's own move justifies).
- `have`, `assume`, `case` and `qed` may have sub-proofs. A `case` must have one.
- Depth at most 6 levels, at most 64 steps.

### 2.4 Wire shape

Steps form a flat list in reading order, each with its parent's label. Flat lists are easier for a
model to keep consistent than deep nesting and need no recursive schema. The platform rebuilds the
tree and checks that every step's children follow it contiguously.

```jsonc
{
  "kind": "proof",
  "theorem": { "latex": "\\neg q \\implies \\neg p", "prose": "If not q, then not p." },
  "sketch": "Assume not q and derive not p by modus tollens from the hypothesis p implies q.",
  "steps": [
    {
      "id": "assume-not-q",
      "parent": null,
      "form": "suffices",
      "claim": { "latex": "\\neg p", "prose": "not p" },
      "variables": [],
      "assumptions": [{ "latex": "\\neg q", "prose": "not q" }],
      "term": null,
      "actsOn": ["goal"],
      "by": {
        "facts": [],
        "results": [],
        "background": null,
        "method": "implication introduction",
      },
      "motivation": "The goal is an implication, so assume its antecedent and aim for its consequent.",
    },
    {
      "id": "not-p",
      "parent": null,
      "form": "have",
      "claim": { "latex": "\\neg p", "prose": "not p" },
      "variables": [],
      "assumptions": [],
      "term": null,
      "actsOn": ["H1", "assume-not-q"],
      "by": {
        "facts": ["H1", "assume-not-q"],
        "results": ["result:modus-tollens"],
        "background": null,
        "method": "modus tollens",
      },
      "motivation": "We know p implies q and not q; modus tollens turns exactly this pair into not p.",
    },
    {
      "id": "qed",
      "parent": null,
      "form": "qed",
      "claim": null,
      "variables": [],
      "assumptions": [],
      "term": null,
      "actsOn": ["goal", "not-p"],
      "by": { "facts": ["not-p"], "results": [], "background": null, "method": null },
      "motivation": null,
    },
  ],
}
```

Fields:

- `claim`: `{ latex, prose }`. `prose` is the semi-formal statement, and is always present.
  `latex` uses only the session's notation; it is `null` when the claim cannot be written in it.
  Required for `suffices` (the new goal), `have` and `assume` (the asserted statement), `case` (the
  condition) and `pick` (the property of the picked variables); `null` for `qed` and `cases`. For
  `witness` it is the instantiated goal.
- `variables`: the `NEW` variables of `suffices`, or the variables of `pick`, as `{ name, sort }`.
- `assumptions`: the `ASSUME` part of `suffices` or `assume`.
- `term`: the witness of `witness`, otherwise `null`.
- `actsOn`: what the step operates on: `"goal"` (the focus), problem hypotheses (`H1`, `H2`, ...,
  numbered as the planner was shown them) and earlier step labels. The translator turns them into
  selections (§3.2).
- `by`: the leaf justification. `facts` cites hypotheses and step labels in scope, `results` cites
  library result IDs from the planner's context, `background` names any outside fact, and `method`
  is a short name of the inference.
- `motivation`: required for every form except `qed` and `case`.

The planner may instead answer `insufficient-context` (with what is missing) or `declined`.

### 2.5 Validation

The worker stores only a plan that passes all of the following. Anything else is recorded as a
rejected output with diagnostics naming the step and the field.

- Unique labels; every parent exists and precedes its children; children are contiguous.
- The form rules of §2.3, including the QED rule and the per-form required and forbidden fields.
- Scope: every `facts` and `actsOn` entry is `"goal"` (only in `actsOn`), a problem hypothesis
  label, or a step in scope (§2.1, item 5). Every `results` entry is a library result the planner
  was shown.
- Size limits on text and lists.

Each `latex` field is then parsed in the session's operators. A field that does not parse is kept
as prose only and reported as a warning; it never invalidates the plan.

## 3. Walking the plan

### 3.1 Units

The platform linearizes the tree into **units** in a fixed order. Each unit is one step whose own
effect (§2.3) must be carried out:

- `suffices`, `cases`, `pick`, `witness`: the step itself, then its children.
- `case`: no unit of its own (the split happened at `cases`); its children follow, with the focus
  set to the case's goal.
- `have` and `qed` with a sub-proof: the children first, in the same focus, then the step itself.
  When the sub-proof has already established the claim, the step needs no move.
- `assume` (a local lemma): reported as `unsupported` and its subtree skipped (§3.4).

A `have` whose sub-proof contains `suffices`, `cases` or `witness` reasons backward towards an
intermediate claim. That needs a claim (cut) move, which the platform does not have, so the `have`
and its subtree are also reported as `unsupported`.

### 3.2 Translating one unit

A unit is translated one move at a time.

1. **Realized?** The deterministic realization check (§3.3) runs first. A unit that is already
   realized returns `realized` without a model call.
2. **Enumerate candidates.** The worker builds selection sets on the focused goal, in this order,
   and runs the ordinary retrieval and move menu on each (the same pure function that serves a
   suggestion request):
   1. all statements the step's `actsOn` names, together;
   2. each of them alone;
   3. the focus's conclusion; each hypothesis; the conclusion with each hypothesis;
   4. each equation or equivalence hypothesis with each subterm of another statement that equals
      one of its sides (a rewrite needs both selections).

   Every displayed suggestion of every set is a candidate action. Duplicates (the same suggestion on
   the same selections) are dropped, and at most 48 candidates are kept, in enumeration order then
   the retrieval's own rank. The count of dropped candidates is recorded.

3. **Ask Jev.** One Choice question offers every candidate, labelled by its name and its selected
   fragments in LaTeX, plus two reserved options:
   - `outcome:no-move`: "None of the listed actions carries out this proof step or a part of it."
   - `outcome:step-realized`, offered only after a move of this unit has been applied and when the
     realization check cannot decide (the claim did not parse): "The actions already taken carry
     out this proof step."
4. **Menus.** If the chosen suggestion needs menu choices, the worker asks the ordinary preview for
   its menus and asks Jev one Choice question per menu, each over the displayed items, plus
   `outcome:no-fitting-item`.
5. **Preview.** The worker records the displayed suggestion set of the chosen selection (ID
   `suggestion-set:<callId>`) and previews the choice through the ordinary preview path. Nothing is
   committed.

The answer is one of:

| Status                 | Meaning                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `proposed`             | a previewed move, with Jev's confidence and the next best candidates                             |
| `realized`             | the unit's effect is already present; the answer gives the goals and hypotheses it produced      |
| `uncertain`            | Jev's best answer is below the confidence threshold; the top candidates are shown to choose from |
| `no-move`              | no candidate exists, or Jev chose `outcome:no-move` confidently: a missing move                  |
| `missing-construction` | the move exists but none of its menu items is the value the step needs                           |
| `unsupported`          | the step's form cannot be realized on the platform yet (§3.4)                                    |
| `stuck`                | four moves were applied for this unit without realizing it                                       |

### 3.3 Realization checks

Each check compares the focus at the start of the unit with the current state. The kernel keeps a
goal's ID when a move updates it, and replaces it with new goals when a move splits or closes it.

- `qed`: the focus is closed, and no goal created since the unit started is open.
- `suffices`: the focus (or the one goal that replaced it) has the claim as its conclusion, and the
  assumptions among its hypotheses. Without a parsed claim: the conclusion changed and, if
  assumptions were stated, as many hypotheses were added.
- `have`: some hypothesis of the focus equals the claim. Without a parsed claim: Jev's
  `outcome:step-realized` decides, after at least one move.
- `cases`: the focus was replaced by as many goals as there are cases; the case goals are matched to
  the cases by their conditions when they parse, otherwise in order.
- `pick`: the focus gained the picked declarations' count of new declarations and a hypothesis
  (equal to the claim when it parses).
- `witness`: the focus's conclusion equals the claim when it parses, otherwise it changed from an
  existential.

Equality is alpha-equivalence in the session's operators. A `realized` answer returns the unit's
outputs: the new focus or case goals, and the hypotheses that correspond to the step's label, which
later steps' `actsOn` and `facts` resolve to.

### 3.4 Reports

The walk ends when the theorem's QED is realized, or it stops at the first unit the person does not
continue past. Every unit's status is kept, and the **missing-move report** lists each `no-move`,
`missing-construction`, `unsupported` and `stuck` unit with:

- the step (number, form, claim, motivation, justification);
- the focused sequent, rendered;
- what was offered: the number of candidates and the best ones with their probabilities.

This is the input to move development (refinement §2.1). From a reported unit the person can
describe the step in the move-instructions box (the move executor) or skip it. Skipping leaves the
proof as it is and continues with the next unit; later units may then fail too, which the report
shows.

## 4. The step-translator role

Jev answers Choice questions, so the role has two kinds of call, each one recorded LLM call of
role `step-translator`:

- `kind: "action"`: context `{ plan: { callId, stepNumber, form }, step, enclosingClaim, focus,
movesSoFar, candidates }`, one question `action`.
- `kind: "menus"`: context `{ plan, step, focus, suggestion, menus }`, one question per menu.

The validated output is the chosen ID (a candidate, a menu item, or a reserved outcome), the
probabilities and the confidence. The confidence threshold is
`PROOF_AI_TRANSLATOR_MIN_CONFIDENCE` (default `0.5`).

## 5. Interface

The workspace gains a **Proof plan** panel beside the move-instructions panel.

- "Write a proof plan" asks the planner (disabled, with the reason, when the role is not
  configured or the session is read-only). Writing at high effort can take minutes, which the
  button says.
- The plan is shown as Lamport's tree: `⟨1⟩1`, `⟨2⟩3`, with form keywords (SUFFICES, CASE, PICK,
  WITNESS, QED), the claim in LaTeX (prose when it did not parse), and the motivation and
  justification under each step, collapsible by level. The sketch is shown first.
- The current unit is highlighted. **Next move** translates it and shows the proposed move: the
  selected statements, the suggestion's name, the menu choices, Jev's confidence, the transition
  class (equivalence, strengthening or weakening) and the ordinary before/after preview, with the
  next best candidates beneath. **Apply** commits it; **Choose this instead** on an alternative
  previews that one as the person's own choice; **Skip step** moves on.
- **Run to the end** repeats Next move and Apply until a unit stops being `proposed` or `realized`.
- Every unit shows its status as a mark in the tree. "Missing moves" lists the report (§3.4) and can
  be copied as JSON.
- The walk's progress is kept in the tab's session storage, anchored to the plan's call ID and to
  the proof node it reached. A walk whose node is no longer the session's current node stops and
  says so; the person can restart it from the current state.

## 6. Configuration

| Variable prefix        | Default                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `PROOF_AI_PLANNER_`    | `openai/gpt-6-luna`, `xhigh`, 32,000 tokens, timeout 600,000 ms |
| `PROOF_AI_TRANSLATOR_` | `typesafe-ai/jev`, minimum confidence 0.5                       |

Both roles report themselves in `GET /ai/capabilities`, share the cost guard, and widen the call
role constraint in migration `0020_llm_proof_plan_roles.sql`.

## 7. Open questions

- **A claim (cut) move.** Local `ASSUME`/`PROVE` lemmas and backward sub-proofs of intermediate
  claims need one. It belongs in the move library with its own review, not in the translator.
- **Two-premise forward steps.** Retrieval finds premises among the hypotheses. When it cannot, the
  candidate list lacks the right action; the report will show how often this happens.
- **Planner–platform vocabulary.** The planner is not told the move catalog, deliberately: the
  plan should be the motivated proof a mathematician would write, so that gaps show up. Whether a
  "platform-aware" planning mode is also useful is for evaluation.
