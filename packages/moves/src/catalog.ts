import type { PlainMathJson } from "@proof/mathjson-model";
import type { MoveOperationKind, MoveParameter, MoveSelectionSlot } from "./index";

export type MoveCatalogInput = Readonly<{
  suffix: string;
  name: string;
  description: string;
  operationKind: MoveOperationKind;
  slots: readonly MoveSelectionSlot[];
  pattern: PlainMathJson;
  parameters: readonly MoveParameter[];
  positive: readonly [string, string];
  negative: string;
  /**
   * Patterns on selection slots other than the primitive's primary pattern
   * slot. A move whose primary pattern lives on a non-target slot uses one to
   * remain reachable, as a partly-filled selection, from its target slot.
   */
  extraPatterns?: readonly Readonly<{ slotId: string; pattern: PlainMathJson }>[];
}>;

export const catalogInputs: readonly MoveCatalogInput[] = [
  catalogEntry(
    "close-by-hypothesis",
    "Close by hypothesis",
    "Close a target that exactly matches a local hypothesis.",
    [slot("target", "target-conclusion", "proposition"), slot("fact", "hypothesis", "proposition")],
    "p",
    [parameter("hypothesisId", "Hypothesis", "selection")],
    [
      "A goal p with local hypothesis p.",
      "An obligation whose conclusion exactly matches a local fact.",
    ],
    "The matching fact exists only in another goal's context.",
  ),
  catalogEntry(
    "close-true",
    "Close truth",
    "Close a target whose conclusion is True.",
    [slot("target", "target-conclusion", "proposition")],
    "True",
    [],
    ["A goal with conclusion True.", "An obligation with conclusion True."],
    "The target merely simplifies to True but is not structurally True.",
  ),
  catalogEntry(
    "close-false-hypothesis",
    "Close from falsity",
    "Close any local target from an explicit False hypothesis.",
    [
      slot("target", "target-conclusion", "proposition"),
      slot("false", "hypothesis", "proposition"),
    ],
    "False",
    [parameter("hypothesisId", "False hypothesis", "selection")],
    [
      "A goal under a False hypothesis.",
      "An obligation under an explicit contradiction already reduced to False.",
    ],
    "No False hypothesis is present in the target's local context.",
  ),
  catalogEntry(
    "close-reflexive-equality",
    "Close by reflexivity",
    "Close a target that equates a term with itself, up to renaming of bound symbols.",
    [slot("target", "target-conclusion", "proposition")],
    ["Equal", "x", "x"],
    [],
    ["A goal x = x.", "An obligation equating two alpha-equivalent sides."],
    "The two sides of the equality differ.",
  ),
  catalogEntry(
    "close-by-contradiction",
    "Close by contradiction",
    "Close any target from a local hypothesis P and a local hypothesis not P.",
    [
      slot("target", "target-conclusion", "proposition"),
      slot("fact", "hypothesis", "proposition"),
      slot("negation", "hypothesis", "proposition"),
    ],
    ["Not", "p"],
    [
      parameter("hypothesisId", "Hypothesis", "selection"),
      parameter("negationHypothesisId", "Negated hypothesis", "selection"),
    ],
    [
      "A goal under local hypotheses p and not p.",
      "An obligation whose context contains a statement and its alpha-equivalent negation.",
    ],
    "The negated hypothesis negates a different statement than the selected fact.",
  ),
  catalogEntry(
    "close-by-accepted-inference",
    "Close by accepted inference",
    "Close a target on a recorded background attestation; the kernel records but does not judge it.",
    [slot("target", "target-conclusion", "proposition")],
    "p",
    [parameter("attestationId", "Attestation", "menu")],
    [
      "Close a routine arithmetic goal that an attestation accepted within the background.",
      "Close an obligation whose inference was attested as correct and in scope.",
    ],
    "No recorded attestation accepts the step, so the target stays open.",
  ),
  catalogEntry(
    "introduce-implication",
    "Introduce implication",
    "Turn a goal A implies B into goal B under hypothesis A.",
    [slot("target", "target-conclusion", "proposition")],
    ["Implies", "p", "q"],
    [parameter("hypothesisId", "Antecedent hypothesis ID", "generated-id")],
    ["Prove p implies q by assuming p.", "Introduce the antecedent of an implication obligation."],
    "The selected conclusion is not a binary implication.",
  ),
  catalogEntry(
    "introduce-negation",
    "Introduce negation",
    "Turn goal not A into False under hypothesis A.",
    [slot("target", "target-conclusion", "proposition")],
    ["Not", "p"],
    [parameter("hypothesisId", "Negated hypothesis ID", "generated-id")],
    [
      "Prove not p by deriving False from p.",
      "Open a negated obligation as a contradiction subproblem.",
    ],
    "The selected conclusion is not unary negation.",
  ),
  catalogEntry(
    "split-goal-conjunction",
    "Split conjunction goal",
    "Replace a conjunction target with one independent target per conjunct.",
    [slot("target", "target-conclusion", "proposition")],
    ["And", "p", "q"],
    [parameter("childIds", "Child target IDs", "generated-id")],
    [
      "Split goal p and q into goals p and q.",
      "Split a variadic conjunction obligation into all of its conjuncts.",
    ],
    "The number of supplied child IDs does not match the conjunction arity.",
  ),
  catalogEntry(
    "choose-goal-disjunct",
    "Choose disjunct",
    "Strengthen a disjunction target to one selected disjunct.",
    [slot("target", "target-conclusion", "proposition")],
    ["Or", "p", "q"],
    [parameter("disjunctIndex", "Disjunct", "menu")],
    ["Prove p or q by choosing p.", "Choose one branch of a variadic disjunction obligation."],
    "The chosen index is outside the disjunction.",
  ),
  catalogEntry(
    "expand-hypothesis-conjunction",
    "Expand conjunction hypothesis",
    "Replace a local conjunction hypothesis with each conjunct.",
    [
      slot("target", "target-conclusion", "proposition"),
      slot("conjunction", "hypothesis", "proposition"),
    ],
    ["And", "p", "q"],
    [parameter("expandedHypothesisIds", "Expanded hypothesis IDs", "generated-id")],
    [
      "Use p and q as separate facts from hypothesis p and q.",
      "Expand all operands of a variadic conjunction hypothesis.",
    ],
    "The selected hypothesis is not a conjunction.",
    [{ slotId: "target", pattern: "t" }],
  ),
  catalogEntry(
    "split-hypothesis-disjunction",
    "Split cases",
    "Create one independent target for every disjunct of a local hypothesis.",
    [
      slot("target", "target-conclusion", "proposition"),
      slot("disjunction", "hypothesis", "proposition"),
    ],
    ["Or", "p", "q"],
    [
      parameter("childIds", "Case target IDs", "generated-id"),
      parameter("branchHypothesisIds", "Case hypothesis IDs", "generated-id"),
    ],
    [
      "Prove a target separately under p and under q from p or q.",
      "Create all cases of a variadic disjunction hypothesis.",
    ],
    "One case or one generated ID is omitted.",
    [{ slotId: "target", pattern: "t" }],
  ),
  catalogEntry(
    "split-classical-cases",
    "Split on a proposition",
    "Replace a target with one case assuming P and one case assuming not P.",
    [slot("target", "target-conclusion", "proposition")],
    "p",
    [
      parameter("proposition", "Case proposition", "menu"),
      parameter("childIds", "Case target IDs", "generated-id"),
      parameter("branchHypothesisIds", "Case hypothesis IDs", "generated-id"),
    ],
    [
      "Prove r separately under p and under not p.",
      "Split an obligation on whether a selected condition holds.",
    ],
    "The case proposition mentions a symbol outside the target's context.",
  ),
  catalogEntry(
    "assume-hypothesis",
    "Assume hypothesis",
    "Add an unproved local hypothesis; the result no longer establishes the original target.",
    [slot("target", "target-conclusion", "proposition")],
    "p",
    [
      parameter("proposition", "Assumed proposition", "menu"),
      parameter("hypothesisId", "Assumed hypothesis ID", "generated-id"),
    ],
    [
      "Explore goal r after additionally assuming p.",
      "Assume a missing condition in an obligation to see what else it needs.",
    ],
    "The assumed expression is a term rather than a proposition.",
  ),
  catalogEntry(
    "replace-goal",
    "Replace goal",
    "Replace the conclusion with another proposition; the result no longer establishes the original target.",
    [slot("target", "target-conclusion", "proposition")],
    "p",
    [parameter("proposition", "Replacement conclusion", "menu")],
    [
      "Explore an easier goal p in place of p and q.",
      "Replace an obligation's conclusion with a special case.",
    ],
    "The replacement proposition is the current conclusion.",
  ),
  catalogEntry(
    "suffices",
    "Suffices to show",
    "Replace goal G with P and add an obligation P implies G in the same context.",
    [slot("target", "target-conclusion", "proposition")],
    "p",
    [
      parameter("proposition", "Sufficient proposition", "menu"),
      parameter("obligationId", "Sufficiency obligation ID", "generated-id"),
    ],
    [
      "Prove q by proving p and q, with obligation p and q implies q.",
      "Reduce an obligation to a stronger intermediate claim.",
    ],
    "The sufficient proposition uses a symbol that is not declared in the target's context.",
  ),
  catalogEntry(
    "drop-hypothesis",
    "Drop hypothesis",
    "Remove one local hypothesis; proving the result still proves the original target.",
    // The hypothesis selection anchors its target, so no separate target slot is
    // needed; one would also match every target-plus-hypothesis selection query.
    [slot("dropped", "hypothesis", "proposition")],
    "p",
    [parameter("hypothesisId", "Dropped hypothesis", "selection")],
    [
      "Remove an irrelevant hypothesis p before proving r.",
      "Discard a hypothesis from an obligation to state a more general claim.",
    ],
    "The selected hypothesis belongs to another target's context.",
  ),
  catalogEntry(
    "apply-implication-hypothesis",
    "Apply implication",
    "Add an implication consequent when its exact antecedent is locally available.",
    [
      slot("target", "target-conclusion", "proposition"),
      slot("implication", "hypothesis", "proposition"),
      slot("antecedent", "antecedent-fact", "proposition"),
    ],
    ["Implies", "p", "q"],
    [parameter("resultHypothesisId", "Consequent hypothesis ID", "generated-id")],
    [
      "Derive q from p implies q and p.",
      "Apply a local implication while retaining both source hypotheses.",
    ],
    "The available fact does not exactly match the implication antecedent.",
  ),
  catalogEntry(
    "introduce-universal",
    "Introduce universal",
    "Open a universal target at a fresh local universal parameter.",
    [slot("target", "target-conclusion", "proposition")],
    ["ForAll", "x", "p"],
    [],
    [
      "Prove every x has P by taking arbitrary x.",
      "Open a universally quantified obligation whose parameter is fresh for assumptions.",
    ],
    "The bound parameter occurs freely in a local hypothesis.",
  ),
  catalogEntry(
    "instantiate-universal-hypothesis",
    "Instantiate universal hypothesis",
    "Add one capture-safe instance of a universal local fact.",
    [
      slot("target", "target-conclusion", "proposition"),
      slot("universal", "hypothesis", "proposition"),
      slot("term", "witness", "term"),
    ],
    ["ForAll", "x", "p"],
    [
      parameter("term", "Instantiation term", "term-input"),
      parameter("resultHypothesisId", "Instance hypothesis ID", "generated-id"),
    ],
    [
      "Instantiate every x has P at a selected term t.",
      "Retain the universal fact while adding its concrete instance.",
    ],
    "The selected hypothesis is not universal or the term is ill-typed.",
  ),
  catalogEntry(
    "choose-existential-witness",
    "Choose existential witness",
    "Strengthen an existential target to its body at one chosen witness.",
    [slot("target", "target-conclusion", "proposition"), slot("witness", "witness", "term")],
    ["Exists", "x", "p"],
    [parameter("witness", "Witness term", "term-input")],
    [
      "Prove there exists x with P by choosing t.",
      "Provide a concrete witness for an existential obligation.",
    ],
    "The chosen witness makes the instantiated body ill-typed.",
  ),
  catalogEntry(
    "unpack-existential-hypothesis",
    "Unpack existential hypothesis",
    "Expose an existential fact at a fresh local witness.",
    [
      slot("target", "target-conclusion", "proposition"),
      slot("existential", "hypothesis", "proposition"),
    ],
    ["Exists", "x", "p"],
    [parameter("resultHypothesisId", "Witness hypothesis ID", "generated-id")],
    [
      "Use some x with P as a fresh local witness.",
      "Replace an existential hypothesis with its body at an isolated witness.",
    ],
    "The witness symbol already occurs freely elsewhere in the sequent.",
  ),
  catalogEntry(
    "rewrite-with-equality",
    "Rewrite with equality",
    "Replace one exact occurrence using a local binary equality.",
    [
      slot("target", "target-conclusion", "any"),
      slot("equality", "equality", "proposition"),
      slot("occurrence", "rewrite-occurrence", "term"),
    ],
    ["Equal", "x", "y"],
    [
      parameter("statement", "Statement", "selection"),
      parameter("path", "Operand path", "selection"),
      parameter("direction", "Direction", "menu"),
    ],
    [
      "Rewrite one occurrence of x to y from x equals y.",
      "Rewrite inside another hypothesis while retaining the equality.",
    ],
    "The replacement would capture a free symbol under a binder.",
  ),
  catalogEntry(
    "rewrite-with-equivalence",
    "Rewrite with equivalence",
    "Replace one proposition occurrence at any position using a local or approved A iff B.",
    [
      slot("target", "target-conclusion", "any"),
      // Optional: the source may instead be an approved result chosen from the menu.
      slot("equivalence", "hypothesis", "proposition", false),
      slot("occurrence", "rewrite-occurrence", "proposition"),
    ],
    ["Equivalent", "p", "q"],
    [
      parameter("statement", "Statement", "selection"),
      parameter("path", "Occurrence", "selection"),
      parameter("source", "Equivalence source", "menu"),
      parameter("direction", "Direction", "menu"),
    ],
    [
      "Rewrite p to q under a negation from p iff q.",
      "Rewrite a double negation inside a hypothesis with an approved equivalence.",
    ],
    "The selected occurrence is not alpha-equivalent to the chosen side.",
  ),
  catalogEntry(
    "rewrite-with-implication",
    "Rewrite with implication",
    "Strengthen by replacing B with A at a positive position, or A with B at a negative position, using A implies B.",
    [
      slot("target", "target-conclusion", "any"),
      // Optional: the source may instead be an approved result chosen from the menu.
      slot("implication", "hypothesis", "proposition", false),
      slot("occurrence", "rewrite-occurrence", "proposition"),
    ],
    ["Implies", "p", "q"],
    [
      parameter("statement", "Statement", "selection"),
      parameter("path", "Occurrence", "selection"),
      parameter("source", "Implication source", "menu"),
    ],
    [
      "Reduce goal q or r to p or r using p implies q.",
      "Weaken an assumption p and r to q and r, making the goal harder.",
    ],
    "The occurrence is an operand of an equivalence, where polarity is mixed.",
  ),
  catalogEntry(
    "generalized-rewrite",
    "Rewrite expression",
    "Rewrite a selected occurrence using a relation from the local context or approved library.",
    [
      slot("occurrence", "rewrite-occurrence", "any"),
      slot("source", "hypothesis", "proposition", false),
    ],
    "x",
    [],
    [
      "Replace one side of an equality in a selected expression.",
      "Strengthen an inequality by rewriting in an order-preserving position.",
    ],
    "The selected occurrence has no rewrite supported by the source relation.",
  ),
  catalogEntry(
    "apply-result-backward",
    "Apply result backward",
    "Reduce a target matching an approved result's conclusion to that result's instantiated premises.",
    [slot("target", "target-conclusion", "proposition")],
    "p",
    [
      parameter("resultId", "Result", "menu"),
      parameter("instantiation", "Instantiation", "menu"),
      parameter("premiseTargetIds", "Premise target IDs", "generated-id"),
    ],
    [
      "Prove x < z from transitivity by proving x < y and y < z.",
      "Close an obligation that is an instance of a premise-free approved result.",
    ],
    "The instantiated conclusion differs from the target conclusion.",
  ),
  catalogEntry(
    "apply-result-forward",
    "Apply result forward",
    "Derive an approved result's instantiated conclusion from local facts; unmet premises become obligations.",
    [slot("target", "target-conclusion", "proposition")],
    "p",
    [
      parameter("resultId", "Result", "menu"),
      parameter("instantiation", "Instantiation", "menu"),
      parameter("premiseHypothesisIds", "Premise hypotheses", "selection"),
      parameter("resultHypothesisId", "Derived hypothesis ID", "generated-id"),
      parameter("obligationIds", "Premise obligation IDs", "generated-id"),
    ],
    [
      "Derive q by modus ponens from local facts p implies q and p.",
      "Derive a conclusion now and leave its missing premise as an obligation.",
    ],
    "A selected hypothesis does not match the instantiated premise.",
  ),
  catalogEntry(
    "mark-sorry",
    "Mark as sorry",
    "Set a target aside as an explicit sorry: remove it and assume its universal closure over the variables and hypotheses it depends on.",
    [slot("target", "target-conclusion", "proposition")],
    "p",
    [parameter("assumptionId", "Sorry assumption ID", "generated-id")],
    [
      "Defer goal x < z under x < y and y < z as the assumption for all x y z, x < y and y < z implies x < z.",
      "Postpone a side-condition obligation to continue with the main argument.",
    ],
    "The target depends on an unresolved construction metavariable.",
  ),
  catalogEntry(
    "close-by-assumption",
    "Close by assumption",
    "Close a target by an instance of an additional assumption whose antecedents are all local hypotheses.",
    [slot("target", "target-conclusion", "proposition")],
    "p",
    [
      parameter("assumptionId", "Additional assumption", "menu"),
      parameter("instantiation", "Instantiation", "menu"),
    ],
    [
      "Close u < s under u < t and t < s from a sorry assumed for all x y z.",
      "Discharge an obligation that is an instance of an earlier sorry.",
    ],
    "An antecedent of the instantiated assumption is missing from the local context.",
  ),
];

