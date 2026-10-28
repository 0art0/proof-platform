/**
 * The move author (`docs/ai-agents-architecture.md` section 5, design plan section 13.3, refinement
 * section 7.1): from one applied move-executor step it proposes a general, reusable move.
 *
 * The model is shown only a minimal, deterministically abstracted situation (see
 * `move-author-situation.ts`), the user's instruction, the kernel primitives a move may be built
 * from (generated from the move catalog) and, on a revision, the previous proposal and the
 * reviewer's feedback. It answers with a proposal in a compact wire form. That proposal is evidence
 * only: `move-author-template.ts` compiles it into a template of the existing authored-move
 * language, the worker runs every example through the kernel, and nothing becomes available until
 * a person has reviewed and approved the draft.
 *
 * This module is self-contained on purpose: `index.ts` composes these schemas into the role's
 * envelope, output validation and evidence, and nothing here depends on `index.ts`.
 */
import { HAND_AUTHORED_MOVES, PARAMETER_MENU_ORIGINS } from "@proof/moves";
import { authoredMoveTemplateSchema } from "@proof/moves/authoring";
import {
  PROBLEM_SETUP_SORT_IDS,
  RESERVED_BUILTIN_SYMBOLS,
  operatorDeclarationSchema,
  plainMathJsonSchema,
  problemSetupSortIdSchema,
  problemSetupSymbolSchema,
  stableIdentifierSchema,
} from "@proof/protocol";
import { z } from "zod";
import {
  EXECUTOR_OPERATION_KINDS,
  MAX_PLAN_STEPS,
  executorFreshIdFields,
  executorResultCardSchema,
  wireMathJsonSchema,
} from "./move-executor-plan";
import { situationSchema } from "./move-author-situation";
import { compileMoveAuthorProposal } from "./move-author-template";

export const MOVE_AUTHOR_MAX_EXAMPLES = 8;
export const MOVE_AUTHOR_MAX_FEEDBACK = 4_000;
const MAX_METAVARIABLES = 16;
const MAX_PREVIOUS_DIAGNOSTICS = 20;

const shortTextSchema = z.string().min(1).max(500);
const labelPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
/** A label the model chooses: a step ID, an example ID. */
const labelSchema = z.string().regex(labelPattern);
/** A reference to a target or hypothesis: a label, or `<step>.<field>[.<n>]` of an earlier step. */
const referenceSchema = stableIdentifierSchema.max(120);
const parameterIdSchema = stableIdentifierSchema.max(120);
const operandPathSchema = z.array(z.number().int().nonnegative()).max(64);

/** How the model classifies what it proposes (refinement section 7.3), honestly. */
export const MOVE_AUTHOR_EXTENSION_KINDS = ["macro", "heuristic", "principle"] as const;
export const moveAuthorExtensionKindSchema = z.enum(MOVE_AUTHOR_EXTENSION_KINDS);
export type MoveAuthorExtensionKind = z.infer<typeof moveAuthorExtensionKindSchema>;

// ---------------------------------------------------------------------------------------------
// The primitives a move may be built from, generated from the move catalog
// ---------------------------------------------------------------------------------------------

/** The kinds of value a plan parameter or an example choice can state. */
export const MOVE_AUTHOR_PARAMETER_KINDS = [
  "index",
  "direction",
  "term",
  "proposition",
  "result",
  "source-hypothesis",
] as const;
export type MoveAuthorParameterKind = (typeof MOVE_AUTHOR_PARAMETER_KINDS)[number];

const PARAMETER_KINDS_BY_ID: Readonly<Record<string, MoveAuthorParameterKind>> = {
  disjunctIndex: "index",
  proposition: "proposition",
  term: "term",
  witness: "term",
  direction: "direction",
  resultId: "result",
  source: "source-hypothesis",
};

/** The kind of value the menu parameter `parameterId` takes, if a proposal can state one. */
export function moveAuthorParameterKind(parameterId: string): MoveAuthorParameterKind | undefined {
  return parameterId.startsWith("instantiation/") && parameterId.length > "instantiation/".length
    ? "term"
    : PARAMETER_KINDS_BY_ID[parameterId];
}

export const primitiveSpecSchema = z
  .object({
    operationKind: z.string().min(1).max(80),
    moveId: stableIdentifierSchema,
    name: shortTextSchema,
    description: z.string().min(1).max(1_000),
    transitionClass: z.enum(["equivalence", "strengthening", "weakening"]),
    /** Whether a proposal can state every menu choice the primitive needs. */
    usable: z.boolean(),
    slots: z
      .array(
        z
          .object({
            id: stableIdentifierSchema,
            role: z.string().min(1),
            semanticRole: z.string().min(1),
            required: z.boolean(),
          })
          .strict(),
      )
      .max(16),
    parameters: z
      .array(
        z
          .object({
            /** A parameter ID; the instantiation of a result is `instantiation/<symbol>`. */
            id: z.string().min(1).max(120),
            label: shortTextSchema,
            source: z.enum(["generated-id", "menu", "selection", "term-input"]),
            /** What a proposal states for a menu parameter; absent for the others. */
            value: z.enum(MOVE_AUTHOR_PARAMETER_KINDS).optional(),
            /** The kinds of origin the items of the parameter's menu carry (from the materializer). */
            origins: z.array(z.string().min(1).max(40)).max(12).optional(),
          })
          .strict(),
      )
      .max(16),
    /** The fields of its operation that hold identifiers it creates, nameable by later steps. */
    createsIdentifiers: z.array(z.string().min(1).max(80)).max(8),
  })
  .strict();
