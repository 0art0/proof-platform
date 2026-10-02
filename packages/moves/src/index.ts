import {
  KERNEL_OPERATION_KINDS,
  applyTransition,
  KERNEL_TRANSITION_CLASSES,
  declaredTransitionClass,
  kernelOperationSchema,
  type KernelEnvironment,
  type KernelOperation,
  type KernelOperationKind,
  type TransitionClass,
  type TransitionEvidence,
} from "@proof/kernel";
import {
  libraryApprovalSchema,
  libraryArtifactReferenceSchema,
  libraryProvenanceSchema,
  type LibraryArtifactReference,
} from "@proof/library";
import {
  plainMathJsonSchema,
  stableIdentifierSchema,
  type ExecutableProofState,
  type PlainMathJson,
} from "@proof/mathjson-model";
import { z } from "zod";

export const moveIdSchema = stableIdentifierSchema.brand("MoveId");
export type MoveId = z.infer<typeof moveIdSchema>;

export const moveSelectionSlotSchema = z
  .object({
    id: stableIdentifierSchema,
    role: z.enum([
      "target-conclusion",
      "hypothesis",
      "antecedent-fact",
      "equality",
      "rewrite-occurrence",
      "witness",
    ]),
    semanticRole: z.enum(["proposition", "term", "binder", "any"]),
    required: z.boolean(),
  })
  .strict();
export type MoveSelectionSlot = z.infer<typeof moveSelectionSlotSchema>;

export const moveParameterSchema = z
  .object({
    id: stableIdentifierSchema,
    label: z.string().min(1),
    source: z.enum(["generated-id", "menu", "selection", "term-input"]),
  })
  .strict();
export type MoveParameter = z.infer<typeof moveParameterSchema>;

export const movePatternSchema = z
  .object({
    id: stableIdentifierSchema,
    selectionSlotId: stableIdentifierSchema,
    expression: plainMathJsonSchema,
  })
  .strict();
export type MovePattern = z.infer<typeof movePatternSchema>;

export const moveImplementationSchema = z
  .object({
    kind: z.literal("deterministic-kernel-primitive"),
    operationKind: z.enum(KERNEL_OPERATION_KINDS),
  })
  .strict();
export type MoveImplementation = z.infer<typeof moveImplementationSchema>;

export const moveDefinitionSchema = guardedSchema(
  z
    .object({
      id: moveIdSchema,
      name: z.string().min(1),
      description: z.string().min(1),
      selectionContract: z
        .object({ slots: z.array(moveSelectionSlotSchema), allowAdditional: z.literal(false) })
        .strict(),
      patterns: z.array(movePatternSchema).min(1),
      contextRequirements: z.array(z.string().min(1)),
      sideConditions: z.array(z.string().min(1)),
      parameters: z.array(moveParameterSchema),
      requiredArtifacts: z.array(libraryArtifactReferenceSchema),
      implementation: moveImplementationSchema,
      transitionClass: z.enum(["equivalence", "strengthening", "weakening"]),
      previewRenderer: z.literal("kernel-state-delta"),
      examples: z
        .object({
          positive: z.array(z.string().min(1)).min(2),
          negative: z.array(z.string().min(1)).min(1),
        })
        .strict(),
      provenance: libraryProvenanceSchema,
      approval: libraryApprovalSchema,
      discoveryContext: z.string().min(1).optional(),
    })
    .strict()
    .superRefine((move, context) => {
      addUniqueFieldIssues(move.selectionContract.slots, "id", "selection slot", context, [
        "selectionContract",
        "slots",
      ]);
      addUniqueFieldIssues(move.patterns, "id", "move pattern", context, ["patterns"]);
      const slotIds = new Set(move.selectionContract.slots.map((slot) => slot.id));
      move.patterns.forEach((pattern, index) => {
        if (!slotIds.has(pattern.selectionSlotId)) {
          context.addIssue({
            code: "custom",
            message: "Every move pattern must identify one declared selection slot.",
            path: ["patterns", index, "selectionSlotId"],
          });
        }
      });
      addUniqueFieldIssues(move.parameters, "id", "move parameter", context, ["parameters"]);
      addUniqueArtifactIssues(move.requiredArtifacts, context);
      move.requiredArtifacts.forEach((reference, index) => {
        if (reference.kind !== "definition" && reference.kind !== "result") {
          context.addIssue({
            code: "custom",
            message: "Moves may require only mathematical definitions or results.",
            path: ["requiredArtifacts", index, "kind"],
          });
        }
      });
      if (move.transitionClass !== declaredTransitionClass(move.implementation.operationKind)) {
        context.addIssue({
          code: "custom",
          message: "The declared transition class must match the deterministic primitive.",
          path: ["transitionClass"],
        });
      }
    }),
);
export type MoveDefinition = z.infer<typeof moveDefinitionSchema>;

