/**
 * Move authoring without AI (design plan §13.1, refinement §7; roadmap N35).
 *
 * An authored move template is data: a selection contract, patterns picked from selections,
 * parameters chosen from menus, required artifacts, a plan (a sequence of kernel primitives), the
 * declared transition class, and runnable examples. A template never adds mathematics of its own.
 * It only composes existing kernel operations, so every state it produces comes from
 * `applyTransition` through `materializeMoveOperation` and `planMove`.
 *
 * - The contract, patterns and parameters describe the FIRST plan step, which a user drives with
 *   selections and menu choices. Their slot and parameter IDs must be the primitive's own, so the
 *   one materializer reads them.
 * - Every later step is replayed from a recorded step (the N21 shape): each selection is found
 *   again on the state the previous step produced by matching its recorded fragment as a pattern,
 *   and each menu parameter is chosen again by its recorded value, then by its origin. The
 *   correspondence of pattern variables and statement IDs carries forward, so a macro recorded on
 *   one state adapts to an alpha-renamed one.
 * - `validateMoveTemplate` RUNS every example through that path and compares the kernel's result
 *   with the expected outcome. The declared class must equal the class composed from the kernel
 *   transitions of the steps, both statically and on every positive example.
 * - A single-step template projects to an ordinary `MoveDefinition` that retrieval, materialization
 *   and the command path already understand. A multi-step macro is NOT an ordinary definition (one
 *   command path edge carries one kernel operation): `authoredMacroDefinition` projects only its
 *   FIRST step, for retrieval, and callers apply the macro as a sequence of ordinary commands from
 *   `runMovePlan`'s operations.
 */
import {
  alphaEquivalent,
  KERNEL_OPERATION_KINDS,
  kernelOperationSchema,
  matchExpressionPattern,
  type KernelEnvironment,
  type KernelOperation,
  type KernelOperationKind,
  type TransitionClass,
} from "@proof/kernel";
import { libraryArtifactReferenceSchema } from "@proof/library";
import {
  CONSTRUCTION_REQUIREMENT_ROLES,
  binderShape,
  constructionRequirementEvidenceSchema,
  createExecutableProofStateSchema,
  plainMathJsonSchema,
  sortSchema,
  stableIdentifierSchema,
  statementIdSchema,
  substituteMathJson,
  type ExecutableProofState,
  type OperatorDeclaration,
  type PlainMathJson,
} from "@proof/mathjson-model";
import { z } from "zod";
import { expressionAtPath, functionParts } from "./context-terms";
import {
  HAND_AUTHORED_MOVES,
  declaredTransitionClass,
  moveDefinitionSchema,
  moveIdSchema,
  moveParameterSchema,
  movePatternSchema,
  moveSelectionSlotSchema,
  planMove,
  type MoveDefinition,
  type MoveId,
} from "./index";
import {
  commandIdGenerator,
  generateParameterMenus,
  materializeMoveOperation,
  type MenuItemOrigin,
  type MenuValue,
  type MoveSelectionInput,
  type MoveSelections,
  type ParameterMenu,
  type ParameterMenuItem,
} from "./materialize";
import { composeTransitionClasses, planMoveSequence } from "./plan";

/** Authored move IDs are namespaced so they can never collide with the hand-authored catalog. */
export const AUTHORED_MOVE_ID_PREFIX = "authored:";
export const MAX_PLAN_STEPS = 16;
const MAX_EXAMPLES = 32;
const MAX_CANDIDATE_ATTEMPTS = 24;

export const authoredMoveIdSchema = moveIdSchema.refine(
  (id) => id.startsWith(AUTHORED_MOVE_ID_PREFIX) && id.length > AUTHORED_MOVE_ID_PREFIX.length,
  `An authored move ID starts with ${AUTHORED_MOVE_ID_PREFIX}.`,
);

// --------------------------------------------------------------------------------------------
// Plan steps: the recorded (N21) shape
// --------------------------------------------------------------------------------------------

const operandPathSchema = z.array(z.number().int().nonnegative()).max(64);
const targetSchema = z
  .object({ kind: z.enum(["goal", "obligation"]), id: statementIdSchema })
  .strict();
const statementRoleSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("conclusion") }).strict(),
  z.object({ role: z.literal("hypothesis"), id: statementIdSchema }).strict(),
]);
const occurrenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), path: operandPathSchema }).strict(),
  z
    .object({
      kind: z.literal("associative"),
      containerPath: operandPathSchema,
      startOperand: z.number().int().nonnegative(),
      endOperand: z.number().int().nonnegative(),
    })
    .strict(),
]);
const variablesSchema = z
  .array(z.object({ symbol: z.string().min(1), sort: sortSchema }).strict())
  .max(256);

export const macroSelectionSchema = z
  .object({
    slotId: stableIdentifierSchema,
    target: targetSchema,
    statement: statementRoleSchema,
    occurrence: occurrenceSchema,
    fragment: plainMathJsonSchema,
    /** The fragment's free declared symbols: its pattern variables. */
    variables: variablesSchema,
  })
  .strict();
export type MacroSelection = z.infer<typeof macroSelectionSchema>;

const menuLabelStatementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("conclusion") }).strict(),
  z.object({ kind: z.literal("hypothesis"), id: statementIdSchema }).strict(),
]);
const rewriteSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hypothesis"), hypothesisId: statementIdSchema }).strict(),
  z
    .object({
      kind: z.literal("result"),
      resultId: stableIdentifierSchema,
      instantiation: z.record(z.string().min(1), plainMathJsonSchema),
    })
    .strict(),
]);
const menuValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("index"), index: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("term"), expression: plainMathJsonSchema }).strict(),
  z.object({ kind: z.literal("proposition"), expression: plainMathJsonSchema }).strict(),
  z.object({ kind: z.literal("direction"), direction: z.enum(["forward", "backward"]) }).strict(),
  z.object({ kind: z.literal("rewrite-source"), source: rewriteSourceSchema }).strict(),
  z.object({ kind: z.literal("result"), resultId: stableIdentifierSchema }).strict(),
  z.object({ kind: z.literal("assumption"), assumptionId: stableIdentifierSchema }).strict(),
  z.object({ kind: z.literal("attestation"), attestationId: stableIdentifierSchema }).strict(),
  z.object({ kind: z.literal("generated-ids"), ids: z.array(stableIdentifierSchema) }).strict(),
  z.object({ kind: z.literal("construction-task"), taskId: stableIdentifierSchema }).strict(),
  z
    .object({ kind: z.literal("construction-candidate"), candidateId: stableIdentifierSchema })
    .strict(),
  z
    .object({
      kind: z.literal("construction-requirement"),
      role: z.enum(CONSTRUCTION_REQUIREMENT_ROLES),
      expression: plainMathJsonSchema,
      evidence: constructionRequirementEvidenceSchema,
    })
    .strict(),
  z.object({ kind: z.literal("symbols"), symbols: z.array(z.string().min(1)) }).strict(),
]);
const menuOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("selection"), slotId: stableIdentifierSchema }).strict(),
  z.object({ kind: z.literal("declaration"), declarationId: stableIdentifierSchema }).strict(),
  z
    .object({
      kind: z.literal("subterm-of"),
      statement: menuLabelStatementSchema,
      path: z.array(z.number().int().nonnegative()),
    })
    .strict(),
  z.object({ kind: z.literal("conclusion") }).strict(),
  z.object({ kind: z.literal("hypothesis"), hypothesisId: statementIdSchema }).strict(),
  z.object({ kind: z.literal("assumption"), assumptionId: stableIdentifierSchema }).strict(),
  z.object({ kind: z.literal("result"), resultId: stableIdentifierSchema }).strict(),
  z.object({ kind: z.literal("attestation") }).strict(),
  z.object({ kind: z.literal("rule") }).strict(),
  z.object({ kind: z.literal("generated") }).strict(),
  z.object({ kind: z.literal("construction"), taskId: stableIdentifierSchema }).strict(),
]);

export const macroParameterSchema = z
  .object({
    parameterId: stableIdentifierSchema,
    origin: menuOriginSchema,
    value: menuValueSchema,
    variables: variablesSchema,
  })
  .strict();
export type MacroParameter = z.infer<typeof macroParameterSchema>;

const operationSchema: z.ZodType<KernelOperation> = z.unknown().transform((value, context) => {
  const parsed = kernelOperationSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  context.addIssue({ code: "custom", message: "Invalid kernel operation." });
  return z.NEVER;
});

