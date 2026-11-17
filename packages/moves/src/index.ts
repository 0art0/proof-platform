import {
  CONSTRUCTION_OPERATION_KINDS,
  CONSTRUCTION_TRANSITION_CLASSES,
  KERNEL_OPERATION_KINDS,
  applyTransition,
  KERNEL_TRANSITION_CLASSES,
  declaredTransitionClass,
  hasExactKeys,
  isStrictRecord,
  kernelOperationSchema,
  type ConstructionOperationKind,
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
  deepFreeze,
  plainMathJsonSchema,
  stableIdentifierSchema,
  type ExecutableProofState,
} from "@proof/mathjson-model";
import { z } from "zod";
import { catalogInputs, constructionCatalogInputs, type MoveCatalogInput } from "./catalog";

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

/**
 * What a move can implement: a kernel primitive or a construction-task operation (N11, N42).
 * Construction moves live in `CONSTRUCTION_MOVES`, apart from the `HAND_AUTHORED_MOVES` that
 * retrieval ranks, because they are reached from a construction task rather than from a pattern.
 */
export const MOVE_OPERATION_KINDS = [
  ...KERNEL_OPERATION_KINDS,
  ...CONSTRUCTION_OPERATION_KINDS,
] as const;
export type MoveOperationKind = KernelOperationKind | ConstructionOperationKind;

export const moveImplementationSchema = z
  .object({
    kind: z.literal("deterministic-kernel-primitive"),
    operationKind: z.enum(MOVE_OPERATION_KINDS),
  })
  .strict();
export type MoveImplementation = z.infer<typeof moveImplementationSchema>;

/**
 * Primitive parameters whose value a reviewed template may CONSTRUCT instead of the user picking
 * it from a menu: a proposition or a term. Every other parameter is a selection, a generated ID,
 * or a closed menu (an index, a direction, a result), and stays a menu choice.
 */
const CONSTRUCTIBLE_PARAMETERS: Readonly<
  Partial<Record<MoveOperationKind, Readonly<Record<string, "term" | "proposition">>>>
> = Object.freeze({
  "split-classical-cases": { proposition: "proposition" },
  "assume-hypothesis": { proposition: "proposition" },
  "replace-goal": { proposition: "proposition" },
  suffices: { proposition: "proposition" },
  "instantiate-universal-hypothesis": { term: "term" },
  "choose-existential-witness": { witness: "term" },
});

/** The prefix of the menus that complete a result's or assumption's instantiation. */
export const INSTANTIATION_PARAMETER_PREFIX = "instantiation/";

/**
 * What a construction for this parameter of this primitive may be, or undefined when the parameter
 * cannot be constructed. The instantiation of a result or additional assumption is a term.
 */
export function constructibleParameterKind(
  operationKind: MoveOperationKind,
  parameterId: string,
): "term" | "proposition" | undefined {
  if (
    (operationKind === "apply-result-backward" ||
      operationKind === "apply-result-forward" ||
      operationKind === "close-by-assumption") &&
    parameterId.startsWith(INSTANTIATION_PARAMETER_PREFIX) &&
    parameterId.length > INSTANTIATION_PARAMETER_PREFIX.length
  ) {
    return "term";
  }
  return CONSTRUCTIBLE_PARAMETERS[operationKind]?.[parameterId];
}

/**
 * A constructed parameter (reviewed template language, refinement section 7.2): the value is a
 * MathJSON template over the move's pattern metavariables. When the move is applied, the
 * metavariables are bound by matching the selections against the move's patterns, the template is
 * instantiated by capture-avoiding substitution, and the result is offered as one more item of the
 * parameter's menu, already chosen. The menu's own typing check and the kernel still validate it.
 */
export const moveConstructionSchema = z
  .object({
    parameterId: stableIdentifierSchema,
    kind: z.enum(["term", "proposition"]),
    template: plainMathJsonSchema,
  })
  .strict();
export type MoveConstruction = z.infer<typeof moveConstructionSchema>;

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
      /** Parameters this move constructs from its pattern metavariables (see above). */
      constructions: z.array(moveConstructionSchema).max(8).optional(),
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
      const constructions = move.constructions ?? [];
      addUniqueFieldIssues(constructions, "parameterId", "construction", context, [
        "constructions",
      ]);
      constructions.forEach((construction, index) => {
        const kind = constructibleParameterKind(
          move.implementation.operationKind,
          construction.parameterId,
        );
        if (kind !== construction.kind) {
          context.addIssue({
            code: "custom",
            message:
              kind === undefined
                ? `The ${move.implementation.operationKind} primitive has no constructible parameter ${construction.parameterId}.`
                : `The parameter ${construction.parameterId} is constructed as a ${kind}, not a ${construction.kind}.`,
            path: ["constructions", index, "parameterId"],
          });
        }
        if (move.parameters.some(({ id }) => id === construction.parameterId)) {
          context.addIssue({
            code: "custom",
            message: `The constructed parameter ${construction.parameterId} is not asked of the user.`,
            path: ["constructions", index, "parameterId"],
          });
        }
      });
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
  Record<MoveOperationKind, readonly TransitionClass[]>
> = Object.freeze({ ...KERNEL_TRANSITION_CLASSES, ...CONSTRUCTION_TRANSITION_CLASSES });

export const PRIMITIVE_PATTERN_SLOTS: Readonly<Record<MoveOperationKind, string>> = Object.freeze({
  "introduce-placeholder": "target",
  "add-requirement": "target",
  "add-candidate": "target",
  "resolve-placeholder": "target",
  "abandon-placeholder": "target",
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
});

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
  Record<MoveOperationKind, readonly TransitionEvidence[]>
> = deepFreeze({
  "introduce-placeholder": ["structural"],
  "add-requirement": ["structural"],
  "add-candidate": ["structural"],
  "resolve-placeholder": ["structural"],
  "abandon-placeholder": ["structural"],
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

function buildMoves(inputs: readonly MoveCatalogInput[]): readonly MoveDefinition[] {
  return deepFreeze(
    inputs.map((input) =>
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
}

/** All trusted primitives have visible, inspectable move metadata; the catalog cannot mutate state. */
export const HAND_AUTHORED_MOVES: readonly MoveDefinition[] = buildMoves(catalogInputs);

/**
 * Moves over the construction-task operations (N42). Their parameters are all menus or generated
 * IDs, so no mathematics is typed. They are not retrieved by pattern: the construction view
 * invokes them for an open task.
 */
export const CONSTRUCTION_MOVES: readonly MoveDefinition[] = buildMoves(constructionCatalogInputs);

const moveById: ReadonlyMap<string, MoveDefinition> = new Map(
  [...HAND_AUTHORED_MOVES, ...CONSTRUCTION_MOVES].map((move) => [move.id, move]),
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

export * from "./result-adapter";
export {
  bindPatterns,
  instantiateTemplate,
  metavariablesOf,
  type Instantiation,
  type MetavariableBindings,
  type PatternFragment,
} from "./construction";
export * from "./materialize";
export * from "./plan";
export { declaredTransitionClass };