/**
 * The classes each primitive's kernel transition may report (the kernel's own table). A move
 * declares `declaredTransitionClass(kind)`, the weakest of them; the stored preview and edge carry
 * the class the kernel reported for the actual outcome, which must be in this set.
 */
export const PRIMITIVE_TRANSITION_CLASSES: Readonly<
  Record<KernelOperationKind, readonly TransitionClass[]>
> = KERNEL_TRANSITION_CLASSES;

export const PRIMITIVE_PATTERN_SLOTS: Readonly<Record<KernelOperationKind, string>> = Object.freeze(
  {
    "close-by-hypothesis": "target",
    "close-true": "target",
    "close-false-hypothesis": "false",
    "close-reflexive-equality": "target",
    "close-by-contradiction": "negation",
    "close-by-accepted-inference": "target",
    "introduce-implication": "target",
    "introduce-negation": "target",
    "split-goal-conjunction": "target",
    "choose-goal-disjunct": "target",
    "expand-hypothesis-conjunction": "conjunction",
    "split-hypothesis-disjunction": "disjunction",
    "split-classical-cases": "target",
    "assume-hypothesis": "target",
    "replace-goal": "target",
    suffices: "target",
    "drop-hypothesis": "dropped",
    "apply-implication-hypothesis": "implication",
    "introduce-universal": "target",
    "instantiate-universal-hypothesis": "universal",
    "choose-existential-witness": "target",
    "unpack-existential-hypothesis": "existential",
    "rewrite-with-equality": "equality",
    "rewrite-with-equivalence": "equivalence",
    "rewrite-with-implication": "implication",
    "apply-result-backward": "target",
    "apply-result-forward": "target",
    "mark-sorry": "target",
    "close-by-assumption": "target",
  },
);

/**
 * Evidence each primitive's kernel transition may report. An accepted
 * inference rests on an external attestation and a result application on an
 * approved library result; every other primitive is structurally checked by
 * the kernel. The deep rewrites take their `Equivalent`/`Implies` statement
 * either from a local hypothesis (structural) or from an instantiated approved
 * result (library-result), so their entry lists both; the kernel reports the
 * one its operation's `source` determines. A set per kind keeps one move per
 * kernel rule rather than splitting each rewrite into source-specific kinds
 * with duplicated operations and moves. `mark-sorry` records an unproved
 * closure as an additional assumption (sorry); `close-by-assumption` is
 * structurally checked against that explicit assumption. The record is
 * exhaustive so a new primitive must choose its evidence explicitly.
 */
export const PRIMITIVE_TRANSITION_EVIDENCE: Readonly<
  Record<KernelOperationKind, readonly TransitionEvidence[]>
> = deepFreeze({
  "close-by-hypothesis": ["structural"],
  "close-true": ["structural"],
  "close-false-hypothesis": ["structural"],
  "close-reflexive-equality": ["structural"],
  "close-by-contradiction": ["structural"],
  "close-by-accepted-inference": ["background-inference"],
  "introduce-implication": ["structural"],
  "introduce-negation": ["structural"],
  "split-goal-conjunction": ["structural"],
  "choose-goal-disjunct": ["structural"],
  "expand-hypothesis-conjunction": ["structural"],
  "split-hypothesis-disjunction": ["structural"],
  "split-classical-cases": ["structural"],
  "assume-hypothesis": ["structural"],
  "replace-goal": ["structural"],
  suffices: ["structural"],
  "drop-hypothesis": ["structural"],
  "apply-implication-hypothesis": ["structural"],
  "introduce-universal": ["structural"],
  "instantiate-universal-hypothesis": ["structural"],
  "choose-existential-witness": ["structural"],
  "unpack-existential-hypothesis": ["structural"],
  "rewrite-with-equality": ["structural"],
  "rewrite-with-equivalence": ["structural", "library-result"],
  "rewrite-with-implication": ["structural", "library-result"],
  "apply-result-backward": ["library-result"],
  "apply-result-forward": ["library-result"],
  "mark-sorry": ["sorry"],
  "close-by-assumption": ["structural"],
});