/**
 * One step of the plan. Steps after the first are replayed from their recorded selections,
 * parameters and operation; the first step's are optional, because a user drives it.
 */
export const authoredPlanStepSchema = z
  .object({
    id: stableIdentifierSchema,
    /** The hand-authored primitive move this step applies. */
    moveId: moveIdSchema,
    operationKind: z.enum(KERNEL_OPERATION_KINDS),
    selections: z.array(macroSelectionSchema).max(16).optional(),
    parameters: z.array(macroParameterSchema).max(32).optional(),
    operation: operationSchema.optional(),
  })
  .strict();
export type AuthoredPlanStep = z.infer<typeof authoredPlanStepSchema>;

export const authoredPlanSchema = z
  .object({
    kind: z.literal("deterministic-plan"),
    steps: z.array(authoredPlanStepSchema).min(1).max(MAX_PLAN_STEPS),
  })
  .strict();
export type AuthoredPlan = z.infer<typeof authoredPlanSchema>;

// --------------------------------------------------------------------------------------------
// Examples
// --------------------------------------------------------------------------------------------

const exampleSelectionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("exact"),
      anchor: z
        .object({
          stateId: stableIdentifierSchema.optional(),
          target: targetSchema,
          statement: menuLabelStatementSchema,
        })
        .strict(),
      path: operandPathSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("associative"),
      anchor: z
        .object({
          stateId: stableIdentifierSchema.optional(),
          target: targetSchema,
          statement: menuLabelStatementSchema,
        })
        .strict(),
      containerPath: operandPathSchema,
      startOperand: z.number().int().nonnegative(),
      endOperand: z.number().int().nonnegative(),
    })
    .strict(),
]);

const menuItemIdSchema = z.string().regex(/^menu-item:[0-9a-f]{16}$/);

const positiveOutcomeSchema = z
  .object({
    outcome: z.literal("applied"),
    transitionClass: z.enum(["equivalence", "strengthening", "weakening"]),
    /** Conclusions of every goal of the resulting state, in order (compared up to alpha-renaming). */
    goals: z.array(plainMathJsonSchema).max(256),
    obligations: z.array(plainMathJsonSchema).max(256),
  })
  .strict();
const negativeOutcomeSchema = z
  .object({
    outcome: z.literal("rejected"),
    /** When given, the diagnostic code the rejection must carry. */
    diagnosticCode: z.string().min(1).optional(),
  })
  .strict();

export const authoredExampleSchema = z
  .object({
    id: stableIdentifierSchema,
    description: z.string().min(1),
    /** A stored-style executable proof state; validated in the session's operator environment. */
    state: z.record(z.string(), z.unknown()),
    selections: z.record(stableIdentifierSchema, exampleSelectionSchema),
    menuChoices: z.record(stableIdentifierSchema, menuItemIdSchema).optional(),
    expected: z.discriminatedUnion("outcome", [positiveOutcomeSchema, negativeOutcomeSchema]),
  })
  .strict();
export type AuthoredExample = z.infer<typeof authoredExampleSchema>;

// --------------------------------------------------------------------------------------------
// The template
// --------------------------------------------------------------------------------------------

export const authoredMoveTemplateSchema = z
  .object({
    id: authoredMoveIdSchema,
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(2_000),
    selectionContract: z
      .object({
        slots: z.array(moveSelectionSlotSchema).max(16),
        allowAdditional: z.literal(false),
      })
      .strict(),
    patterns: z.array(movePatternSchema).min(1).max(32),
    contextRequirements: z.array(z.string().min(1)).max(32),
    sideConditions: z.array(z.string().min(1)).max(32),
    parameters: z.array(moveParameterSchema).max(32),
    requiredArtifacts: z.array(libraryArtifactReferenceSchema).max(32),
    plan: authoredPlanSchema,
    transitionClass: z.enum(["equivalence", "strengthening", "weakening"]),
    examples: z.array(authoredExampleSchema).max(MAX_EXAMPLES),
    discoveryContext: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((template, context) => {
    const duplicates = (
      values: readonly string[],
      label: string,
      path: readonly (string | number)[],
    ) => {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value)) {
          context.addIssue({
            code: "custom",
            message: `Each ${label} must be unique.`,
            path: [...path, index],
          });
        }
        seen.add(value);
      });
    };
    duplicates(
      template.selectionContract.slots.map(({ id }) => id),
      "selection slot ID",
      ["selectionContract", "slots"],
    );
    duplicates(
      template.patterns.map(({ id }) => id),
      "pattern ID",
      ["patterns"],
    );
    duplicates(
      template.parameters.map(({ id }) => id),
      "parameter ID",
      ["parameters"],
    );
    duplicates(
      template.plan.steps.map(({ id }) => id),
      "plan step ID",
      ["plan", "steps"],
    );
    duplicates(
      template.examples.map(({ id }) => id),
      "example ID",
      ["examples"],
    );
    const slotIds = new Set(template.selectionContract.slots.map(({ id }) => id));
    template.patterns.forEach((pattern, index) => {
      if (!slotIds.has(pattern.selectionSlotId)) {
        context.addIssue({
          code: "custom",
          message: "Every pattern must identify one declared selection slot.",
          path: ["patterns", index, "selectionSlotId"],
        });
      }
    });
    template.requiredArtifacts.forEach((reference, index) => {
      if (reference.kind !== "definition" && reference.kind !== "result") {
        context.addIssue({
          code: "custom",
          message: "A move may require only mathematical definitions or results.",
          path: ["requiredArtifacts", index, "kind"],
        });
      }
    });
    template.plan.steps.forEach((step, index) => {
      if (index > 0 && (step.selections === undefined || step.selections.length === 0)) {
        context.addIssue({
          code: "custom",
          message: "A step after the first is replayed from its recorded selections.",
          path: ["plan", "steps", index, "selections"],
        });
      }
      if (index > 0 && step.operation === undefined) {
        context.addIssue({
          code: "custom",
          message: "A step after the first records the operation it applied.",
          path: ["plan", "steps", index, "operation"],
        });
      }
    });
  });
export type AuthoredMoveTemplate = z.infer<typeof authoredMoveTemplateSchema>;

// --------------------------------------------------------------------------------------------
// Diagnostics and results
// --------------------------------------------------------------------------------------------

export type TemplateDiagnosticCode =
  | "invalid-template"
  | "unknown-primitive"
  | "primitive-mismatch"
  | "slot-mismatch"
  | "parameter-mismatch"
  | "unknown-artifact"
  | "class-mismatch"
  | "missing-example"
  | "example-invalid"
  | "example-incomplete"
  | "example-failed"
  | "example-mismatch"
  | "example-accepted"
  | "macro-step-unmatched"
  | "plan-inconsistent";

export type TemplateDiagnostic = Readonly<{
  code: TemplateDiagnosticCode;
  message: string;
  /** JSON path into the template, when the problem belongs to one part. */
  path?: readonly (string | number)[];
  exampleId?: string;
  stepIndex?: number;
}>;

export type ExampleReport = Readonly<{
  exampleId: string;
  outcome: "applied" | "rejected";
  transitionClass?: TransitionClass;
  stepCount: number;
}>;

export type MoveTemplateReport = Readonly<{
  /** The class composed from the kernel transitions of the plan's primitives. */
  transitionClass: TransitionClass;
  stepCount: number;
  /**
   * True when, once approved, the template is retrievable: a single step as an ordinary
   * definition, a macro through its first-step projection (`authoredMacroDefinition`).
   */
  retrievable: boolean;
  examples: readonly ExampleReport[];
}>;

export type MoveTemplateValidation =
  | Readonly<{ ok: true; template: AuthoredMoveTemplate; report: MoveTemplateReport }>
  | Readonly<{ ok: false; diagnostics: readonly [TemplateDiagnostic, ...TemplateDiagnostic[]] }>;

export type MoveTemplateValidationOptions = Readonly<{
  operators?: readonly OperatorDeclaration[];
  /** Approved kernel results, for plans that apply library results. */
  results?: KernelEnvironment["results"];
  /** When given, every required artifact must satisfy it. */
  artifactExists?: (reference: { kind: string; id: string }) => boolean;
}>;

// --------------------------------------------------------------------------------------------
// Primitive lookup and projection
// --------------------------------------------------------------------------------------------

const PRIMITIVE_BY_ID: ReadonlyMap<string, MoveDefinition> = new Map(
  HAND_AUTHORED_MOVES.map((move) => [move.id, move]),
);