export type PrimitiveSpec = z.infer<typeof primitiveSpecSchema>;

/**
 * The primitives a proposed move may use, generated from the hand-authored move catalog: the
 * operations the move executor may propose. `mark-sorry` and `close-by-accepted-inference` are
 * not among them, so a move never sets a sorry aside or leans on an attestation.
 */
export function describePrimitives(): readonly PrimitiveSpec[] {
  const allowed: ReadonlySet<string> = new Set(EXECUTOR_OPERATION_KINDS);
  return HAND_AUTHORED_MOVES.filter(({ implementation }) =>
    allowed.has(implementation.operationKind),
  ).map((move) => {
    const parameters = move.parameters.map((parameter) => {
      const isMenu = parameter.source === "menu" || parameter.source === "term-input";
      // The instantiation of a result is stated per symbol: `instantiation/<symbol>`.
      const id = parameter.id === "instantiation" ? "instantiation/<symbol>" : parameter.id;
      const value = isMenu
        ? parameter.id === "instantiation"
          ? "term"
          : moveAuthorParameterKind(parameter.id)
        : undefined;
      const origins = isMenu
        ? PARAMETER_MENU_ORIGINS[parameter.id === "instantiation" ? "term" : parameter.id]
        : undefined;
      return {
        id,
        label: parameter.label,
        source: parameter.source,
        ...(value === undefined ? {} : { value }),
        ...(origins === undefined ? {} : { origins: [...origins] }),
      };
    });
    return {
      operationKind: move.implementation.operationKind,
      moveId: move.id,
      name: move.name,
      description: move.description,
      transitionClass: move.transitionClass,
      usable: parameters.every(
        ({ source, value }) =>
          (source !== "menu" && source !== "term-input") || value !== undefined,
      ),
      slots: move.selectionContract.slots.map(({ id, role, semanticRole, required }) => ({
        id,
        role,
        semanticRole,
        required,
      })),
      parameters,
      createsIdentifiers: [...executorFreshIdFields(move.implementation.operationKind)],
    };
  });
}

// ---------------------------------------------------------------------------------------------
// The proposal (the validated, stored form)
// ---------------------------------------------------------------------------------------------

/** A menu parameter value a proposal states, in the platform's kinds. */
const moveAuthorParameterSchema = z.discriminatedUnion("kind", [
  z
    .object({
      parameter: parameterIdSchema,
      kind: z.literal("index"),
      index: z.number().int().min(0).max(64),
    })
    .strict(),
  z
    .object({
      parameter: parameterIdSchema,
      kind: z.literal("direction"),
      direction: z.enum(["forward", "backward"]),
    })
    .strict(),
  z
    .object({
      parameter: parameterIdSchema,
      kind: z.literal("term"),
      expression: plainMathJsonSchema,
    })
    .strict(),
  z
    .object({
      parameter: parameterIdSchema,
      kind: z.literal("proposition"),
      expression: plainMathJsonSchema,
    })
    .strict(),
  z
    .object({
      parameter: parameterIdSchema,
      kind: z.literal("result"),
      resultId: stableIdentifierSchema,
    })
    .strict(),
  z
    .object({
      parameter: parameterIdSchema,
      kind: z.literal("source-hypothesis"),
      hypothesis: referenceSchema,
    })
    .strict(),
]);
export type MoveAuthorParameter = z.infer<typeof moveAuthorParameterSchema>;

const statementRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("conclusion") }).strict(),
  z.object({ kind: z.literal("hypothesis"), label: referenceSchema }).strict(),
]);

const moveAuthorStepSelectionSchema = z
  .object({
    slot: stableIdentifierSchema,
    /** The goal or obligation the selection is in. */
    target: referenceSchema,
    statement: statementRefSchema,
    /** Where the selected subexpression is inside the statement; empty for the statement itself. */
    path: operandPathSchema,
    /** The expression found there, written with metavariables. */
    fragment: plainMathJsonSchema,
  })
  .strict();

const moveAuthorStepSchema = z
  .object({
    id: labelSchema,
    operationKind: z.string().min(1).max(80),
    selections: z.array(moveAuthorStepSelectionSchema).max(8),
    parameters: z.array(moveAuthorParameterSchema).max(8),
  })
  .strict();

const exampleSelectionSchema = z
  .object({ slot: stableIdentifierSchema, statement: statementRefSchema, path: operandPathSchema })
  .strict();