type MoveCatalogInput = Readonly<{
  suffix: string;
  name: string;
  description: string;
  operationKind: KernelOperationKind;
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

const catalogInputs: readonly MoveCatalogInput[] = [
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

/** All trusted primitives have visible, inspectable move metadata; the catalog cannot mutate state. */
export const HAND_AUTHORED_MOVES: readonly MoveDefinition[] = deepFreeze(
  catalogInputs.map((input) =>
    moveDefinitionSchema.parse({
      id: `move:${input.suffix}`,
      name: input.name,
      description: input.description,
      selectionContract: { slots: input.slots, allowAdditional: false },
      patterns: [
        {
          id: `move-pattern:${input.suffix}`,
          selectionSlotId: PRIMITIVE_PATTERN_SLOTS[input.operationKind],
          expression: input.pattern,
        },
        ...(input.extraPatterns ?? []).map(({ slotId, pattern }) => ({
          id: `move-pattern:${input.suffix}-${slotId}`,
          selectionSlotId: slotId,
          expression: pattern,
        })),
      ],
      contextRequirements: ["All selected statements belong to the target contextual sequent."],
      sideConditions: ["The kernel must validate the complete primitive operation."],
      parameters: input.parameters,
      requiredArtifacts: [],
      implementation: {
        kind: "deterministic-kernel-primitive",
        operationKind: input.operationKind,
      },
      transitionClass: declaredTransitionClass(input.operationKind),
      previewRenderer: "kernel-state-delta",
      examples: { positive: input.positive, negative: [input.negative] },
      provenance: { kind: "curated", source: "proof-platform Stage 2 move pack" },
      approval: { status: "approved", reviewerId: "reviewer:core-moves" },
    }),
  ),
);

const moveById: ReadonlyMap<string, MoveDefinition> = new Map(
  HAND_AUTHORED_MOVES.map((move) => [move.id, move]),
);

/**
 * The kernel environment plus the approved moves beyond the hand-authored catalog (authored moves,
 * N35). A hand-authored move ID is never shadowed.
 */
export type PlanMoveEnvironment = KernelEnvironment &
  Readonly<{ moves?: readonly MoveDefinition[] }>;

export type MovePlanDiagnosticCode =
  | "invalid-request"
  | "move-not-found"
  | "operation-kind-mismatch"
  | "kernel-rejected"
  | "invalid-move-definition";

export type MovePlanDiagnostic = Readonly<{
  code: MovePlanDiagnosticCode;
  message: string;
}>;

export type MovePlanResult =
  | Readonly<{
      ok: true;
      move: MoveDefinition;
      operation: KernelOperation;
      preview: Readonly<{
        state: ExecutableProofState;
        transitionClass: TransitionClass;
        evidence: TransitionEvidence;
      }>;
      diagnostics: readonly [];
    }>
  | Readonly<{ ok: false; diagnostics: readonly [MovePlanDiagnostic] }>;

/** Validate one move request and produce a detached preview through the trusted kernel. */
export function planMove(
  stateInput: unknown,
  requestInput: unknown,
  environment: PlanMoveEnvironment = {},
): MovePlanResult {
  try {
    if (!isStrictRecord(requestInput) || !hasExactKeys(requestInput, ["moveId", "operation"])) {
      return moveFailure(
        "invalid-request",
        "A move request must contain only moveId and operation.",
      );
    }
    const moveId = moveIdSchema.safeParse(requestInput.moveId);
    const operation = kernelOperationSchema.safeParse(requestInput.operation);
    if (!moveId.success || !operation.success) {
      return moveFailure("invalid-request", "The move ID or kernel operation is invalid.");
    }
    const move =
      moveById.get(moveId.data) ??
      environment.moves?.find((candidate) => candidate.id === moveId.data);
    if (move === undefined)
      return moveFailure("move-not-found", "The requested move is unavailable.");
    if (move.implementation.operationKind !== operation.data.kind) {
      return moveFailure(
        "operation-kind-mismatch",
        "The supplied primitive does not implement the requested move.",
      );
    }
    const kernelEnvironment: KernelEnvironment = { ...environment };
    delete (kernelEnvironment as { moves?: unknown }).moves;
    const transition = applyTransition(
      stateInput as ExecutableProofState,
      operation.data,
      kernelEnvironment,
    );
    if (!transition.ok) {
      const diagnostic = transition.diagnostics[0];
      return moveFailure(
        "kernel-rejected",
        diagnostic === undefined
          ? "The kernel rejected the move."
          : `The kernel rejected the move: ${diagnostic.code}.`,
      );
    }
    if (
      !PRIMITIVE_TRANSITION_CLASSES[move.implementation.operationKind].includes(
        transition.transitionClass,
      ) ||
      !PRIMITIVE_TRANSITION_EVIDENCE[move.implementation.operationKind].includes(
        transition.evidence,
      )
    ) {
      return moveFailure(
        "invalid-move-definition",
        "The kernel transition class or evidence contradicts the move definition.",
      );
    }
    const detached = freezeDetached({
      ok: true as const,
      move,
      operation: operation.data,
      preview: {
        state: transition.state,
        transitionClass: transition.transitionClass,
        evidence: transition.evidence,
      },
      diagnostics: [] as const,
    });
    return (
      detached ?? moveFailure("invalid-request", "The move preview could not be detached safely.")
    );
  } catch {
    return moveFailure("invalid-request", "The move boundary could not inspect its input safely.");
  }
}

function catalogEntry(
  operationKind: KernelOperationKind,
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
  return moveSelectionSlotSchema.parse({ id, role, semanticRole, required });
}

function parameter(id: string, label: string, source: MoveParameter["source"]): MoveParameter {
  return moveParameterSchema.parse({ id, label, source });
}

function addUniqueFieldIssues<Entry extends Readonly<Record<Field, string>>, Field extends string>(
  values: readonly Entry[],
  field: Field,
  label: string,
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value[field])) {
      context.addIssue({
        code: "custom",
        message: `Each ${label} ID must be unique.`,
        path: [...path, index, field],
      });
    }
    seen.add(value[field]);
  });
}