/** The hand-authored primitive a plan step applies, or undefined when the step names none. */
export function primitiveForStep(step: AuthoredPlanStep): MoveDefinition | undefined {
  const primitive = PRIMITIVE_BY_ID.get(step.moveId);
  return primitive?.implementation.operationKind === step.operationKind ? primitive : undefined;
}

/**
 * The declared class a plan must have: the weakest guarantee among its primitives' classes.
 * Undefined when a step names no primitive.
 */
export function plannedTransitionClass(plan: AuthoredPlan): TransitionClass | undefined {
  const classes = plan.steps.map((step) => declaredTransitionClass(step.operationKind));
  return classes.length === 0 ? undefined : composeTransitionClasses(classes);
}

/** The first step's definition: the template's contract over the first primitive. */
function firstStepDefinition(
  template: AuthoredMoveTemplate,
  approval: MoveDefinition["approval"],
  provenanceSource: string,
): MoveDefinition | undefined {
  const first = template.plan.steps[0];
  const primitive = first === undefined ? undefined : primitiveForStep(first);
  if (first === undefined || primitive === undefined) return undefined;
  const parsed = moveDefinitionSchema.safeParse({
    id: template.id,
    name: template.name,
    description: template.description,
    selectionContract: template.selectionContract,
    patterns: template.patterns,
    contextRequirements:
      template.contextRequirements.length === 0
        ? primitive.contextRequirements
        : template.contextRequirements,
    sideConditions:
      template.sideConditions.length === 0 ? primitive.sideConditions : template.sideConditions,
    parameters: template.parameters,
    requiredArtifacts: template.requiredArtifacts,
    implementation: primitive.implementation,
    // The primitive's own class: the moves schema ties it to the implementation.
    transitionClass: declaredTransitionClass(first.operationKind),
    previewRenderer: "kernel-state-delta",
    examples: {
      positive: template.examples
        .filter(({ expected }) => expected.outcome === "applied")
        .map(({ description }) => description),
      negative: template.examples
        .filter(({ expected }) => expected.outcome === "rejected")
        .map(({ description }) => description),
    },
    provenance: { kind: "curated", source: provenanceSource },
    approval,
    ...(template.discoveryContext === undefined
      ? {}
      : { discoveryContext: template.discoveryContext }),
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * The retrievable definition of an approved single-step template, or undefined for a macro (whose
 * steps cannot be carried by one command path edge) and for a template that does not parse.
 */
export function authoredMoveDefinition(
  template: unknown,
  approval: Extract<MoveDefinition["approval"], { status: "approved" }>,
  provenanceSource: string,
): MoveDefinition | undefined {
  const parsed = authoredMoveTemplateSchema.safeParse(template);
  if (!parsed.success || parsed.data.plan.steps.length !== 1) return undefined;
  const definition = firstStepDefinition(parsed.data, approval, provenanceSource);
  if (definition === undefined) return undefined;
  // For a single step the declared class is the primitive's; validation enforces equality.
  return definition.transitionClass === parsed.data.transitionClass ? definition : undefined;
}

/**
 * The retrieval projection of an approved multi-step macro: its FIRST step's contract over the
 * first primitive, under the macro's own ID, with the composed class of the whole plan recorded
 * separately by `plannedTransitionClass`. Undefined for a single-step template (use
 * `authoredMoveDefinition`) and for a template that does not parse.
 *
 * The projection must be used for retrieval only. It is not an applicable definition: applying
 * it as a single primitive would run just the first step, so it never joins the command path's
 * move catalog.
 */
export function authoredMacroDefinition(
  template: unknown,
  approval: Extract<MoveDefinition["approval"], { status: "approved" }>,
  provenanceSource: string,
): Readonly<{ definition: MoveDefinition; template: AuthoredMoveTemplate }> | undefined {
  const parsed = authoredMoveTemplateSchema.safeParse(template);
  if (!parsed.success || parsed.data.plan.steps.length < 2) return undefined;
  const definition = firstStepDefinition(parsed.data, approval, provenanceSource);
  if (definition === undefined) return undefined;
  if (plannedTransitionClass(parsed.data.plan) !== parsed.data.transitionClass) return undefined;
  return { definition, template: parsed.data };
}

// --------------------------------------------------------------------------------------------
// Running a plan
// --------------------------------------------------------------------------------------------

/** One executed plan step: what it did and the state it left. */
export type PlanRunStep = Readonly<{
  /** 1-based position in the plan. */
  index: number;
  /** The plan step's own ID. */
  id: string;
  /** The hand-authored primitive move the step applied. */
  moveId: MoveId;
  operation: KernelOperation;
  transitionClass: TransitionClass;
  /** The state after this step. */
  state: ExecutableProofState;
}>;

export type PlanRunDiagnostic = Readonly<{
  code:
    | "requires-input"
    | "materialization-failed"
    | "kernel-rejected"
    | "macro-step-unmatched"
    | "plan-inconsistent"
    | "invalid-input";
  message: string;
  /** The underlying diagnostic code of a materialization or kernel failure. */
  cause?: string;
  stepIndex: number;
  missingParameters?: readonly string[];
  /** The first step's menus so far, for `requires-input`. */
  menus?: readonly ParameterMenu[];
}>;

export type PlanRunResult =
  | Readonly<{
      ok: true;
      operations: readonly KernelOperation[];
      transitionClass: TransitionClass;
      state: ExecutableProofState;
      steps: readonly PlanRunStep[];
      /** The first step's menus as displayed, for static history. */
      menus: readonly ParameterMenu[];
    }>
  | Readonly<{ ok: false; diagnostic: PlanRunDiagnostic }>;

type Bindings = Map<string, PlainMathJson>;

type Correspondence = {
  symbols: Bindings;
  /** Recorded statement or generated ID → the ID in the state being run. */
  ids: Map<string, string>;
};

/**
 * Run a template's plan on a state: the first step from the given selections and menu choices,
 * every later step replayed from its recording. Each step is materialized, planned through
 * `planMove` and applied by the kernel; the composed operations are then re-run as one chain by
 * `planMoveSequence`, which must agree.
 */
export function runMovePlan(
  templateInput: AuthoredMoveTemplate,
  stateInput: ExecutableProofState,
  selections: MoveSelections,
  menuChoices: Readonly<Record<string, string>>,
  environment: KernelEnvironment,
  commandPrefix: string,
): PlanRunResult {
  const template = templateInput;
  const operators = environment.operators ?? [];
  const definition = firstStepDefinition(
    template,
    { status: "approved", reviewerId: "reviewer:template-check" },
    "template validation",
  );
  if (definition === undefined) {
    return runFailure("invalid-input", "The first plan step names no primitive.", 0);
  }
  const correspondence: Correspondence = { symbols: new Map(), ids: new Map() };
  const operations: KernelOperation[] = [];
  const classes: TransitionClass[] = [];
  const steps: PlanRunStep[] = [];
  let menus: readonly ParameterMenu[] = [];
  let state = stateInput;

  for (const [stepIndex, step] of template.plan.steps.entries()) {
    const primitive = primitiveForStep(step);
    if (primitive === undefined) {
      return runFailure("invalid-input", "A plan step names no primitive.", stepIndex);
    }
    const generator = commandIdGenerator(`${commandPrefix}:${stepIndex + 1}`);
    let operation: KernelOperation;
    if (stepIndex === 0) {
      const seeded = seedFirstStep(step, state, selections, correspondence, operators);
      if (seeded !== undefined) return runFailure("macro-step-unmatched", seeded, 0);
      const materialized = materializeMoveOperation({
        state,
        move: definition,
        selections,
        menuChoices,
        idGenerator: generator,
        env: environment,
      });
      if (!materialized.ok) {
        const diagnostic = materialized.diagnostics[0];
        return diagnostic.code === "requires-input"
          ? {
              ok: false,
              diagnostic: {
                code: "requires-input",
                message: diagnostic.message,
                stepIndex,
                missingParameters: materialized.missingParameters,
                menus: materialized.menus,
              },
            }
          : runFailure("materialization-failed", diagnostic.message, stepIndex, diagnostic.code);
      }
      operation = materialized.operation;
      menus = materialized.menus;
    } else {
      const replayed = replayStep(step, primitive, state, generator, correspondence, environment);
      if (!replayed.ok) return { ok: false, diagnostic: { ...replayed.diagnostic, stepIndex } };
      operation = replayed.operation;
    }
    const planned = planMove(state, { moveId: primitive.id, operation }, environment);
    if (!planned.ok) {
      return runFailure(
        planned.diagnostics[0].code === "kernel-rejected" ? "kernel-rejected" : "plan-inconsistent",
        planned.diagnostics[0].message,
        stepIndex,
        planned.diagnostics[0].code,
      );
    }
    if (step.operation !== undefined)
      pairIdentifiers(step.operation, operation, correspondence.ids);
    operations.push(operation);
    classes.push(planned.preview.transitionClass);
    state = planned.preview.state;
    steps.push({
      index: stepIndex + 1,
      id: step.id,
      moveId: primitive.id,
      operation,
      transitionClass: planned.preview.transitionClass,
      state,
    });
  }

  const chained = planMoveSequence(stateInput, operations, environment, {
    kind: "deterministic-plan",
    steps: template.plan.steps.map(({ id, operationKind }) => ({ id, operationKind })),
  });
  if (!chained.ok) {
    return runFailure("plan-inconsistent", chained.diagnostics[0].message, 0);
  }
  const transitionClass = composeTransitionClasses(classes);
  if (
    chained.preview.transitionClass !== transitionClass ||
    JSON.stringify(chained.preview.state) !== JSON.stringify(state)
  ) {
    return runFailure(
      "plan-inconsistent",
      "The composed plan disagrees with the step-by-step run.",
      0,
    );
  }
  return { ok: true, operations, transitionClass, state, steps, menus };
}

function runFailure(
  code: PlanRunDiagnostic["code"],
  message: string,
  stepIndex: number,
  cause?: string,
): PlanRunResult {
  return {
    ok: false,
    diagnostic: { code, message, stepIndex, ...(cause === undefined ? {} : { cause }) },
  };
}

type Entry = ExecutableProofState["goals"][number];

function entryById(state: ExecutableProofState, id: string): Entry | undefined {
  return (
    state.goals.find((goal) => goal.id === id) ??
    (state.obligations.find((obligation) => obligation.id === id) as Entry | undefined)
  );
}

function selectedFragment(
  state: ExecutableProofState,
  selection: MoveSelectionInput,
): PlainMathJson | undefined {
  const entry = entryById(state, selection.anchor.target.id);
  if (entry === undefined) return undefined;
  const anchorStatement = selection.anchor.statement;
  const statement =
    anchorStatement.kind === "conclusion"
      ? entry.sequent.conclusion.expression
      : entry.sequent.context.hypotheses.find(({ id }) => id === anchorStatement.id)?.statement
          .expression;
  if (statement === undefined) return undefined;
  if (selection.kind === "exact") return expressionAtPath(statement, selection.path);
  const container = expressionAtPath(statement, selection.containerPath);
  const parts = container === undefined ? undefined : functionParts(container);
  return parts?.rebuild(parts.operands.slice(selection.startOperand, selection.endOperand));
}

/**
 * Seed the correspondence from the user's selections: the recorded first step's fragments are
 * preconditions, matched as patterns against what the user selected. Returns a message on mismatch.
 */
function seedFirstStep(
  step: AuthoredPlanStep,
  state: ExecutableProofState,
  selections: MoveSelections,
  correspondence: Correspondence,
  operators: readonly OperatorDeclaration[],
): string | undefined {
  for (const recorded of step.selections ?? []) {
    const chosen = selections[recorded.slotId];
    if (chosen === undefined) continue;
    const fragment = selectedFragment(state, chosen);
    if (fragment === undefined) return `The selection for ${recorded.slotId} is not in the state.`;
    const bindings = matchExpressionPattern(
      recorded.fragment,
      fragment,
      recorded.variables.map(({ symbol }) => symbol),
      { operators },
    );
    if (bindings === undefined || !mergeBindings(correspondence.symbols, bindings, operators)) {
      return `The selection for ${recorded.slotId} does not match the recorded pattern.`;
    }
    correspondence.ids.set(recorded.target.id, chosen.anchor.target.id);
    if (recorded.statement.role === "hypothesis" && chosen.anchor.statement.kind === "hypothesis") {
      correspondence.ids.set(recorded.statement.id, chosen.anchor.statement.id);
    }
  }
  return undefined;
}

type Replayed =
  | Readonly<{ ok: true; operation: KernelOperation }>
  | Readonly<{ ok: false; diagnostic: Omit<PlanRunDiagnostic, "stepIndex"> }>;

type Candidate = Readonly<{
  target: { kind: "goal" | "obligation"; id: string };
  statement: MacroSelection["statement"];
  occurrence: MacroSelection["occurrence"];
  bindings: Readonly<Record<string, PlainMathJson>>;
  rank: readonly number[];
}>;

function replayStep(
  step: AuthoredPlanStep,
  primitive: MoveDefinition,
  state: ExecutableProofState,
  generator: ReturnType<typeof commandIdGenerator>,
  correspondence: Correspondence,
  environment: KernelEnvironment,
): Replayed {
  const operators = environment.operators ?? [];
  const recordedSelections = step.selections ?? [];
  const perSlot = recordedSelections.map((selection) => ({
    selection,
    candidates: slotCandidates(state, selection, correspondence, operators),
  }));
  const unmatched = perSlot.find(({ candidates }) => candidates.length === 0);
  if (unmatched !== undefined) {
    return replayFailure(
      "macro-step-unmatched",
      `No occurrence of the recorded selection for ${unmatched.selection.slotId} was found.`,
    );
  }
  // Targets, in the order of the first slot's candidates, where every slot has a candidate.
  const targetKeys: string[] = [];
  for (const candidate of perSlot[0]?.candidates ?? []) {
    const key = `${candidate.target.kind}\u0000${candidate.target.id}`;
    if (
      !targetKeys.includes(key) &&
      perSlot.every(({ candidates }) =>
        candidates.some((other) => `${other.target.kind}\u0000${other.target.id}` === key),
      )
    ) {
      targetKeys.push(key);
    }
  }
  if (targetKeys.length === 0) {
    return replayFailure(
      "macro-step-unmatched",
      "No target has an occurrence of every recorded selection.",
    );
  }
  let attempts = 0;
  let lastFailure: Replayed | undefined;
  for (const key of targetKeys) {
    const lists = perSlot.map(({ selection, candidates }) => ({
      selection,
      candidates: candidates.filter(
        (candidate) => `${candidate.target.kind}\u0000${candidate.target.id}` === key,
      ),
    }));
    const first = lists[0];
    if (first === undefined) continue;
    for (const lead of first.candidates) {
      if (attempts >= MAX_CANDIDATE_ATTEMPTS) break;
      attempts += 1;
      const chosen = [lead, ...lists.slice(1).map(({ candidates }) => candidates[0])];
      if (chosen.some((candidate) => candidate === undefined)) continue;
      const merged: Bindings = new Map(correspondence.symbols);
      if (
        !chosen.every((candidate) =>
          mergeBindings(merged, (candidate as Candidate).bindings, operators),
        )
      ) {
        lastFailure = replayFailure(
          "macro-step-unmatched",
          "The recorded selections match with inconsistent substitutions.",
        );
        continue;
      }
      const inputs: Record<string, MoveSelectionInput> = {};
      recordedSelections.forEach(({ slotId }, index) => {
        inputs[slotId] = moveSelectionInput(state, chosen[index] as Candidate);
      });
      const attempt = materializeRecordedStep(
        step,
        primitive,
        state,
        inputs,
        generator,
        { symbols: merged, ids: correspondence.ids },
        environment,
      );
      if (attempt.ok) {
        for (const [symbol, expression] of merged) correspondence.symbols.set(symbol, expression);
        recordedSelections.forEach((recorded, index) => {
          const candidate = chosen[index] as Candidate;
          correspondence.ids.set(recorded.target.id, candidate.target.id);
          if (
            recorded.statement.role === "hypothesis" &&
            candidate.statement.role === "hypothesis"
          ) {
            correspondence.ids.set(recorded.statement.id, candidate.statement.id);
          }
        });
        return attempt;
      }
      lastFailure = attempt;
    }
  }
  return (
    lastFailure ??
    replayFailure("macro-step-unmatched", "No consistent assignment of the selections was found.")
  );
}

function materializeRecordedStep(
  step: AuthoredPlanStep,
  primitive: MoveDefinition,
  state: ExecutableProofState,
  selections: Readonly<Record<string, MoveSelectionInput>>,
  generator: ReturnType<typeof commandIdGenerator>,
  correspondence: Correspondence,
  environment: KernelEnvironment,
): Replayed {
  const operators = environment.operators ?? [];
  const choices: Record<string, string> = {};
  const recorded = step.parameters ?? [];
  for (let round = 0; round <= recorded.length + 1; round += 1) {
    const materialized = materializeMoveOperation({
      state,
      move: primitive,
      selections,
      menuChoices: choices,
      idGenerator: generator,
      env: environment,
    });
    if (materialized.ok) return { ok: true, operation: materialized.operation };
    const diagnostic = materialized.diagnostics[0];
    if (diagnostic.code !== "requires-input") {
      return replayFailure("materialization-failed", diagnostic.message, diagnostic.code);
    }
    for (const parameterId of materialized.missingParameters) {
      const parameter = recorded.find((candidate) => candidate.parameterId === parameterId);
      const menu = materialized.menus.find((candidate) => candidate.parameterId === parameterId);
      if (parameter === undefined || menu === undefined) {
        return replayFailure(
          "materialization-failed",
          `The step asks for ${parameterId}, which the recording did not choose.`,
          "requires-input",
        );
      }
      const picked = pickItem(menu, parameter, correspondence, operators);
      if (picked === undefined) {
        return replayFailure(
          "materialization-failed",
          `No item of the ${parameterId} menu corresponds to the recorded choice.`,
          "invalid-choice",
        );
      }
      choices[parameterId] = picked.item.id;
      for (const [symbol, expression] of Object.entries(picked.bindings)) {
        if (!correspondence.symbols.has(symbol)) correspondence.symbols.set(symbol, expression);
      }
    }
  }
  return replayFailure("materialization-failed", "The step could not be materialized.");
}

function replayFailure(code: PlanRunDiagnostic["code"], message: string, cause?: string): Replayed {
  return {
    ok: false,
    diagnostic: { code, message, ...(cause === undefined ? {} : { cause }) },
  };
}

function moveSelectionInput(state: ExecutableProofState, candidate: Candidate): MoveSelectionInput {
  const anchor = {
    stateId: state.id,
    target: candidate.target as { kind: "goal" | "obligation"; id: never },
    statement:
      candidate.statement.role === "conclusion"
        ? ({ kind: "conclusion" } as const)
        : ({ kind: "hypothesis", id: candidate.statement.id as never } as const),
  };
  return candidate.occurrence.kind === "exact"
    ? { kind: "exact", anchor, path: candidate.occurrence.path }
    : {
        kind: "associative",
        anchor,
        containerPath: candidate.occurrence.containerPath,
        startOperand: candidate.occurrence.startOperand,
        endOperand: candidate.occurrence.endOperand,
      };
}

/** Every occurrence of the recorded fragment's pattern in the state, best first. */
function slotCandidates(
  state: ExecutableProofState,
  selection: MacroSelection,
  correspondence: Correspondence,
  operators: readonly OperatorDeclaration[],
): Candidate[] {
  const names = selection.variables.map(({ symbol }) => symbol);
  const mappedTarget = correspondence.ids.get(selection.target.id);
  const mappedHypothesis =
    selection.statement.role === "hypothesis"
      ? correspondence.ids.get(selection.statement.id)
      : undefined;
  const candidates: Candidate[] = [];
  const all: ["goal" | "obligation", Entry][] = [
    ...state.goals.map((entry) => ["goal", entry] as ["goal" | "obligation", Entry]),
    ...state.obligations.map(
      (entry) => ["obligation", entry as Entry] as ["goal" | "obligation", Entry],
    ),
  ];
  let order = 0;
  for (const [entryIndex, [kind, entry]] of all.entries()) {
    const targetRank =
      mappedTarget === entry.id
        ? 0
        : mappedTarget === undefined && selection.target.id === entry.id
          ? 1
          : 2;
    const statements: [MacroSelection["statement"], PlainMathJson][] = [
      [{ role: "conclusion" }, entry.sequent.conclusion.expression],
      ...entry.sequent.context.hypotheses.map(
        (hypothesis) =>
          [{ role: "hypothesis", id: hypothesis.id }, hypothesis.statement.expression] as [
            MacroSelection["statement"],
            PlainMathJson,
          ],
      ),
    ];
    for (const [statement, expression] of statements) {
      if (statement.role !== selection.statement.role) continue;
      const wanted =
        selection.statement.role === "hypothesis"
          ? (mappedHypothesis ?? selection.statement.id)
          : undefined;
      const statementRank = statement.role === "conclusion" ? 0 : statement.id === wanted ? 0 : 1;
      for (const found of occurrencesOf(expression, selection, operators)) {
        order += 1;
        const bindings = matchExpressionPattern(selection.fragment, found.subject, names, {
          operators,
        });
        if (bindings === undefined) continue;
        if (!consistentWith(correspondence.symbols, bindings, operators)) continue;
        candidates.push({
          target: { kind, id: entry.id },
          statement,
          occurrence: found.occurrence,
          bindings,
          rank: [
            targetRank,
            statementRank,
            JSON.stringify(found.occurrence) === JSON.stringify(selection.occurrence) ? 0 : 1,
            entryIndex,
            order,
          ],
        });
      }
    }
  }
  return candidates.sort((left, right) => {
    for (let index = 0; index < left.rank.length; index += 1) {
      const difference = (left.rank[index] ?? 0) - (right.rank[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  });
}

type Found = Readonly<{ occurrence: MacroSelection["occurrence"]; subject: PlainMathJson }>;

function occurrencesOf(
  expression: PlainMathJson,
  selection: MacroSelection,
  operators: readonly OperatorDeclaration[],
): Found[] {
  const found: Found[] = [];
  const recorded = selection.occurrence;
  const width = recorded.kind === "associative" ? recorded.endOperand - recorded.startOperand : 0;
  const head = functionParts(selection.fragment)?.operator;
  const visit = (node: PlainMathJson, path: readonly number[]): void => {
    if (found.length > 4096) return;
    const parts = functionParts(node);
    if (recorded.kind === "exact") {
      found.push({ occurrence: { kind: "exact", path: [...path] }, subject: node });
    } else if (parts !== undefined && parts.operator === head && parts.operands.length > width) {
      for (let start = 0; start + width <= parts.operands.length; start += 1) {
        found.push({
          occurrence: {
            kind: "associative",
            containerPath: [...path],
            startOperand: start,
            endOperand: start + width,
          },
          subject: parts.rebuild(parts.operands.slice(start, start + width)),
        });
      }
    }
    if (parts === undefined) return;
    const shape = binderShape(parts.operator, parts.operands.length, operators);
    parts.operands.forEach((operand, index) => {
      if (shape?.boundOperands.includes(index)) return;
      visit(operand, [...path, index]);
    });
  };
  visit(expression, []);
  return found;
}

function consistentWith(
  symbols: ReadonlyMap<string, PlainMathJson>,
  bindings: Readonly<Record<string, PlainMathJson>>,
  operators: readonly OperatorDeclaration[],
): boolean {
  return Object.entries(bindings).every(([symbol, expression]) => {
    const known = symbols.get(symbol);
    return known === undefined || alphaEquivalent(known, expression, { operators });
  });
}

function mergeBindings(
  symbols: Bindings,
  bindings: Readonly<Record<string, PlainMathJson>>,
  operators: readonly OperatorDeclaration[],
): boolean {
  if (!consistentWith(symbols, bindings, operators)) return false;
  for (const [symbol, expression] of Object.entries(bindings)) symbols.set(symbol, expression);
  return true;
}

// Menu parameters -----------------------------------------------------------------------------

function pickItem(
  menu: ParameterMenu,
  recorded: MacroParameter,
  correspondence: Correspondence,
  operators: readonly OperatorDeclaration[],
):
  | Readonly<{ item: ParameterMenuItem; bindings: Readonly<Record<string, PlainMathJson>> }>
  | undefined {
  if (menu.automatic && menu.items.length === 1 && menu.items[0] !== undefined) {
    return { item: menu.items[0], bindings: {} };
  }
  const expected = mapValue(recorded.value as MenuValue, correspondence, operators);
  if (expected !== undefined) {
    const same = menu.items.find((item) =>
      valuesEqual(item.value as MenuValue, expected, operators),
    );
    if (same !== undefined) return { item: same, bindings: {} };
  }
  const byOrigin = menu.items.find((item) =>
    originCorresponds(recorded.origin, item.origin, correspondence),
  );
  if (byOrigin !== undefined) {
    return { item: byOrigin, bindings: valueBindings(recorded, byOrigin, operators) };
  }
  return undefined;
}

function valueBindings(
  recorded: MacroParameter,
  item: ParameterMenuItem,
  operators: readonly OperatorDeclaration[],
): Readonly<Record<string, PlainMathJson>> {
  const from = recorded.value;
  const to = item.value;
  if ((from.kind !== "term" && from.kind !== "proposition") || from.kind !== to.kind) return {};
  return (
    matchExpressionPattern(
      from.expression,
      (to as Extract<MenuValue, { expression: PlainMathJson }>).expression,
      recorded.variables.map(({ symbol }) => symbol),
      { operators },
    ) ?? {}
  );
}

function originCorresponds(
  recorded: MenuItemOrigin,
  candidate: MenuItemOrigin,
  correspondence: Correspondence,
): boolean {
  const mapped = (id: string): string => correspondence.ids.get(id) ?? id;
  switch (recorded.kind) {
    case "selection":
      return candidate.kind === "selection" && candidate.slotId === recorded.slotId;
    case "conclusion":
      return candidate.kind === "conclusion";
    case "hypothesis":
      return (
        candidate.kind === "hypothesis" && candidate.hypothesisId === mapped(recorded.hypothesisId)
      );
    case "subterm-of": {
      if (candidate.kind !== "subterm-of") return false;
      const same =
        recorded.statement.kind === "conclusion"
          ? candidate.statement.kind === "conclusion"
          : candidate.statement.kind === "hypothesis" &&
            candidate.statement.id === mapped(recorded.statement.id);
      return same && JSON.stringify(candidate.path) === JSON.stringify(recorded.path);
    }
    case "result":
      return candidate.kind === "result" && candidate.resultId === recorded.resultId;
    case "assumption":
      return (
        candidate.kind === "assumption" && candidate.assumptionId === mapped(recorded.assumptionId)
      );
    default:
      return false;
  }
}

function mapValue(
  value: MenuValue,
  correspondence: Correspondence,
  operators: readonly OperatorDeclaration[],
): MenuValue | undefined {
  const mapped = (id: string): string => correspondence.ids.get(id) ?? id;
  switch (value.kind) {
    case "term":
    case "proposition": {
      const expression = mapExpression(value.expression, correspondence, operators);
      return expression === undefined ? undefined : { kind: value.kind, expression };
    }
    case "rewrite-source": {
      if (value.source.kind === "hypothesis") {
        return {
          kind: "rewrite-source",
          source: { kind: "hypothesis", hypothesisId: mapped(value.source.hypothesisId) as never },
        };
      }
      const instantiation: Record<string, PlainMathJson> = {};
      for (const [symbol, expression] of Object.entries(value.source.instantiation)) {
        const replaced = mapExpression(expression, correspondence, operators);
        if (replaced === undefined) return undefined;
        instantiation[symbol] = replaced;
      }
      return { kind: "rewrite-source", source: { ...value.source, instantiation } };
    }
    case "assumption":
      return { kind: "assumption", assumptionId: mapped(value.assumptionId) };
    default:
      return value;
  }
}

function mapExpression(
  expression: PlainMathJson,
  correspondence: Correspondence,
  operators: readonly OperatorDeclaration[],
): PlainMathJson | undefined {
  const substitutions = [...correspondence.symbols].flatMap(([symbol, replacement]) =>
    symbolName(replacement) === symbol ? [] : [{ symbol, replacement }],
  );
  if (substitutions.length === 0) return expression;
  const substituted = substituteMathJson(expression, substitutions, { operators });
  return substituted.ok ? substituted.expression : undefined;
}

function valuesEqual(
  left: MenuValue,
  right: MenuValue,
  operators: readonly OperatorDeclaration[],
): boolean {
  if (left.kind !== right.kind) return false;
  if (
    (left.kind === "term" || left.kind === "proposition") &&
    (right.kind === "term" || right.kind === "proposition")
  ) {
    return alphaEquivalent(left.expression, right.expression, { operators });
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function symbolName(expression: PlainMathJson): string | undefined {
  if (typeof expression === "string") return expression;
  return typeof expression === "object" &&
    expression !== null &&
    !Array.isArray(expression) &&
    "sym" in expression &&
    typeof expression.sym === "string"
    ? expression.sym
    : undefined;
}

const STATE_ID_KEYS = new Set(["expectedStateId", "resultStateId"]);

/** Pair identifiers position by position between a recorded and a run operation. */
function pairIdentifiers(
  recorded: unknown,
  run: unknown,
  ids: Map<string, string>,
  key = "",
): void {
  if (typeof recorded === "string" && typeof run === "string") {
    if ((key === "id" || /Ids?$/.test(key)) && !STATE_ID_KEYS.has(key) && !ids.has(recorded)) {
      ids.set(recorded, run);
    }
    return;
  }
  if (Array.isArray(recorded) && Array.isArray(run)) {
    if (recorded.length !== run.length) return;
    recorded.forEach((value, index) => pairIdentifiers(value, run[index], ids, key));
    return;
  }
  if (isRecord(recorded) && isRecord(run)) {
    for (const [field, value] of Object.entries(recorded)) {
      if (
        field === "instantiation" ||
        field === "proposition" ||
        field === "term" ||
        field === "witness"
      ) {
        continue;
      }
      pairIdentifiers(value, run[field], ids, field);
    }
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --------------------------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------------------------

/**
 * Validate a template: its parts are well-formed, its contract matches the first primitive, its
 * declared class is the class of its kernel steps, and every example, run through the kernel,
 * has the expected outcome.
 */
export function validateMoveTemplate(
  input: unknown,
  options: MoveTemplateValidationOptions = {},
): MoveTemplateValidation {
  try {
    return validate(input, options);
  } catch {
    return fail([
      { code: "invalid-template", message: "The template could not be inspected safely." },
    ]);
  }
}

function fail(diagnostics: TemplateDiagnostic[]): MoveTemplateValidation {
  const [first, ...rest] = diagnostics;
  if (first === undefined) throw new Error("A failure needs a diagnostic.");
  return { ok: false, diagnostics: [first, ...rest] };
}

function validate(input: unknown, options: MoveTemplateValidationOptions): MoveTemplateValidation {
  const parsed = authoredMoveTemplateSchema.safeParse(input);
  if (!parsed.success) {
    return fail(
      parsed.error.issues.slice(0, 20).map((issue) => ({
        code: "invalid-template" as const,
        message: issue.message,
        path: issue.path.filter((part): part is string | number => typeof part !== "symbol"),
      })),
    );
  }
  const template = parsed.data;
  const diagnostics: TemplateDiagnostic[] = [];
  const operators = options.operators ?? [];

  // Plan steps name real primitives.
  template.plan.steps.forEach((step, stepIndex) => {
    const primitive = PRIMITIVE_BY_ID.get(step.moveId);
    const path = ["plan", "steps", stepIndex];
    if (primitive === undefined) {
      diagnostics.push({
        code: "unknown-primitive",
        message: `Step ${stepIndex} names ${step.moveId}, which is not a hand-authored primitive move.`,
        path: [...path, "moveId"],
        stepIndex,
      });
    } else if (primitive.implementation.operationKind !== step.operationKind) {
      diagnostics.push({
        code: "primitive-mismatch",
        message: `Step ${stepIndex} is a ${step.operationKind} step but ${step.moveId} implements ${primitive.implementation.operationKind}.`,
        path: [...path, "operationKind"],
        stepIndex,
      });
    }
    if (step.operation !== undefined && step.operation.kind !== step.operationKind) {
      diagnostics.push({
        code: "primitive-mismatch",
        message: `Step ${stepIndex} records a ${step.operation.kind} operation.`,
        path: [...path, "operation"],
        stepIndex,
      });
    }
  });
  if (diagnostics.length > 0) return fail(diagnostics);

  // The contract and parameters are the first primitive's.
  const firstStep = template.plan.steps[0] as AuthoredPlanStep;
  const primitive = primitiveForStep(firstStep) as MoveDefinition;
  diagnostics.push(...checkContract(template, primitive));

  // The declared class is the class of the kernel steps.
  const planned = plannedTransitionClass(template.plan) as TransitionClass;
  if (template.transitionClass !== planned) {
    diagnostics.push({
      code: "class-mismatch",
      message: `The template declares ${template.transitionClass}, but its kernel steps compose to ${planned}.`,
      path: ["transitionClass"],
    });
  }

  template.requiredArtifacts.forEach((reference, index) => {
    if (options.artifactExists !== undefined && !options.artifactExists(reference)) {
      diagnostics.push({
        code: "unknown-artifact",
        message: `The required ${reference.kind} ${reference.id} is not available.`,
        path: ["requiredArtifacts", index],
      });
    }
  });

  const positives = template.examples.filter(({ expected }) => expected.outcome === "applied");
  const negatives = template.examples.filter(({ expected }) => expected.outcome === "rejected");
  if (positives.length < 2 || negatives.length < 1) {
    diagnostics.push({
      code: "missing-example",
      message: "A template needs at least two positive examples and one negative example.",
      path: ["examples"],
    });
  }
  if (diagnostics.length > 0) return fail(diagnostics);

  const environment: KernelEnvironment = {
    operators,
    ...(options.results === undefined ? {} : { results: options.results }),
  };
  const reports: ExampleReport[] = [];
  template.examples.forEach((example, exampleIndex) => {
    const report = runExample(template, example, exampleIndex, environment, diagnostics);
    if (report !== undefined) reports.push(report);
  });
  if (diagnostics.length > 0) return fail(diagnostics);
  return {
    ok: true,
    template,
    report: {
      transitionClass: planned,
      stepCount: template.plan.steps.length,
      retrievable:
        firstStepDefinition(
          template,
          { status: "approved", reviewerId: "reviewer:template-check" },
          "template validation",
        ) !== undefined,
      examples: reports,
    },
  };
}

function checkContract(
  template: AuthoredMoveTemplate,
  primitive: MoveDefinition,
): TemplateDiagnostic[] {
  const diagnostics: TemplateDiagnostic[] = [];
  const primitiveSlots = new Map(primitive.selectionContract.slots.map((slot) => [slot.id, slot]));
  template.selectionContract.slots.forEach((slot, index) => {
    const base = primitiveSlots.get(slot.id);
    const path = ["selectionContract", "slots", index];
    if (base === undefined) {
      diagnostics.push({
        code: "slot-mismatch",
        message: `The slot ${slot.id} is not a slot of ${primitive.id}.`,
        path: [...path, "id"],
      });
      return;
    }
    if (slot.role !== base.role || slot.semanticRole !== base.semanticRole) {
      diagnostics.push({
        code: "slot-mismatch",
        message: `The slot ${slot.id} must keep the role ${base.role} and semantic role ${base.semanticRole}.`,
        path,
      });
    }
    if (base.required && !slot.required) {
      diagnostics.push({
        code: "slot-mismatch",
        message: `The slot ${slot.id} is required by ${primitive.id} and cannot be made optional.`,
        path: [...path, "required"],
      });
    }
  });
  const declared = new Set(template.selectionContract.slots.map(({ id }) => id));
  for (const base of primitive.selectionContract.slots) {
    if (base.required && !declared.has(base.id)) {
      diagnostics.push({
        code: "slot-mismatch",
        message: `The required slot ${base.id} of ${primitive.id} is missing from the contract.`,
        path: ["selectionContract", "slots"],
      });
    }
  }
  const primitiveParameters = new Map(
    primitive.parameters.map((parameter) => [parameter.id, parameter]),
  );
  template.parameters.forEach((parameter, index) => {
    const base = primitiveParameters.get(parameter.id);
    const path = ["parameters", index];
    if (base === undefined) {
      diagnostics.push({
        code: "parameter-mismatch",
        message: `The parameter ${parameter.id} is not a parameter of ${primitive.id}.`,
        path: [...path, "id"],
      });
    } else if (parameter.source !== base.source) {
      diagnostics.push({
        code: "parameter-mismatch",
        message: `The parameter ${parameter.id} must have the source ${base.source}.`,
        path: [...path, "source"],
      });
    }
  });
  const declaredParameters = new Set(template.parameters.map(({ id }) => id));
  for (const base of primitive.parameters) {
    if (!declaredParameters.has(base.id)) {
      diagnostics.push({
        code: "parameter-mismatch",
        message: `The parameter ${base.id} of ${primitive.id} is missing.`,
        path: ["parameters"],
      });
    }
  }
  return diagnostics;
}

function runExample(
  template: AuthoredMoveTemplate,
  example: AuthoredExample,
  exampleIndex: number,
  environment: KernelEnvironment,
  diagnostics: TemplateDiagnostic[],
): ExampleReport | undefined {
  const path = ["examples", exampleIndex];
  const problem = (
    code: TemplateDiagnosticCode,
    message: string,
    subPath: readonly (string | number)[] = [],
  ): undefined => {
    diagnostics.push({ code, message, path: [...path, ...subPath], exampleId: example.id });
    return undefined;
  };
  const stateResult = createExecutableProofStateSchema({
    operators: environment.operators ?? [],
  }).safeParse(example.state);
  if (!stateResult.success) {
    return problem(
      "example-invalid",
      `The state of example ${example.id} is not a valid proof state: ${
        stateResult.error.issues[0]?.message ?? "invalid"
      }`,
      ["state"],
    );
  }
  const state = stateResult.data as ExecutableProofState;
  const slotIds = new Set(template.selectionContract.slots.map(({ id }) => id));
  for (const slotId of Object.keys(example.selections)) {
    if (!slotIds.has(slotId)) {
      return problem(
        "example-invalid",
        `Example ${example.id} selects undeclared slot ${slotId}.`,
        ["selections", slotId],
      );
    }
  }
  for (const slot of template.selectionContract.slots) {
    if (slot.required && example.selections[slot.id] === undefined) {
      return problem(
        "example-invalid",
        `Example ${example.id} does not select the required slot ${slot.id}.`,
        ["selections"],
      );
    }
  }
  const parameterIds = new Set(template.parameters.map(({ id }) => id));
  for (const parameterId of Object.keys(example.menuChoices ?? {})) {
    if (!parameterIds.has(parameterId)) {
      return problem(
        "example-invalid",
        `Example ${example.id} chooses undeclared parameter ${parameterId}.`,
        ["menuChoices", parameterId],
      );
    }
  }
  const run = runMovePlan(
    template,
    state,
    example.selections as MoveSelections,
    example.menuChoices ?? {},
    environment,
    `authoring:${template.id}:${example.id}`,
  );
  const expected = example.expected;
  if (!run.ok) {
    const failure = run.diagnostic;
    if (failure.code === "requires-input") {
      return problem(
        "example-incomplete",
        `Example ${example.id} must choose: ${(failure.missingParameters ?? []).join(", ")}.`,
        ["menuChoices"],
      );
    }
    if (failure.code === "plan-inconsistent" || failure.code === "invalid-input") {
      return problem("plan-inconsistent", failure.message);
    }
    if (expected.outcome === "rejected") {
      const code = failure.cause ?? failure.code;
      if (expected.diagnosticCode !== undefined && expected.diagnosticCode !== code) {
        return problem(
          "example-mismatch",
          `Example ${example.id} was rejected with ${code}, not ${expected.diagnosticCode}.`,
          ["expected", "diagnosticCode"],
        );
      }
      return { exampleId: example.id, outcome: "rejected", stepCount: template.plan.steps.length };
    }
    return problem(
      failure.code === "macro-step-unmatched" ? "macro-step-unmatched" : "example-failed",
      `Example ${example.id} did not run at step ${failure.stepIndex}: ${failure.message}`,
    );
  }
  if (expected.outcome === "rejected") {
    return problem(
      "example-accepted",
      `Example ${example.id} is expected to be rejected, but the kernel accepted it.`,
      ["expected"],
    );
  }
  // The template declares the weakest class its primitives may report; an example may run as that
  // class or as a stronger one (a forward application with every premise matched), never weaker.
  if (
    composeTransitionClasses([run.transitionClass, template.transitionClass]) !==
    template.transitionClass
  ) {
    return problem(
      "class-mismatch",
      `Example ${example.id} ran as ${run.transitionClass}, which is weaker than the ${template.transitionClass} the template declares.`,
      ["expected", "transitionClass"],
    );
  }
  if (expected.transitionClass !== run.transitionClass) {
    return problem(
      "example-mismatch",
      `Example ${example.id} expects ${expected.transitionClass}, but the kernel produced ${run.transitionClass}.`,
      ["expected", "transitionClass"],
    );
  }
  const operators = environment.operators ?? [];
  const mismatch =
    compareConclusions(
      "goals",
      run.state.goals.map((goal) => goal.sequent.conclusion.expression),
      expected.goals,
      operators,
    ) ??
    compareConclusions(
      "obligations",
      run.state.obligations.map((obligation) => obligation.sequent.conclusion.expression),
      expected.obligations,
      operators,
    );
  if (mismatch !== undefined) {
    return problem("example-mismatch", `Example ${example.id}: ${mismatch}`, ["expected"]);
  }
  return {
    exampleId: example.id,
    outcome: "applied",
    transitionClass: run.transitionClass,
    stepCount: template.plan.steps.length,
  };
}

function compareConclusions(
  label: string,
  actual: readonly PlainMathJson[],
  expected: readonly PlainMathJson[],
  operators: readonly OperatorDeclaration[],
): string | undefined {
  if (actual.length !== expected.length) {
    return `the kernel produced ${actual.length} ${label}, the example expects ${expected.length}.`;
  }
  for (const [index, conclusion] of actual.entries()) {
    if (!alphaEquivalent(conclusion, expected[index] as PlainMathJson, { operators })) {
      return `the conclusion of ${label} ${index + 1} differs from the expected one.`;
    }
  }
  return undefined;
}

// --------------------------------------------------------------------------------------------
// Macros from recorded steps
// --------------------------------------------------------------------------------------------

/**
 * The structural shape of a recorded N21 step (`SemanticStep` in `@proof/protocol`, which depends
 * on this package and so cannot be imported here). Extra fields are ignored.
 */
export type RecordedStep = Readonly<{
  moveId: string;
  source: "move" | "result";
  selections: readonly MacroSelection[];
  parameters: readonly MacroParameter[];
  operation: KernelOperation;
}>;

export type MacroMetadata = Readonly<{
  id: string;
  name: string;
  description: string;
  examples?: readonly AuthoredExample[];
  discoveryContext?: string;
}>;

export type MacroFromStepsResult =
  | Readonly<{ ok: true; template: AuthoredMoveTemplate }>
  | Readonly<{ ok: false; diagnostics: readonly [TemplateDiagnostic, ...TemplateDiagnostic[]] }>;

/**
 * Build a macro move template from a recorded step sequence. The first step's primitive supplies
 * the contract and the menu parameters; its recorded selections become the patterns. Later steps
 * are carried verbatim as recordings. The result is a draft: it passes `validateMoveTemplate`
 * only when its examples do.
 */
export function macroFromSemanticSteps(
  stepsInput: readonly RecordedStep[],
  metadata: MacroMetadata,
): MacroFromStepsResult {
  const failed = (message: string, stepIndex?: number): MacroFromStepsResult => ({
    ok: false,
    diagnostics: [
      {
        code: "invalid-template",
        message,
        ...(stepIndex === undefined ? {} : { stepIndex }),
      },
    ],
  });
  if (stepsInput.length === 0 || stepsInput.length > MAX_PLAN_STEPS) {
    return failed(`A macro has between 1 and ${MAX_PLAN_STEPS} steps.`);
  }
  const steps: AuthoredPlanStep[] = [];
  for (const [index, recorded] of stepsInput.entries()) {
    if (recorded.source !== "move") {
      return failed("A macro cannot contain a library-result application step.", index);
    }
    const primitive = PRIMITIVE_BY_ID.get(recorded.moveId);
    if (
      primitive === undefined ||
      primitive.implementation.operationKind !== recorded.operation.kind
    ) {
      return failed(`Step ${index} is not a hand-authored primitive move.`, index);
    }
    steps.push({
      id: `step-${index + 1}`,
      moveId: primitive.id,
      // The hand-authored primitives are exactly the kernel primitives; construction moves are
      // not in this catalog.
      operationKind: primitive.implementation.operationKind as KernelOperationKind,
      selections: recorded.selections.map((selection) => structuredClone(selection)),
      parameters: recorded.parameters.map((parameter) => structuredClone(parameter)),
      operation: structuredClone(recorded.operation),
    });
  }
  const first = stepsInput[0] as RecordedStep;
  const primitive = PRIMITIVE_BY_ID.get(first.moveId) as MoveDefinition;
  const slotIds = new Set(primitive.selectionContract.slots.map(({ id }) => id));
  const patterns = first.selections
    .filter((selection) => slotIds.has(selection.slotId))
    .map((selection) => ({
      id: `pattern:${selection.slotId}`,
      selectionSlotId: selection.slotId,
      expression: selection.fragment,
    }));
  const candidate = {
    id: metadata.id,
    name: metadata.name,
    description: metadata.description,
    selectionContract: { slots: primitive.selectionContract.slots, allowAdditional: false },
    patterns,
    contextRequirements: primitive.contextRequirements,
    sideConditions: primitive.sideConditions,
    parameters: primitive.parameters,
    requiredArtifacts: [],
    plan: { kind: "deterministic-plan", steps },
    transitionClass: composeTransitionClasses(
      steps.map((step) => declaredTransitionClass(step.operationKind)),
    ),
    examples: metadata.examples ?? [],
    ...(metadata.discoveryContext === undefined
      ? {}
      : { discoveryContext: metadata.discoveryContext }),
  };
  const parsed = authoredMoveTemplateSchema.safeParse(candidate);
  return parsed.success
    ? { ok: true, template: parsed.data }
    : failed(parsed.error.issues[0]?.message ?? "The macro template is invalid.");
}

export type RecordedExampleInput = Readonly<{
  id: string;
  description: string;
  /** The state the recording started from. */
  state: ExecutableProofState;
  /** The state after the last recorded step. */
  finalState: ExecutableProofState;
  steps: readonly RecordedStep[];
  transitionClass: TransitionClass;
  operators?: readonly OperatorDeclaration[];
  results?: KernelEnvironment["results"];
}>;

/**
 * A positive example that replays a recording on the state it came from: the first step's recorded
 * selections as the user's selections, its menu choices picked by recorded value, and the recorded
 * final state's conclusions as the expected outcome. Undefined when the choices cannot be rebuilt.
 */
export function recordedMacroExample(input: RecordedExampleInput): AuthoredExample | undefined {
  const first = input.steps[0];
  if (first === undefined) return undefined;
  const primitive = PRIMITIVE_BY_ID.get(first.moveId);
  if (primitive === undefined) return undefined;
  const selections: Record<string, MoveSelectionInput> = {};
  for (const selection of first.selections) {
    const anchor = {
      target: selection.target,
      statement:
        selection.statement.role === "conclusion"
          ? ({ kind: "conclusion" } as const)
          : ({ kind: "hypothesis", id: selection.statement.id } as const),
    };
    selections[selection.slotId] =
      selection.occurrence.kind === "exact"
        ? { kind: "exact", anchor: anchor as never, path: selection.occurrence.path }
        : {
            kind: "associative",
            anchor: anchor as never,
            containerPath: selection.occurrence.containerPath,
            startOperand: selection.occurrence.startOperand,
            endOperand: selection.occurrence.endOperand,
          };
  }
  const environment: KernelEnvironment = {
    operators: input.operators ?? [],
    ...(input.results === undefined ? {} : { results: input.results }),
  };
  const choices: Record<string, string> = {};
  const correspondence: Correspondence = { symbols: new Map(), ids: new Map() };
  const generator = commandIdGenerator("authoring:recorded-example");
  for (let round = 0; round <= first.parameters.length + 1; round += 1) {
    const menus = generateParameterMenus(
      input.state,
      primitive,
      selections as MoveSelections,
      environment,
      {
        menuChoices: choices,
        idGenerator: generator,
      },
    );
    if (!menus.ok) return undefined;
    if (menus.pendingParameters.length === 0) break;
    for (const parameterId of menus.pendingParameters) {
      const recorded = first.parameters.find((parameter) => parameter.parameterId === parameterId);
      const menu = menus.menus.find((candidate) => candidate.parameterId === parameterId);
      const picked =
        recorded === undefined || menu === undefined
          ? undefined
          : pickItem(menu, recorded, correspondence, input.operators ?? []);
      if (picked === undefined) return undefined;
      choices[parameterId] = picked.item.id;
    }
  }
  const example = {
    id: input.id,
    description: input.description,
    state: structuredClone(input.state) as unknown as Record<string, unknown>,
    selections,
    ...(Object.keys(choices).length === 0 ? {} : { menuChoices: choices }),
    expected: {
      outcome: "applied" as const,
      transitionClass: input.transitionClass,
      goals: input.finalState.goals.map((goal) => goal.sequent.conclusion.expression),
      obligations: input.finalState.obligations.map(
        (obligation) => obligation.sequent.conclusion.expression,
      ),
    },
  };
  const parsed = authoredExampleSchema.safeParse(example);
  return parsed.success ? parsed.data : undefined;
}

/** The move ID brand of a template, for callers that hold a parsed template. */
export function authoredMoveId(template: AuthoredMoveTemplate): MoveId {
  return template.id;
}