const moveAuthorExampleStateSchema = z
  .object({
    declarations: z
      .array(
        z.object({ symbol: problemSetupSymbolSchema, sort: problemSetupSortIdSchema }).strict(),
      )
      .max(32),
    hypotheses: z
      .array(z.object({ label: referenceSchema, expression: plainMathJsonSchema }).strict())
      .max(16),
    conclusion: plainMathJsonSchema,
  })
  .strict();

const expectedSchema = z
  .object({
    transitionClass: z.enum(["equivalence", "strengthening", "weakening"]),
    goals: z.array(plainMathJsonSchema).max(16),
    obligations: z.array(plainMathJsonSchema).max(16),
  })
  .strict();

export const moveAuthorExampleSchema = z
  .object({
    id: labelSchema,
    description: z.string().min(1).max(400),
    outcome: z.enum(["applied", "rejected"]),
    /**
     * The example is the situation the step was applied to. Its state and expected outcome are not
     * the model's: the platform supplies the abstracted before and after.
     */
    source: z.boolean(),
    state: moveAuthorExampleStateSchema.optional(),
    selections: z.array(exampleSelectionSchema).min(1).max(8),
    /** The menu choices of the first step that the user would make, stated by value. */
    choices: z.array(moveAuthorParameterSchema).max(8),
    expected: expectedSchema.optional(),
  })
  .strict()
  .superRefine((example, context) => {
    const problem = (message: string, path: string) =>
      context.addIssue({ code: "custom", message, path: [path] });
    if (example.source) {
      if (example.outcome !== "applied")
        problem("The source situation is a positive example.", "outcome");
      if (example.state !== undefined)
        problem("The source situation's state is supplied.", "state");
      if (example.expected !== undefined) {
        problem("The source situation's outcome is supplied.", "expected");
      }
      return;
    }
    if (example.state === undefined)
      problem("An independent example states its situation.", "state");
    if (example.outcome === "applied" && example.expected === undefined) {
      problem("A positive example states what the move leaves.", "expected");
    }
    if (example.outcome === "rejected" && example.expected !== undefined) {
      problem("A negative example states no outcome.", "expected");
    }
  });
export type MoveAuthorExample = z.infer<typeof moveAuthorExampleSchema>;

export const moveAuthorProposalSchema = z
  .object({
    kind: z.literal("move-proposal"),
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(2_000),
    /** How the situation motivated this move (design plan section 13.3). */
    motivation: z.string().min(1).max(1_500),
    classification: z
      .object({ kind: moveAuthorExtensionKindSchema, rationale: z.string().min(1).max(800) })
      .strict(),
    transitionClass: z.enum(["equivalence", "strengthening", "weakening"]),
    contextRequirements: z.array(shortTextSchema).max(8),
    sideConditions: z.array(shortTextSchema).max(8),
    requiredResultIds: z.array(stableIdentifierSchema).max(8),
    metavariables: z
      .array(z.object({ name: problemSetupSymbolSchema, sort: problemSetupSortIdSchema }).strict())
      .max(MAX_METAVARIABLES),
    patterns: z
      .array(z.object({ slot: stableIdentifierSchema, expression: plainMathJsonSchema }).strict())
      .min(1)
      .max(8),
    steps: z.array(moveAuthorStepSchema).min(1).max(MAX_PLAN_STEPS),
    examples: z.array(moveAuthorExampleSchema).min(3).max(MOVE_AUTHOR_MAX_EXAMPLES),
  })
  .strict()
  .superRefine((proposal, context) => {
    const unique = (values: readonly string[], label: string, path: string) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          message: `Each ${label} must be unique.`,
          path: [path],
        });
      }
    };
    unique(
      proposal.metavariables.map(({ name }) => name),
      "metavariable",
      "metavariables",
    );
    unique(
      proposal.steps.map(({ id }) => id),
      "step ID",
      "steps",
    );
    unique(
      proposal.examples.map(({ id }) => id),
      "example ID",
      "examples",
    );
    unique(proposal.requiredResultIds, "required result", "requiredResultIds");
    const positives = proposal.examples.filter(({ outcome }) => outcome === "applied");
    const sources = proposal.examples.filter(({ source }) => source);
    if (positives.length < 2) {
      context.addIssue({
        code: "custom",
        message: "A proposal needs at least two positive examples.",
        path: ["examples"],
      });
    }
    if (sources.length !== 1) {
      context.addIssue({
        code: "custom",
        message: "Exactly one example must be the situation the step was applied to.",
        path: ["examples"],
      });
    }
    if (!proposal.examples.some(({ outcome }) => outcome === "rejected")) {
      context.addIssue({
        code: "custom",
        message: "A proposal needs at least one negative example or boundary case.",
        path: ["examples"],
      });
    }
    proposal.steps.slice(1).forEach((step, index) => {
      if (step.selections.length === 0) {
        context.addIssue({
          code: "custom",
          message: "A step after the first is replayed from its selections.",
          path: ["steps", index + 1, "selections"],
        });
      }
    });
  });
export type MoveAuthorProposal = z.infer<typeof moveAuthorProposalSchema>;