export const constructionCatalogInputs: readonly MoveCatalogInput[] = [
  catalogEntry(
    "introduce-placeholder",
    "Construct an object",
    "Replace the witness of an existential target by a placeholder for the object to construct; its requirements and candidates are recorded on a construction task.",
    [slot("target", "target-conclusion", "proposition")],
    ["Exists", "x", "p"],
    [
      parameter("taskId", "Construction task ID", "generated-id"),
      parameter("symbol", "Placeholder symbol", "generated-id"),
      parameter("dependencies", "What the object may depend on", "menu"),
    ],
    [
      "Construct a delta for an existential goal, allowed to depend on epsilon.",
      "Construct a witness for a typed existential obligation, keeping its membership in the goal.",
    ],
    "The selected conclusion is not existential.",
  ),
  catalogEntry(
    "add-requirement",
    "Add requirement",
    "Record a requirement an open construction must meet, taken from a statement of the proof state. It never becomes a hypothesis.",
    [slot("target", "target-conclusion", "proposition")],
    "p",
    [
      parameter("taskId", "Construction", "menu"),
      parameter("requirement", "Requirement", "menu"),
      parameter("requirementId", "Requirement ID", "generated-id"),
      parameter("attemptId", "Attempt ID", "generated-id"),
    ],
    [
      "Record that the goal's own condition on the placeholder is sufficient.",
      "Record a hypothesis mentioning the placeholder as a heuristic hint.",
    ],
    "No statement of the proof state mentions the open placeholder.",
  ),
  catalogEntry(
    "add-candidate",
    "Add candidate",
    "Record a candidate object for an open construction, chosen from the terms the construction may depend on.",
    [slot("target", "target-conclusion", "proposition")],
    "p",
    [
      parameter("taskId", "Construction", "menu"),
      parameter("value", "Candidate", "menu"),
      parameter("candidateId", "Candidate ID", "generated-id"),
      parameter("attemptId", "Attempt ID", "generated-id"),
    ],
    [
      "Offer epsilon as a candidate for delta when delta may depend on epsilon.",
      "Offer a subterm of the goal as a candidate.",
    ],
    "A term that uses a variable outside the construction's allowed dependencies is not offered.",
  ),
  catalogEntry(
    "resolve-placeholder",
    "Use this candidate",
    "Resolve an open construction with one of its candidates: the choice is substituted into every dependent statement and the remaining sufficient requirements become obligations.",
    [slot("target", "target-conclusion", "proposition")],
    "p",
    [
      parameter("taskId", "Construction", "menu"),
      parameter("candidateId", "Candidate", "menu"),
      parameter("obligationIds", "Obligation IDs", "generated-id"),
      parameter("attemptId", "Attempt ID", "generated-id"),
    ],
    [
      "Resolve delta with the candidate epsilon, leaving its goal to prove.",
      "Resolve a construction whose sufficient requirement was attested, which becomes an obligation.",
    ],
    "The construction has no candidate to use.",
  ),
  catalogEntry(
    "abandon-placeholder",
    "Abandon construction",
    "Give up an open construction whose placeholder no longer occurs in the proof state; the record is kept as history.",
    [slot("target", "target-conclusion", "proposition")],
    "p",
    [
      parameter("taskId", "Construction", "menu"),
      parameter("attemptId", "Attempt ID", "generated-id"),
    ],
    [
      "Abandon an auxiliary construction nothing uses.",
      "Abandon a construction after backtracking removed its placeholder.",
    ],
    "The placeholder still occurs in the proof state.",
  ),
];

function catalogEntry(
  operationKind: MoveOperationKind,
  name: string,
  description: string,
  slots: readonly MoveSelectionSlot[],
  pattern: PlainMathJson,
  parameters: readonly MoveParameter[],
  positive: readonly [string, string],
  negative: string,
  extraPatterns?: MoveCatalogInput["extraPatterns"],
): MoveCatalogInput {
  return {
    suffix: operationKind,
    name,
    description,
    operationKind,
    slots,
    pattern,
    parameters,
    positive,
    negative,
    ...(extraPatterns === undefined ? {} : { extraPatterns }),
  };
}

function slot(
  id: string,
  role: MoveSelectionSlot["role"],
  semanticRole: MoveSelectionSlot["semanticRole"],
  required = true,
): MoveSelectionSlot {
  return { id, role, semanticRole, required };
}

function parameter(id: string, label: string, source: MoveParameter["source"]): MoveParameter {
  return { id, label, source };
}