function addUniqueArtifactIssues(
  references: readonly LibraryArtifactReference[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  references.forEach((reference, index) => {
    const key = `${reference.kind}\u0000${reference.id}`;
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        message: "Required artifact references must be unique.",
        path: ["requiredArtifacts", index],
      });
    }
    seen.add(key);
  });
}

function guardedSchema<Output>(schema: z.ZodType<Output>): z.ZodType<Output> {
  return z.unknown().transform((value, context) => {
    if (!isJsonData(value)) {
      context.addIssue({ code: "custom", message: "Move definitions must be plain JSON data." });
      return z.NEVER;
    }
    const parsed = schema.safeParse(structuredClone(value));
    if (parsed.success) return parsed.data;
    parsed.error.issues.forEach((issue) =>
      context.addIssue({ code: "custom", message: issue.message, path: issue.path }),
    );
    return z.NEVER;
  });
}

function moveFailure(code: MovePlanDiagnosticCode, message: string): MovePlanResult {
  return { ok: false, diagnostics: [{ code, message }] };
}

function isStrictRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => descriptor.enumerable && "value" in descriptor,
  );
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) return false;
  const sorted = (actual as string[]).sort();
  const expected = [...keys].sort();
  return sorted.length === expected.length && sorted.every((key, index) => key === expected[index]);
}

function isJsonData(value: unknown, ancestors: ReadonlySet<object> = new Set()): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return true;
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    if (keys.length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        !isJsonData(descriptor.value, nextAncestors)
      )
        return false;
    }
    return keys.every(
      (key) =>
        key === "length" ||
        (typeof key === "string" &&
          Number.isInteger(Number(key)) &&
          Number(key) >= 0 &&
          Number(key) < value.length),
    );
  }
  return keys.every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = descriptors[key];
    return (
      descriptor !== undefined &&
      descriptor.enumerable &&
      "value" in descriptor &&
      isJsonData(descriptor.value, nextAncestors)
    );
  });
}

function freezeDetached<Value>(value: Value): Value | undefined {
  try {
    return deepFreeze(structuredClone(value) as Value);
  } catch {
    return undefined;
  }
}

function deepFreeze<Value>(value: Value, seen: WeakSet<object> = new WeakSet()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  Reflect.ownKeys(value).forEach((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value, seen);
  });
  return Object.freeze(value);
}

export * from "./result-adapter";
export * from "./materialize";
export * from "./plan";
export { declaredTransitionClass };