// ---------------------------------------------------------------------------------------------
// Other outputs
// ---------------------------------------------------------------------------------------------

const moveAuthorInsufficientContextSchema = z
  .object({
    kind: z.literal("insufficient-context"),
    requestedCategories: z
      .array(z.enum(["situation-detail", "primitive-detail", "library-result"]))
      .min(1)
      .max(3),
    rationale: shortTextSchema,
  })
  .strict();
const moveAuthorDeclinedSchema = z
  .object({ kind: z.literal("declined"), reason: shortTextSchema })
  .strict();

/** What a validated call can output: a proposal, a context request, or a refusal. */
export const moveAuthorOutputSchema = z.union([
  moveAuthorProposalSchema,
  moveAuthorInsufficientContextSchema,
  moveAuthorDeclinedSchema,
]);
export type MoveAuthorOutput = z.infer<typeof moveAuthorOutputSchema>;

// ---------------------------------------------------------------------------------------------
// The context
// ---------------------------------------------------------------------------------------------

/** A deterministic finding about the previous proposal, for the model to repair. */
export const moveAuthorFindingSchema = z
  .object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(600),
    exampleId: z.string().min(1).max(120).optional(),
  })
  .strict();
export type MoveAuthorFinding = z.infer<typeof moveAuthorFindingSchema>;

export const moveAuthorContextSchema = z
  .object({
    /** The stored move-executor call this step came from. */
    executorCallId: stableIdentifierSchema,
    /** The user's own words. */
    instruction: z.string().min(1).max(2_000),
    situation: situationSchema,
    primitives: z.array(primitiveSpecSchema).max(40),
    operators: z.array(operatorDeclarationSchema).max(128),
    results: z.array(executorResultCardSchema).max(32),
    limits: z
      .object({
        maxSteps: z.literal(MAX_PLAN_STEPS),
        maxExamples: z.literal(MOVE_AUTHOR_MAX_EXAMPLES),
      })
      .strict(),
    /** On a revision: the proposal being revised and the reviewer's feedback on it. */
    revision: z
      .object({
        previousCallId: stableIdentifierSchema,
        feedback: z.string().min(1).max(MOVE_AUTHOR_MAX_FEEDBACK),
        previousProposal: moveAuthorProposalSchema,
        /** What the platform's own checks reported about the previous proposal. */
        previousFindings: z.array(moveAuthorFindingSchema).max(MAX_PREVIOUS_DIAGNOSTICS),
      })
      .strict()
      .optional(),
  })
  .strict();
export type MoveAuthorContext = z.infer<typeof moveAuthorContextSchema>;

// ---------------------------------------------------------------------------------------------
// The provider-facing result
// ---------------------------------------------------------------------------------------------

// Strict provider schemas require every property present, so optional fields are nullable and a
// parameter is one flat object whose `kind` says which field matters.
const wireParameterSchema = z
  .object({
    parameter: parameterIdSchema,
    kind: z.enum(MOVE_AUTHOR_PARAMETER_KINDS),
    index: z.number().int().min(0).max(64).nullable(),
    direction: z.enum(["forward", "backward"]).nullable(),
    expression: wireMathJsonSchema.nullable(),
    resultId: stableIdentifierSchema.nullable(),
    hypothesis: referenceSchema.nullable(),
  })
  .strict();
type WireParameter = z.infer<typeof wireParameterSchema>;

const wireStatementSchema = z
  .object({
    statementKind: z.enum(["conclusion", "hypothesis"]),
    statementLabel: referenceSchema.nullable(),
  })
  .strict();

const wireStepSchema = z
  .object({
    id: labelSchema,
    operation: z.string().min(1).max(80),
    selections: z
      .array(
        z
          .object({
            slot: stableIdentifierSchema,
            target: referenceSchema,
            statementKind: z.enum(["conclusion", "hypothesis"]),
            statementLabel: referenceSchema.nullable(),
            path: operandPathSchema,
            fragment: wireMathJsonSchema,
          })
          .strict(),
      )
      .max(8),
    parameters: z.array(wireParameterSchema).max(8),
  })
  .strict();

const wireExampleSelectionsSchema = z
  .array(
    z
      .object({
        slot: stableIdentifierSchema,
        statementKind: wireStatementSchema.shape.statementKind,
        statementLabel: referenceSchema.nullable(),
        path: operandPathSchema,
      })
      .strict(),
  )
  .min(1)
  .max(8);

/**
 * The situation the step was applied to. It has no state, outcome or expected result: the
 * platform supplies them, so the provider schema leaves no room to state them.
 */
const wireSourceExampleSchema = z
  .object({
    id: labelSchema,
    description: z.string().min(1).max(400),
    situation: z.literal("source"),
    selections: wireExampleSelectionsSchema,
    choices: z.array(wireParameterSchema).max(8),
  })
  .strict();

const wireIndependentExampleSchema = z
  .object({
    id: labelSchema,
    description: z.string().min(1).max(400),
    situation: z.literal("independent"),
    outcome: z.enum(["applied", "rejected"]),
    state: z
      .object({
        declarations: z
          .array(
            z.object({ symbol: problemSetupSymbolSchema, sort: problemSetupSortIdSchema }).strict(),
          )
          .max(32),
        hypotheses: z
          .array(z.object({ label: referenceSchema, expression: wireMathJsonSchema }).strict())
          .max(16),
        conclusion: wireMathJsonSchema,
      })
      .strict(),
    selections: wireExampleSelectionsSchema,
    choices: z.array(wireParameterSchema).max(8),
    expected: z
      .object({
        transitionClass: z.enum(["equivalence", "strengthening", "weakening"]),
        goals: z.array(wireMathJsonSchema).max(16),
        obligations: z.array(wireMathJsonSchema).max(16),
      })
      .strict()
      .nullable(),
  })
  .strict();

const wireExampleSchema = z.union([wireSourceExampleSchema, wireIndependentExampleSchema]);

const wireProposalSchema = z
  .object({
    kind: z.literal("move-proposal"),
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(2_000),
    motivation: z.string().min(1).max(1_500),
    classification: z
      .object({ kind: moveAuthorExtensionKindSchema, rationale: z.string().min(1).max(800) })
      .strict(),
    transitionClass: z.enum(["equivalence", "strengthening", "weakening"]),
    contextRequirements: z.array(shortTextSchema).max(8),
    sideConditions: z.array(shortTextSchema).max(8),
    requiredResultIds: z.array(stableIdentifierSchema).max(8),
    metavariables: z
      .array(z.object({ name: problemSetupSymbolSchema, sort: problemSetupSortIdSchema }).strict())
      .max(MAX_METAVARIABLES),
    patterns: z
      .array(z.object({ slot: stableIdentifierSchema, expression: wireMathJsonSchema }).strict())
      .min(1)
      .max(8),
    steps: z.array(wireStepSchema).min(1).max(MAX_PLAN_STEPS),
    examples: z.array(wireExampleSchema).min(3).max(MOVE_AUTHOR_MAX_EXAMPLES),
  })
  .strict();

/** The provider-facing result: strict, nullable-optional, flat parameters. */
export const moveAuthorWireResultSchema = z.union([
  wireProposalSchema,
  moveAuthorInsufficientContextSchema,
  moveAuthorDeclinedSchema,
]);
export type MoveAuthorWireResult = z.infer<typeof moveAuthorWireResultSchema>;

function parameterFromWire(wire: WireParameter): unknown {
  const base = { parameter: wire.parameter, kind: wire.kind };
  switch (wire.kind) {
    case "index":
      return { ...base, index: wire.index };
    case "direction":
      return { ...base, direction: wire.direction };
    case "term":
    case "proposition":
      return { ...base, expression: wire.expression };
    case "result":
      return { ...base, resultId: wire.resultId };
    case "source-hypothesis":
      return { ...base, hypothesis: wire.hypothesis };
  }
}

function statementFromWire(kind: "conclusion" | "hypothesis", label: string | null): unknown {
  return kind === "conclusion" ? { kind } : { kind, label };
}

export type MoveAuthorNormalization =
  Readonly<{ ok: true; output: MoveAuthorOutput }> | Readonly<{ ok: false; message: string }>;

/**
 * Convert a provider result into the validated output. Every deterministic rule runs here: the
 * proposal's shape (two positive examples including the source situation, one negative), then its
 * agreement with the context it was made for (steps, slots, parameters, results, metavariables)
 * and that it compiles to a well-formed template. What the kernel makes of its examples is not
 * decided here: the worker runs them and reports the result with the proposal.
 */
export function normalizeMoveAuthorWireResult(
  wire: MoveAuthorWireResult,
  context: MoveAuthorContext,
): MoveAuthorNormalization {
  if (wire.kind !== "move-proposal") return { ok: true, output: wire };
  const candidate = {
    kind: wire.kind,
    name: wire.name,
    description: wire.description,
    motivation: wire.motivation,
    classification: wire.classification,
    transitionClass: wire.transitionClass,
    contextRequirements: wire.contextRequirements,
    sideConditions: wire.sideConditions,
    requiredResultIds: wire.requiredResultIds,
    metavariables: wire.metavariables,
    patterns: wire.patterns,
    steps: wire.steps.map((step) => ({
      id: step.id,
      operationKind: step.operation,
      selections: step.selections.map((selection) => ({
        slot: selection.slot,
        target: selection.target,
        statement: statementFromWire(selection.statementKind, selection.statementLabel),
        path: selection.path,
        fragment: selection.fragment,
      })),
      parameters: step.parameters.map(parameterFromWire),
    })),
    examples: wire.examples.map((example) => ({
      id: example.id,
      description: example.description,
      ...(example.situation === "source"
        ? { outcome: "applied", source: true }
        : {
            outcome: example.outcome,
            source: false,
            state: example.state,
            ...(example.expected === null ? {} : { expected: example.expected }),
          }),
      selections: example.selections.map((selection) => ({
        slot: selection.slot,
        statement: statementFromWire(selection.statementKind, selection.statementLabel),
        path: selection.path,
      })),
      choices: example.choices.map(parameterFromWire),
    })),
  };
  const parsed = moveAuthorProposalSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at =
      issue === undefined || issue.path.length === 0 ? "" : ` (at ${issue.path.join(".")})`;
    return {
      ok: false,
      message: `The proposal is malformed: ${issue?.message ?? "invalid"}${at}`,
    };
  }
  const problem = proposalProblem(parsed.data, context);
  return problem === undefined
    ? { ok: true, output: parsed.data }
    : { ok: false, message: problem };
}

/** The first way a well-formed proposal disagrees with the context it was made for. */
export function proposalProblem(
  proposal: MoveAuthorProposal,
  context: MoveAuthorContext,
): string | undefined {
  const primitives = new Map(
    context.primitives.map((primitive) => [primitive.operationKind, primitive]),
  );
  const operatorSymbols = new Set(context.operators.map(({ symbol }) => symbol));
  const supplied = new Set(context.results.map(({ id }) => id));
  const unusable = (kind: string) => primitives.get(kind)?.usable !== true;

  for (const variable of proposal.metavariables) {
    if (RESERVED_BUILTIN_SYMBOLS.has(variable.name) || operatorSymbols.has(variable.name)) {
      return `The metavariable ${variable.name} is a built-in symbol or an operator.`;
    }
  }
  for (const id of proposal.requiredResultIds) {
    if (!supplied.has(id)) return `The required result ${id} was not supplied.`;
  }
  if (proposal.steps.length > context.limits.maxSteps) {
    return `A move has at most ${context.limits.maxSteps} steps.`;
  }
  const first = proposal.steps[0];
  const firstSpec = first === undefined ? undefined : primitives.get(first.operationKind);
  for (const [index, step] of proposal.steps.entries()) {
    const spec = primitives.get(step.operationKind);
    if (spec === undefined || unusable(step.operationKind)) {
      return `Step ${step.id} uses ${step.operationKind}, which is not a primitive a move can use.`;
    }
    const slots = new Set(spec.slots.map(({ id }) => id));
    for (const selection of step.selections) {
      if (!slots.has(selection.slot)) {
        return `Step ${step.id} selects ${selection.slot}, which is not a slot of ${step.operationKind}.`;
      }
    }
    const parameters = new Map(spec.parameters.map((parameter) => [parameter.id, parameter]));
    for (const parameter of step.parameters) {
      const declared =
        parameters.get(parameter.parameter) ??
        (parameter.parameter.startsWith("instantiation/")
          ? parameters.get("instantiation/<symbol>")
          : undefined);
      const expected = moveAuthorParameterKind(parameter.parameter);
      if (declared === undefined || expected !== parameter.kind) {
        return `Step ${step.id} gives ${parameter.parameter} as a ${parameter.kind}, which is not a parameter ${step.operationKind} takes in that form.`;
      }
      if (parameter.kind === "result" && !proposal.requiredResultIds.includes(parameter.resultId)) {
        return `Step ${step.id} applies ${parameter.resultId}, which requiredResultIds must list.`;
      }
    }
    if (index === 0) {
      // Only constructions can be fixed by the template; the user makes the other first choices.
      const fixed = step.parameters.find(({ kind }) => kind !== "term" && kind !== "proposition");
      if (fixed !== undefined) {
        return `The first step cannot fix ${fixed.parameter}: the user chooses it when the move is applied, so state it in the examples' choices.`;
      }
    }
  }
  if (firstSpec !== undefined) {
    const slots = new Set(firstSpec.slots.map(({ id }) => id));
    for (const pattern of proposal.patterns) {
      if (!slots.has(pattern.slot)) {
        return `The pattern for ${pattern.slot} is not for a slot of the first step.`;
      }
    }
    for (const example of proposal.examples) {
      for (const selection of example.selections) {
        if (!slots.has(selection.slot)) {
          return `Example ${example.id} selects ${selection.slot}, which is not a slot of the first step.`;
        }
      }
    }
  }
  const compiled = compileMoveAuthorProposal({ proposal, context, withExamples: false });
  const structural = authoredMoveTemplateSchema.safeParse(compiled);
  if (!structural.success) {
    return `The proposal does not make a well-formed template: ${structural.error.issues[0]?.message ?? "invalid"}.`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The system message
// ---------------------------------------------------------------------------------------------

const SORT_LIST = PROBLEM_SETUP_SORT_IDS.join(", ");

export const MOVE_AUTHOR_SYSTEM_MESSAGE = [
  "You turn one applied proof step into a proposal for a general, reusable move. Return only a move proposal, a permitted context request, or a refusal. You never change a proof: the platform runs every example of your proposal through the proof kernel, and a person reviews the proposal before it is added to anything.",
  "CONTEXT. instruction is what the user asked for. situation is the local situation the step was applied to, already abstracted: before is the target sequent (neutral symbol names, only the hypotheses and declarations the step used), selections is what the user had selected, plan is the kernel operations that were applied (their labels name what they introduced), after is what they left. primitives lists the kernel operations a move may be built from: their selection slots, their parameters and the identifiers they create. operators and results are the vocabulary and the approved results you may use. Nothing else about the original problem is available to you.",
  "WHAT A MOVE IS. A move is a template. The user selects something in a proof state; the move is offered when the selection matches a pattern; applying it runs a fixed sequence of primitives. Make it general: it must work in situations that differ from this one in their symbols, their size and the statements around the selection. Every symbol you write in a pattern, fragment or template must be a built-in symbol, an operator from context.operators, or a metavariable listed in metavariables. Never write a symbol of the situation: a move that mentions one applies only where that symbol occurs, and the platform rejects it. A metavariable stands for one whole subexpression (a term or a proposition, matched first-order); it cannot stand for an operator. Give each metavariable a sort from: " +
    SORT_LIST +
    ".",
  "patterns. For each selection slot of the FIRST step that the move should constrain, the expression the selected fragment must match, written with metavariables. The first step is driven by what the user selects.",
  "steps. Between 1 and " +
    String(MAX_PLAN_STEPS) +
    " steps, each one primitive from context.primitives (operation) with a unique id. Do not use a primitive whose usable is false. selections: which slot is filled with what. target names the goal or obligation (in the first step choose a label such as goal and reuse it; in later steps use <step id>.<field> or <step id>.<field>.<n> for an identifier an earlier step created, for example split.childIds.1 is the first target created by the step split, or reuse a label). statementKind and statementLabel say whether the selection is in the conclusion or in a hypothesis (a hypothesis is named by a label you choose, or by <step id>.<field> when an earlier step created it). path is the position of the selected subexpression inside that statement (empty for the whole statement) and fragment is the expression found there, written with metavariables. Every step after the first needs at least one selection; the fragments of later steps are matched against the state the previous step left. parameters: the menu choices a step makes. State only the parameters that context.primitives lists with a value (their source is menu or term-input): kind is that value, and only the field for that kind is filled (index, direction, expression, resultId or hypothesis), the others null. Never state a parameter whose source is selection or generated-id, such as premiseHypothesisIds or premiseTargetIds: the platform fills those itself, matching premises against the state and creating identifiers. A term or proposition value is a TEMPLATE over the metavariables that the platform instantiates by substitution and then checks: this is how a move builds a proposition or term that is not in the proof state, such as the contrapositive of a selected implication. Parameters whose kind is index, direction, result or source-hypothesis are stated by value. The FIRST step may state only term and proposition parameters; the user makes its other choices when applying the move, so give those in the choices of each example, following the same rule: only parameters with a value, never selection or generated-id parameters.",
  "examples. Between 3 and " +
    String(MOVE_AUTHOR_MAX_EXAMPLES) +
    ". Exactly one is the situation the step was applied to: give it situation source with only its id, description, selections and choices; it has no state, outcome or expected, because the platform supplies the abstracted state and what the step left. At least one other positive example (outcome applied, situation independent) must differ in structure from the source, not only in names, with its own declarations (symbol and sort), hypotheses (label and expression) and conclusion, the selections made in it, and expected: the transition class and the conclusions of every goal and obligation that the move leaves, in order, exactly as the kernel will produce them. At least one example is negative or a boundary case (outcome rejected, situation independent, expected null): a state in which the move must not apply, for example because the selection does not match the pattern. An example's selections are only what the user selects to start the move: they fill slots of the FIRST step's primitive and nothing else. The selections of later steps belong in the plan, never in an example; for example a later close-by-hypothesis step's fact slot is never an example selection.",
  "transitionClass. State the class of the whole sequence honestly: equivalence if nothing is lost, strengthening if the new goals are sufficient but may be harder, weakening if they are only implied. The platform computes the class from the kernel and compares.",
  "classification. Say honestly what you propose (refinement section 7.3): macro packages the recorded steps; heuristic is a reusable way of choosing what to do whose success is not guaranteed; principle would add a mathematical result or construction principle that is not available, which a move cannot do by being approved, so say so rather than hide it. requiredResultIds lists the supplied results the steps apply. motivation says how this situation motivated the move. description says what the move does in mathematical language and says if it encapsulates a substantial idea. sideConditions and contextRequirements state when it applies.",
  "A WORKED SHAPE. To prove an implication by its contrapositive: metavariables A and B (proposition). patterns: slot target, expression [Implies, A, B]. One step reduce, operation suffices, selections [slot target, target goal, conclusion, path [], fragment [Implies, A, B]], parameters [proposition, kind proposition, expression [Implies, [Not, B], [Not, A]]]. Expressions are MathJSON: a symbol or number, or [Operator, operand, ...].",
  "When the context contains a revision, apply the feedback and the platform's findings to the previous proposal and return a complete replacement, keeping what they do not change. If the situation lacks what you need, return an insufficient-context request. If you cannot make a general move from this step, return a refusal with the reason instead of guessing.",
].join(" ");

/** The move author message before the source example lost its state (`move-author-v1`). */
export const MOVE_AUTHOR_PREVIOUS_SYSTEM_MESSAGE = [
  "You turn one applied proof step into a proposal for a general, reusable move. Return only a move proposal, a permitted context request, or a refusal. You never change a proof: the platform runs every example of your proposal through the proof kernel, and a person reviews the proposal before it is added to anything.",
  "CONTEXT. instruction is what the user asked for. situation is the local situation the step was applied to, already abstracted: before is the target sequent (neutral symbol names, only the hypotheses and declarations the step used), selections is what the user had selected, plan is the kernel operations that were applied (their labels name what they introduced), after is what they left. primitives lists the kernel operations a move may be built from: their selection slots, their parameters and the identifiers they create. operators and results are the vocabulary and the approved results you may use. Nothing else about the original problem is available to you.",
  "WHAT A MOVE IS. A move is a template. The user selects something in a proof state; the move is offered when the selection matches a pattern; applying it runs a fixed sequence of primitives. Make it general: it must work in situations that differ from this one in their symbols, their size and the statements around the selection. Every symbol you write in a pattern, fragment or template must be a built-in symbol, an operator from context.operators, or a metavariable listed in metavariables. Never write a symbol of the situation: a move that mentions one applies only where that symbol occurs, and the platform rejects it. A metavariable stands for one whole subexpression (a term or a proposition, matched first-order); it cannot stand for an operator. Give each metavariable a sort from: " +
    SORT_LIST +
    ".",
  "patterns. For each selection slot of the FIRST step that the move should constrain, the expression the selected fragment must match, written with metavariables. The first step is driven by what the user selects.",
  "steps. Between 1 and " +
    String(MAX_PLAN_STEPS) +
    " steps, each one primitive from context.primitives (operation) with a unique id. Do not use a primitive whose usable is false. selections: which slot is filled with what. target names the goal or obligation (in the first step choose a label such as goal and reuse it; in later steps use <step id>.<field> or <step id>.<field>.<n> for an identifier an earlier step created, for example split.childIds.1 is the first target created by the step split, or reuse a label). statementKind and statementLabel say whether the selection is in the conclusion or in a hypothesis (a hypothesis is named by a label you choose, or by <step id>.<field> when an earlier step created it). path is the position of the selected subexpression inside that statement (empty for the whole statement) and fragment is the expression found there, written with metavariables. Every step after the first needs at least one selection; the fragments of later steps are matched against the state the previous step left. parameters: the menu choices a step makes. A term or proposition value is a TEMPLATE over the metavariables that the platform instantiates by substitution and then checks: this is how a move builds a proposition or term that is not in the proof state, such as the contrapositive of a selected implication. Parameters whose kind is index, direction, result or source-hypothesis are stated by value. The FIRST step may state only term and proposition parameters; the user makes its other choices when applying the move, so give those in the choices of each example.",
  "examples. Between 3 and " +
    String(MOVE_AUTHOR_MAX_EXAMPLES) +
    ". Exactly one is the situation the step was applied to: give it situation source and outcome applied, with only its selections (and choices); the platform supplies its state and what the step left. At least one other positive example (outcome applied, situation independent) must differ in structure from the source, not only in names, with its own declarations (symbol and sort), hypotheses (label and expression) and conclusion, the selections made in it, and expected: the transition class and the conclusions of every goal and obligation that the move leaves, in order, exactly as the kernel will produce them. At least one example is negative or a boundary case (outcome rejected, situation independent, expected null): a state in which the move must not apply, for example because the selection does not match the pattern. Every example's selections name slots of the first step.",
  "transitionClass. State the class of the whole sequence honestly: equivalence if nothing is lost, strengthening if the new goals are sufficient but may be harder, weakening if they are only implied. The platform computes the class from the kernel and compares.",
  "classification. Say honestly what you propose (refinement section 7.3): macro packages the recorded steps; heuristic is a reusable way of choosing what to do whose success is not guaranteed; principle would add a mathematical result or construction principle that is not available, which a move cannot do by being approved, so say so rather than hide it. requiredResultIds lists the supplied results the steps apply. motivation says how this situation motivated the move. description says what the move does in mathematical language and says if it encapsulates a substantial idea. sideConditions and contextRequirements state when it applies.",
  "A WORKED SHAPE. To prove an implication by its contrapositive: metavariables A and B (proposition). patterns: slot target, expression [Implies, A, B]. One step reduce, operation suffices, selections [slot target, target goal, conclusion, path [], fragment [Implies, A, B]], parameters [proposition, kind proposition, expression [Implies, [Not, B], [Not, A]]]. Expressions are MathJSON: a symbol or number, or [Operator, operand, ...].",
  "When the context contains a revision, apply the feedback and the platform's findings to the previous proposal and return a complete replacement, keeping what they do not change. If the situation lacks what you need, return an insufficient-context request. If you cannot make a general move from this step, return a refusal with the reason instead of guessing.",
].join(" ");
