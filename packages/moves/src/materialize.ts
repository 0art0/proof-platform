/**
 * Parameter menus and operation materialization for moves (design plan §13, §14.5, §17.4;
 * refinement §11).
 *
 * Every input a move needs beyond its selections is chosen from a deterministic menu generated
 * only from the proof-state snapshot, the selections and the kernel environment. A caller never
 * supplies an expression: it names menu item IDs, and materialization regenerates the menus and
 * rejects any ID that is not in them. That rejects stale or fabricated payloads. Menu generation
 * and materialization share one walk over the move, so they cannot disagree.
 *
 * Ordering rules, all deterministic:
 * - Terms: selected fragments first, in selection-contract slot order; then declared symbols in
 *   context order; then in-scope subterms in occurrence order (conclusion first, then hypotheses
 *   in context order, each in preorder). Only terms of the required sort are kept, and structural
 *   duplicates are removed, keeping the first occurrence.
 * - Propositions: selected fragments first; then the conclusion; then the hypotheses; then
 *   proposition subterms in occurrence order.
 * - Results and assumptions: catalog/state order. Rewrite sources: the selected hypothesis first,
 *   then local hypotheses in context order, then approved premise-free results.
 *
 * A menu is dependent when it needs an earlier choice. The instantiation menus depend on the
 * chosen result or assumption, and the equivalence-rewrite direction depends on the chosen source.
 * Such a menu appears only once its prerequisite is chosen.
 */
import {
  alphaEquivalent,
  applyTransition,
  freeResultParameters,
  kernelOperationSchema,
  matchResultConclusion,
  parseKernelResultCatalog,
  type KernelEnvironment,
  type KernelOperation,
  type KernelOperationKind,
  type KernelResult,
  type KernelResultParameter,
  type ResultApplicationDirection,
  type ResultInstantiation,
  type RewriteLens,
  type RewriteSource,
  type TransitionStatementTarget,
  type TransitionTarget,
} from "@proof/kernel";
import {
  createExecutableProofStateSchema,
  freeSymbolNames,
  mathJsonEquals,
  operatorDeclarationsSchema,
  stableIdentifierSchema,
  statementIdSchema,
  substituteMathJson,
  type AdditionalAssumption,
  type ExecutableProofState,
  type Goal,
  type Hypothesis,
  type Obligation,
  type OperatorDeclaration,
  type PlainMathJson,
  type Sort,
  type StatementId,
} from "@proof/mathjson-model";
import { z } from "zod";
import {
  boundSymbolsAtPath,
  dedupeBy,
  expressionAtPath,
  functionParts,
  operatorOperands,
  propositionFilter,
  sortFilter,
  statementOccurrences,
  symbolValue,
} from "./context-terms";
import { HAND_AUTHORED_MOVES, type MoveDefinition } from "./index";

/** Where a selection sits. Extra fields of a resolved selection (fragment, position) are ignored. */
export type MoveSelectionAnchor = Readonly<{
  stateId?: string;
  target: TransitionTarget;
  statement: TransitionStatementTarget;
}>;

export type MoveSelectionInput =
  | Readonly<{ kind: "exact"; anchor: MoveSelectionAnchor; path: readonly number[] }>
  | Readonly<{
      kind: "associative";
      anchor: MoveSelectionAnchor;
      containerPath: readonly number[];
      startOperand: number;
      endOperand: number;
    }>;

/** Selections keyed by the move's selection-slot ID. */
export type MoveSelections = Readonly<Record<string, MoveSelectionInput>>;

/** Menu choices keyed by parameter ID; each value is a menu item ID. */
export type MoveMenuChoices = Readonly<Record<string, string>>;

/**
 * Deterministic fresh IDs. `commandIdGenerator` reproduces the worker's convention, which
 * derives every ID from the command ID.
 */
export type MoveIdGenerator = Readonly<{
  resultStateId: string;
  /** Fresh statement ID for the `index`-th (1-based) ID with this label. */
  statementId: (label: string, index: number) => string;
  /** Fresh additional-assumption ID for the `index`-th (1-based) ID with this label. */
  assumptionId: (label: string, index: number) => string;
}>;

export function commandIdGenerator(commandId: string): MoveIdGenerator {
  return {
    resultStateId: `state:${commandId}`,
    statementId: (label, index) => `statement:${commandId}:${label}:${index}`,
    assumptionId: (label, index) => `assumption:${commandId}:${label}:${index}`,
  };
}

/**
 * The retrieval evidence of a `source: "result"` suggestion: the result and its pattern direction,
 * with the pattern substitutions. Every substitution must be a term that already occurs in the
 * target's context.
 */
export type ResultApplicationSeed = Readonly<{
  resultId: string;
  direction?: ResultApplicationDirection;
  substitutions: readonly Readonly<{ symbol: string; expression: PlainMathJson }>[];
}>;

export type MenuLabel =
  Readonly<{ kind: "text"; text: string }> | Readonly<{ kind: "math"; expression: PlainMathJson }>;

export type MenuItemOrigin =
  | Readonly<{ kind: "selection"; slotId: string }>
  | Readonly<{ kind: "declaration"; declarationId: string }>
  | Readonly<{ kind: "subterm-of"; statement: TransitionStatementTarget; path: readonly number[] }>
  | Readonly<{ kind: "conclusion" }>
  | Readonly<{ kind: "hypothesis"; hypothesisId: string }>
  | Readonly<{ kind: "assumption"; assumptionId: string }>
  | Readonly<{ kind: "result"; resultId: string }>
  | Readonly<{ kind: "attestation" }>
  | Readonly<{ kind: "rule" }>
  | Readonly<{ kind: "generated" }>;

export type MenuValue =
  | Readonly<{ kind: "index"; index: number }>
  | Readonly<{ kind: "term"; expression: PlainMathJson }>
  | Readonly<{ kind: "proposition"; expression: PlainMathJson }>
  | Readonly<{ kind: "direction"; direction: "forward" | "backward" }>
  | Readonly<{ kind: "rewrite-source"; source: RewriteSource }>
  | Readonly<{ kind: "result"; resultId: string }>
  | Readonly<{ kind: "assumption"; assumptionId: string }>
  | Readonly<{ kind: "attestation"; attestationId: string }>
  | Readonly<{ kind: "generated-ids"; ids: readonly string[] }>;

export type ParameterMenuItem = Readonly<{
  /** Stable content-derived ID: equal values in the same parameter always get the same ID. */
  id: string;
  label: MenuLabel;
  value: MenuValue;
  origin: MenuItemOrigin;
}>;

export type ParameterMenu = Readonly<{
  parameterId: string;
  label: string;
  /** Automatic menus (generated IDs) have one item and need no choice. */
  automatic: boolean;
  items: readonly ParameterMenuItem[];
}>;

export type MaterializationDiagnosticCode =
  | "invalid-request"
  | "invalid-environment"
  | "invalid-state"
  | "invalid-selection"
  | "missing-selection"
  | "invalid-choice"
  | "unexpected-choice"
  | "requires-input"
  | "not-applicable"
  | "invalid-operation";

export type MaterializationDiagnostic = Readonly<{
  code: MaterializationDiagnosticCode;
  message: string;
}>;

export type ParameterMenuResult =
  | Readonly<{
      ok: true;
      menus: readonly ParameterMenu[];
      /** Parameters that still need a choice, in walk order. */
      pendingParameters: readonly string[];
      diagnostics: readonly [];
    }>
  | Readonly<{ ok: false; diagnostics: readonly [MaterializationDiagnostic] }>;

export type MaterializationResult =
  | Readonly<{
      ok: true;
      operation: KernelOperation;
      /** The menus as displayed for this materialization, for static history. */
      menus: readonly ParameterMenu[];
      diagnostics: readonly [];
    }>
  | Readonly<{
      ok: false;
      /** Non-empty exactly for `requires-input`. */
      missingParameters: readonly string[];
      diagnostics: readonly [MaterializationDiagnostic];
    }>;

export type ParameterMenuOptions = Readonly<{
  menuChoices?: MoveMenuChoices;
  /** Attestation references the caller recorded for the target (for accepted inferences). */
  attestationIds?: readonly string[];
  resultSeed?: ResultApplicationSeed;
  idGenerator?: MoveIdGenerator;
}>;

/** Generate the deterministic parameter menus of a move for its selections. */
export function generateParameterMenus(
  state: ExecutableProofState,
  move: MoveDefinition,
  selections: MoveSelections,
  env: KernelEnvironment = {},
  options: ParameterMenuOptions = {},
): ParameterMenuResult {
  const walked = runWalk(state, move, selections, env, options);
  if (!walked.ok) return walked;
  const { walk } = walked;
  const error = walk.errors[0];
  if (error !== undefined) return { ok: false, diagnostics: [error] };
  return freezeDetached({
    ok: true as const,
    menus: walk.menus,
    pendingParameters: walk.missing,
    diagnostics: [] as const,
  });
}

export type MaterializeMoveRequest = Readonly<{
  state: ExecutableProofState;
  move: MoveDefinition;
  selections: MoveSelections;
  menuChoices?: MoveMenuChoices;
  idGenerator: MoveIdGenerator;
  env?: KernelEnvironment;
  attestationIds?: readonly string[];
  resultSeed?: ResultApplicationSeed;
}>;

/**
 * Build the complete kernel operation of a move from its selections and menu choices. The
 * operation is not applied; the caller previews it through `planMove`.
 */
export function materializeMoveOperation(request: MaterializeMoveRequest): MaterializationResult {
  const walked = runWalk(request.state, request.move, request.selections, request.env ?? {}, {
    ...(request.menuChoices === undefined ? {} : { menuChoices: request.menuChoices }),
    ...(request.attestationIds === undefined ? {} : { attestationIds: request.attestationIds }),
    ...(request.resultSeed === undefined ? {} : { resultSeed: request.resultSeed }),
    idGenerator: request.idGenerator,
  });
  if (!walked.ok) return { ok: false, missingParameters: [], diagnostics: walked.diagnostics };
  const { walk, context } = walked;
  const error = walk.errors[0];
  if (error !== undefined) return { ok: false, missingParameters: [], diagnostics: [error] };
  const empty = walk.empty[0];
  if (empty !== undefined) {
    return materializationFailure(
      "not-applicable",
      `No item in the current context is available for ${empty}.`,
    );
  }
  if (walk.missing.length > 0) {
    return {
      ok: false,
      missingParameters: [...walk.missing],
      diagnostics: [
        {
          code: "requires-input",
          message: `Choose a menu item for: ${walk.missing.join(", ")}.`,
        },
      ],
    };
  }
  if (walk.fields === undefined) {
    return materializationFailure("invalid-operation", "The move could not be materialized.");
  }
  const parsed = kernelOperationSchema.safeParse({
    kind: context.kind,
    expectedStateId: context.state.id,
    resultStateId: request.idGenerator.resultStateId,
    target: context.target,
    ...walk.fields,
  });
  if (!parsed.success) {
    return materializationFailure(
      "invalid-operation",
      "The materialized operation does not match the kernel operation schema.",
    );
  }
  const detached = freezeDetached({
    ok: true as const,
    operation: parsed.data,
    menus: walk.menus,
    diagnostics: [] as const,
  });
  return (
    detached ??
    materializationFailure("invalid-operation", "The operation could not be detached safely.")
  );
}

export type ResultApplicationRequest = Readonly<{
  state: ExecutableProofState;
  resultId: string;
  direction: ResultApplicationDirection;
  target: TransitionTarget;
  substitutions: readonly Readonly<{ symbol: string; expression: PlainMathJson }>[];
  /**
   * The selected occurrence the suggestion matched. When the result is a premise-free equivalence,
   * the suggestion is a rewrite of this occurrence, not an application to the whole target.
   */
  occurrence?: MoveSelectionInput;
  menuChoices?: MoveMenuChoices;
}>;

/**
 * Turn a retrieval `source: "result"` suggestion into a kernel operation. It returns either
 * `apply-result-backward` (the target conclusion is matched against the result conclusion) or
 * `apply-result-forward` (premises are matched against local hypotheses; unmet premises become
 * obligations), or `rewrite-with-equivalence` for a premise-free equivalence with an occurrence.
 * Parameters that neither the conclusion, the hypotheses, nor the substitutions determine are
 * returned as `missingParameters` (`instantiation/<symbol>`), to be chosen from menus.
 */
export function materializeResultApplication(
  request: ResultApplicationRequest,
  env: KernelEnvironment,
  idGenerator: MoveIdGenerator,
): MaterializationResult {
  const operators = operatorDeclarationsSchema.safeParse(env.operators ?? []);
  if (!operators.success) {
    return materializationFailure("invalid-environment", "The operator environment is invalid.");
  }
  const catalog = parseKernelResultCatalog(env.results ?? [], operators.data);
  if (!catalog.ok) {
    return materializationFailure("invalid-environment", catalog.issue.message);
  }
  const result = catalog.results.find((candidate) => candidate.id === request.resultId);
  if (result === undefined) {
    return materializationFailure("invalid-request", "The result is not in the environment.");
  }
  const seed: ResultApplicationSeed = {
    resultId: request.resultId,
    direction: request.direction,
    substitutions: request.substitutions,
  };
  const rewrite =
    request.occurrence !== undefined &&
    result.premises.length === 0 &&
    operatorOperands(result.conclusion.expression, "Equivalent")?.length === 2;
  const moveId = rewrite
    ? "move:rewrite-with-equivalence"
    : `move:apply-result-${request.direction}`;
  const move = HAND_AUTHORED_MOVES.find((candidate) => candidate.id === moveId);
  if (move === undefined) {
    return materializationFailure("invalid-request", "The result-application move is missing.");
  }
  const selections: MoveSelections =
    rewrite && request.occurrence !== undefined
      ? { occurrence: request.occurrence }
      : {
          target: {
            kind: "exact",
            anchor: { target: request.target, statement: { kind: "conclusion" } },
            path: [],
          },
        };
  if (rewrite && request.occurrence !== undefined) {
    const anchorTarget = request.occurrence.anchor.target;
    if (anchorTarget.kind !== request.target.kind || anchorTarget.id !== request.target.id) {
      return materializationFailure(
        "invalid-selection",
        "The occurrence must belong to the suggestion's target.",
      );
    }
  }
  return materializeMoveOperation({
    state: request.state,
    move,
    selections,
    idGenerator,
    env,
    resultSeed: seed,
    ...(request.menuChoices === undefined ? {} : { menuChoices: request.menuChoices }),
  });
}

type ResolvedSelection = Readonly<{
  slotId: string;
  statement: TransitionStatementTarget;
  path: readonly number[];
  lens?: RewriteLens;
  fragment: PlainMathJson;
  /** Symbols bound by binders enclosing the selection. */
  bound: ReadonlySet<string>;
}>;

type TargetEntry = Goal | Obligation;

type Context = Readonly<{
  state: ExecutableProofState;
  kind: KernelOperationKind;
  slotOrder: readonly string[];
  operators: readonly OperatorDeclaration[];
  results: readonly KernelResult[];
  environment: KernelEnvironment;
  target: TransitionTarget;
  entry: TargetEntry;
  selections: ReadonlyMap<string, ResolvedSelection>;
  choices: MoveMenuChoices;
  seed?: ResultApplicationSeed;
  attestationIds: readonly string[];
  idGenerator?: MoveIdGenerator;
}>;

type Walk = {
  menus: ParameterMenu[];
  missing: string[];
  empty: string[];
  errors: MaterializationDiagnostic[];
  used: Set<string>;
  fields?: Readonly<Record<string, unknown>>;
};

type WalkOutcome =
  | Readonly<{ ok: true; walk: Walk; context: Context }>
  | Readonly<{ ok: false; diagnostics: readonly [MaterializationDiagnostic] }>;

function runWalk(
  stateInput: ExecutableProofState,
  move: MoveDefinition,
  selectionsInput: MoveSelections,
  env: KernelEnvironment,
  options: ParameterMenuOptions,
): WalkOutcome {
  try {
    const operators = operatorDeclarationsSchema.safeParse(env.operators ?? []);
    if (!operators.success) {
      return walkFailure("invalid-environment", "The operator environment is invalid.");
    }
    const catalog = parseKernelResultCatalog(env.results ?? [], operators.data);
    if (!catalog.ok) return walkFailure("invalid-environment", catalog.issue.message);
    const parsedState = createExecutableProofStateSchema({ operators: operators.data }).safeParse(
      stateInput,
    );
    if (!parsedState.success) {
      return walkFailure("invalid-state", "The input is not an executable proof state.");
    }
    const state = parsedState.data as ExecutableProofState;
    if (move.implementation.kind !== "deterministic-kernel-primitive") {
      return walkFailure("invalid-request", "Only kernel-primitive moves have parameter menus.");
    }
    const choices = parseChoices(options.menuChoices ?? {});
    if (choices === undefined) {
      return walkFailure("invalid-request", "Menu choices must map parameter IDs to item IDs.");
    }
    const attestationIds = options.attestationIds ?? [];
    if (!attestationIds.every((id) => stableIdentifierSchema.safeParse(id).success)) {
      return walkFailure("invalid-request", "Attestation references must be stable identifiers.");
    }

    const slotOrder = move.selectionContract.slots.map((slot) => slot.id);
    const rawSelections = Object.entries(selectionsInput);
    if (rawSelections.length === 0) {
      return walkFailure("missing-selection", "A move needs at least one selection.");
    }
    const parsedSelections = new Map<string, z.infer<typeof selectionSchema>>();
    for (const [slotId, value] of rawSelections) {
      if (!slotOrder.includes(slotId)) {
        return walkFailure("invalid-selection", `The move has no selection slot ${slotId}.`);
      }
      const parsed = selectionSchema.safeParse(value);
      if (!parsed.success) {
        return walkFailure("invalid-selection", `The selection for slot ${slotId} is invalid.`);
      }
      if (parsed.data.anchor.stateId !== undefined && parsed.data.anchor.stateId !== state.id) {
        return walkFailure("invalid-selection", "A selection belongs to another proof state.");
      }
      parsedSelections.set(slotId, parsed.data);
    }
    const anchorSlot = parsedSelections.has("target")
      ? "target"
      : slotOrder.find((slotId) => parsedSelections.has(slotId));
    const anchorTarget =
      anchorSlot === undefined ? undefined : parsedSelections.get(anchorSlot)?.anchor.target;
    if (anchorTarget === undefined) {
      return walkFailure("missing-selection", "No selection identifies a target.");
    }
    const target: TransitionTarget = { kind: anchorTarget.kind, id: anchorTarget.id };
    const collection = target.kind === "goal" ? state.goals : state.obligations;
    const entry = collection.find((candidate) => candidate.id === target.id);
    if (entry === undefined) {
      return walkFailure("invalid-selection", "The selected target does not exist.");
    }
    const selections = new Map<string, ResolvedSelection>();
    for (const [slotId, selection] of parsedSelections) {
      if (
        selection.anchor.target.kind !== target.kind ||
        selection.anchor.target.id !== target.id
      ) {
        return walkFailure("invalid-selection", "Every selection must belong to one target.");
      }
      const resolved = resolveSelection(slotId, selection, entry, operators.data);
      if (resolved === undefined) {
        return walkFailure(
          "invalid-selection",
          `The selection for slot ${slotId} does not address the target.`,
        );
      }
      selections.set(slotId, resolved);
    }

    const context: Context = {
      state,
      kind: move.implementation.operationKind,
      slotOrder,
      operators: operators.data,
      results: catalog.results,
      environment: { operators: operators.data, results: catalog.results },
      target,
      entry,
      selections,
      choices,
      ...(options.resultSeed === undefined ? {} : { seed: options.resultSeed }),
      attestationIds,
      ...(options.idGenerator === undefined ? {} : { idGenerator: options.idGenerator }),
    };
    if (context.seed !== undefined && !seedIsFromContext(context, context.seed)) {
      return walkFailure(
        "invalid-request",
        "Every suggestion substitution must be a term that occurs in the target's context.",
      );
    }
    const walk: Walk = { menus: [], missing: [], empty: [], errors: [], used: new Set() };
    const fields = walkMove(context, walk);
    if (walk.errors.length === 0 && walk.missing.length === 0) {
      const unexpected = Object.keys(choices).find((parameterId) => !walk.used.has(parameterId));
      if (unexpected !== undefined) {
        walk.errors.push({
          code: "unexpected-choice",
          message: `The move has no menu for parameter ${unexpected}.`,
        });
      }
    }
    if (fields !== undefined) walk.fields = fields;
    return { ok: true, walk, context };
  } catch {
    return walkFailure("invalid-request", "The move inputs could not be inspected safely.");
  }
}

const anchorSchema = z.object({
  stateId: z.string().optional(),
  target: z.object({ kind: z.enum(["goal", "obligation"]), id: statementIdSchema }),
  statement: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("conclusion") }),
    z.object({ kind: z.literal("hypothesis"), id: statementIdSchema }),
  ]),
});
const operandIndexSchema = z.number().int().nonnegative();
// Not strict: resolved selections carry their fragment and position, which are recomputed here.
const selectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), anchor: anchorSchema, path: z.array(operandIndexSchema) }),
  z.object({
    kind: z.literal("associative"),
    anchor: anchorSchema,
    containerPath: z.array(operandIndexSchema),
    startOperand: operandIndexSchema,
    endOperand: operandIndexSchema,
  }),
]);

function parseChoices(value: unknown): MoveMenuChoices | undefined {
  const parsed = z.record(z.string().min(1), z.string().min(1)).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function resolveSelection(
  slotId: string,
  selection: z.infer<typeof selectionSchema>,
  entry: TargetEntry,
  operators: readonly OperatorDeclaration[],
): ResolvedSelection | undefined {
  const statementAnchor = selection.anchor.statement;
  const statement: TransitionStatementTarget =
    statementAnchor.kind === "conclusion"
      ? { kind: "conclusion" }
      : { kind: "hypothesis", id: statementAnchor.id };
  const expression = statementExpression(entry, statement);
  if (expression === undefined) return undefined;
  if (selection.kind === "exact") {
    const fragment = expressionAtPath(expression, selection.path);
    const bound = boundSymbolsAtPath(expression, selection.path, operators);
    if (fragment === undefined || bound === undefined) return undefined;
    return { slotId, statement, path: [...selection.path], fragment, bound };
  }
  const container = expressionAtPath(expression, selection.containerPath);
  const parts = container === undefined ? undefined : functionParts(container);
  const bound = boundSymbolsAtPath(expression, selection.containerPath, operators);
  if (
    parts === undefined ||
    bound === undefined ||
    selection.endOperand > parts.operands.length ||
    selection.endOperand - selection.startOperand < 2
  ) {
    return undefined;
  }
  return {
    slotId,
    statement,
    path: [...selection.containerPath],
    lens: { startOperand: selection.startOperand, endOperand: selection.endOperand },
    fragment: parts.rebuild(parts.operands.slice(selection.startOperand, selection.endOperand)),
    bound,
  };
}

function statementExpression(
  entry: TargetEntry,
  statement: TransitionStatementTarget,
): PlainMathJson | undefined {
  if (statement.kind === "conclusion") return entry.sequent.conclusion.expression;
  return entry.sequent.context.hypotheses.find((candidate) => candidate.id === statement.id)
    ?.statement.expression;
}

function contextStatements(
  context: Context,
): readonly Readonly<{ statement: TransitionStatementTarget; expression: PlainMathJson }>[] {
  return [
    { statement: { kind: "conclusion" }, expression: context.entry.sequent.conclusion.expression },
    ...context.entry.sequent.context.hypotheses.map((hypothesis) => ({
      statement: { kind: "hypothesis" as const, id: hypothesis.id },
      expression: hypothesis.statement.expression,
    })),
  ];
}

function seedIsFromContext(context: Context, seed: ResultApplicationSeed): boolean {
  const available: PlainMathJson[] = [
    ...context.entry.sequent.context.declarations.map((declaration) => declaration.symbol),
    ...statementOccurrences(contextStatements(context), context.operators).map(
      (occurrence) => occurrence.expression,
    ),
  ];
  return seed.substitutions.every((substitution) =>
    available.some((expression) => mathJsonEquals(expression, substitution.expression)),
  );
}

/** Walk the move, generating and consuming menus; returns the operation fields when complete. */
function walkMove(context: Context, walk: Walk): Readonly<Record<string, unknown>> | undefined {
  switch (context.kind) {
    case "close-true":
    case "close-reflexive-equality":
    case "introduce-universal":
      return {};
    case "close-by-hypothesis": {
      const hypothesisId = selectedHypothesis(context, walk, "fact");
      return hypothesisId === undefined ? undefined : { hypothesisId };
    }
    case "close-false-hypothesis": {
      const hypothesisId = selectedHypothesis(context, walk, "false");
      return hypothesisId === undefined ? undefined : { hypothesisId };
    }
    case "close-by-contradiction": {
      const hypothesisId = selectedHypothesis(context, walk, "fact");
      const negationHypothesisId = selectedHypothesis(context, walk, "negation");
      return hypothesisId === undefined || negationHypothesisId === undefined
        ? undefined
        : { hypothesisId, negationHypothesisId };
    }
    case "drop-hypothesis": {
      const hypothesisId = selectedHypothesis(context, walk, "dropped");
      return hypothesisId === undefined ? undefined : { hypothesisId };
    }
    case "close-by-accepted-inference": {
      const chosen = choose(
        context,
        walk,
        menu(
          "attestationId",
          "Attestation",
          context.attestationIds.map((attestationId) =>
            menuItem(
              "attestationId",
              { kind: "attestation", attestationId },
              { kind: "text", text: attestationId },
              { kind: "attestation" },
            ),
          ),
        ),
      );
      return chosen?.value.kind === "attestation"
        ? { attestationId: chosen.value.attestationId }
        : undefined;
    }
    case "introduce-implication":
    case "introduce-negation": {
      const ids = generated(context, walk, "hypothesisId", "statement", "hypothesis", 1);
      return ids === undefined ? undefined : { hypothesisId: ids[0] };
    }
    case "split-goal-conjunction": {
      const count = operatorOperands(context.entry.sequent.conclusion.expression, "And")?.length;
      if (count === undefined) return notApplicable(walk, "The target is not a conjunction.");
      const childIds = generated(context, walk, "childIds", "statement", "child", count);
      return childIds === undefined ? undefined : { childIds };
    }
    case "expand-hypothesis-conjunction": {
      const hypothesisId = selectedHypothesis(context, walk, "conjunction");
      if (hypothesisId === undefined) return undefined;
      const count = hypothesisOperandCount(context, hypothesisId, "And");
      if (count === undefined) return notApplicable(walk, "The hypothesis is not a conjunction.");
      const expandedHypothesisIds = generated(
        context,
        walk,
        "expandedHypothesisIds",
        "statement",
        "expanded-hypothesis",
        count,
      );
      return expandedHypothesisIds === undefined
        ? undefined
        : { hypothesisId, expandedHypothesisIds };
    }
    case "split-hypothesis-disjunction": {
      const hypothesisId = selectedHypothesis(context, walk, "disjunction");
      if (hypothesisId === undefined) return undefined;
      const count = hypothesisOperandCount(context, hypothesisId, "Or");
      if (count === undefined) return notApplicable(walk, "The hypothesis is not a disjunction.");
      const childIds = generated(context, walk, "childIds", "statement", "child", count);
      const branchHypothesisIds = generated(
        context,
        walk,
        "branchHypothesisIds",
        "statement",
        "branch-hypothesis",
        count,
      );
      return childIds === undefined || branchHypothesisIds === undefined
        ? undefined
        : { hypothesisId, childIds, branchHypothesisIds };
    }
    case "apply-implication-hypothesis": {
      const implicationHypothesisId = selectedHypothesis(context, walk, "implication");
      const antecedentHypothesisId = selectedHypothesis(context, walk, "antecedent");
      const ids = generated(
        context,
        walk,
        "resultHypothesisId",
        "statement",
        "result-hypothesis",
        1,
      );
      return implicationHypothesisId === undefined ||
        antecedentHypothesisId === undefined ||
        ids === undefined
        ? undefined
        : { implicationHypothesisId, antecedentHypothesisId, resultHypothesisId: ids[0] };
    }
    case "unpack-existential-hypothesis": {
      const hypothesisId = selectedHypothesis(context, walk, "existential");
      const ids = generated(
        context,
        walk,
        "resultHypothesisId",
        "statement",
        "result-hypothesis",
        1,
      );
      return hypothesisId === undefined || ids === undefined
        ? undefined
        : { hypothesisId, resultHypothesisId: ids[0] };
    }
    case "choose-goal-disjunct": {
      const disjuncts = operatorOperands(context.entry.sequent.conclusion.expression, "Or") ?? [];
      const chosen = choose(
        context,
        walk,
        menu(
          "disjunctIndex",
          "Disjunct",
          disjuncts.map((disjunct, index) =>
            menuItem(
              "disjunctIndex",
              { kind: "index", index },
              { kind: "math", expression: disjunct },
              { kind: "subterm-of", statement: { kind: "conclusion" }, path: [index] },
            ),
          ),
        ),
      );
      return chosen?.value.kind === "index" ? { disjunctIndex: chosen.value.index } : undefined;
    }
    case "split-classical-cases": {
      const proposition = chooseProposition(context, walk, "Case proposition");
      const childIds = generated(context, walk, "childIds", "statement", "child", 2);
      const branchHypothesisIds = generated(
        context,
        walk,
        "branchHypothesisIds",
        "statement",
        "branch-hypothesis",
        2,
      );
      return proposition === undefined ||
        childIds === undefined ||
        branchHypothesisIds === undefined
        ? undefined
        : { proposition, childIds, branchHypothesisIds };
    }
    case "assume-hypothesis": {
      const proposition = chooseProposition(context, walk, "Assumed proposition");
      const ids = generated(context, walk, "hypothesisId", "statement", "hypothesis", 1);
      return proposition === undefined || ids === undefined
        ? undefined
        : { proposition, hypothesisId: ids[0] };
    }
    case "replace-goal": {
      const proposition = chooseProposition(context, walk, "Replacement conclusion", true);
      return proposition === undefined ? undefined : { proposition };
    }
    case "suffices": {
      const proposition = chooseProposition(context, walk, "Sufficient proposition");
      const ids = generated(context, walk, "obligationId", "statement", "obligation", 1);
      return proposition === undefined || ids === undefined
        ? undefined
        : { proposition, obligationId: ids[0] };
    }
    case "instantiate-universal-hypothesis": {
      const hypothesisId = selectedHypothesis(context, walk, "universal");
      if (hypothesisId === undefined) return undefined;
      const quantified = quantifierSort(
        context,
        statementExpression(context.entry, { kind: "hypothesis", id: hypothesisId }),
        "ForAll",
      );
      if (quantified === undefined) {
        return notApplicable(walk, "The hypothesis is not a universal statement.");
      }
      const term = chooseTerm(context, walk, "term", "Instantiation term", quantified);
      const ids = generated(
        context,
        walk,
        "resultHypothesisId",
        "statement",
        "result-hypothesis",
        1,
      );
      return term === undefined || ids === undefined
        ? undefined
        : { hypothesisId, term, resultHypothesisId: ids[0] };
    }
    case "choose-existential-witness": {
      const quantified = quantifierSort(
        context,
        context.entry.sequent.conclusion.expression,
        "Exists",
      );
      if (quantified === undefined) {
        return notApplicable(walk, "The target conclusion is not existential.");
      }
      const witness = chooseTerm(context, walk, "witness", "Witness term", quantified);
      return witness === undefined ? undefined : { witness };
    }
    case "rewrite-with-equality":
      return rewriteWithEquality(context, walk);
    case "rewrite-with-equivalence":
    case "rewrite-with-implication":
      return deepRewrite(context, walk, context.kind);
    case "apply-result-backward":
      return applyResultBackward(context, walk);
    case "apply-result-forward":
      return applyResultForward(context, walk);
    case "mark-sorry": {
      const ids = generated(context, walk, "assumptionId", "assumption", "sorry", 1);
      return ids === undefined ? undefined : { assumptionId: ids[0] };
    }
    case "close-by-assumption":
      return closeByAssumption(context, walk);
  }
}

function selectedHypothesis(context: Context, walk: Walk, slotId: string): StatementId | undefined {
  const selection = context.selections.get(slotId);
  if (selection?.statement.kind !== "hypothesis") {
    walk.errors.push({
      code: "missing-selection",
      message: `The ${slotId} slot needs a selected hypothesis.`,
    });
    return undefined;
  }
  return selection.statement.id;
}

function hypothesisOperandCount(
  context: Context,
  hypothesisId: StatementId,
  operator: "And" | "Or",
): number | undefined {
  const expression = statementExpression(context.entry, { kind: "hypothesis", id: hypothesisId });
  return expression === undefined ? undefined : operatorOperands(expression, operator)?.length;
}

function notApplicable(walk: Walk, message: string): undefined {
  walk.errors.push({ code: "not-applicable", message });
  return undefined;
}

/** The sort of a built-in quantifier's bound symbol, from the target's declarations. */
function quantifierSort(
  context: Context,
  expression: PlainMathJson | undefined,
  quantifier: "ForAll" | "Exists",
): Sort | undefined {
  const operands = expression === undefined ? undefined : operatorOperands(expression, quantifier);
  const symbol = operands?.length === 2 ? symbolValue(operands[0] as PlainMathJson) : undefined;
  return context.entry.sequent.context.declarations.find(
    (declaration) => declaration.symbol === symbol,
  )?.sort;
}

function menu(
  parameterId: string,
  label: string,
  items: readonly ParameterMenuItem[],
  automatic = false,
): ParameterMenu {
  const unique: ParameterMenuItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return { parameterId, label, automatic, items: unique };
}

function menuItem(
  parameterId: string,
  value: MenuValue,
  label: MenuLabel,
  origin: MenuItemOrigin,
): ParameterMenuItem {
  return {
    id: `menu-item:${stableHash(`${parameterId}\u0000${canonicalJson(value)}`)}`,
    label,
    value,
    origin,
  };
}

/**
 * Register a menu and consume its choice. A choice must name an item of the regenerated menu. A
 * seed preset must also be in the menu, and must agree with any explicit choice.
 */
function choose(
  context: Context,
  walk: Walk,
  current: ParameterMenu,
  preset?: (item: ParameterMenuItem) => boolean,
): ParameterMenuItem | undefined {
  walk.menus.push(current);
  const choiceId = Object.hasOwn(context.choices, current.parameterId)
    ? context.choices[current.parameterId]
    : undefined;
  if (choiceId !== undefined) {
    walk.used.add(current.parameterId);
    const item = current.items.find((candidate) => candidate.id === choiceId);
    if (item === undefined || (preset !== undefined && !preset(item))) {
      walk.errors.push({
        code: "invalid-choice",
        message: `The choice for ${current.parameterId} is not an item of its current menu.`,
      });
      return undefined;
    }
    return item;
  }
  if (preset !== undefined) {
    const item = current.items.find(preset);
    if (item === undefined) {
      walk.errors.push({
        code: "invalid-choice",
        message: `The suggestion's ${current.parameterId} is not available in the current context.`,
      });
    }
    return item;
  }
  if (current.automatic && current.items.length === 1) return current.items[0];
  walk.missing.push(current.parameterId);
  if (current.items.length === 0) walk.empty.push(current.parameterId);
  return undefined;
}

/** Fresh IDs as an automatic menu; undefined (and no menu) without an ID generator. */
function generated(
  context: Context,
  walk: Walk,
  parameterId: string,
  kind: "statement" | "assumption",
  label: string,
  count: number,
): readonly string[] | undefined {
  const generator = context.idGenerator;
  if (generator === undefined) return undefined;
  const ids = Array.from({ length: count }, (_unused, index) =>
    kind === "statement"
      ? generator.statementId(label, index + 1)
      : generator.assumptionId(label, index + 1),
  );
  const chosen = choose(
    context,
    walk,
    menu(
      parameterId,
      parameterId,
      [
        menuItem(
          parameterId,
          { kind: "generated-ids", ids },
          { kind: "text", text: ids.join(", ") },
          { kind: "generated" },
        ),
      ],
      true,
    ),
  );
  return chosen?.value.kind === "generated-ids" ? chosen.value.ids : undefined;
}

type Candidate = Readonly<{ expression: PlainMathJson; origin: MenuItemOrigin }>;

function selectionCandidates(context: Context): readonly Candidate[] {
  return context.slotOrder.flatMap((slotId) => {
    const selection = context.selections.get(slotId);
    if (
      selection === undefined ||
      freeSymbolNames(selection.fragment, { operators: context.operators }).some((symbol) =>
        selection.bound.has(symbol),
      )
    ) {
      return [];
    }
    return [{ expression: selection.fragment, origin: { kind: "selection" as const, slotId } }];
  });
}

function occurrenceCandidates(context: Context): readonly Candidate[] {
  return statementOccurrences(contextStatements(context), context.operators).map((occurrence) => ({
    expression: occurrence.expression,
    origin:
      occurrence.path.length === 0
        ? occurrence.statement.kind === "conclusion"
          ? { kind: "conclusion" as const }
          : { kind: "hypothesis" as const, hypothesisId: occurrence.statement.id }
        : {
            kind: "subterm-of" as const,
            statement: occurrence.statement,
            path: occurrence.path,
          },
  }));
}

/** In-scope terms of one sort: selections, then declarations, then subterms in occurrence order. */
function termMenu(context: Context, parameterId: string, label: string, sort: Sort): ParameterMenu {
  const candidates: Candidate[] = [
    ...selectionCandidates(context),
    ...context.entry.sequent.context.declarations.map((declaration) => ({
      expression: declaration.symbol,
      origin: { kind: "declaration" as const, declarationId: declaration.id },
    })),
    ...occurrenceCandidates(context).filter((candidate) => candidate.origin.kind === "subterm-of"),
  ];
  const fits = sortFilter(
    sort,
    context.entry.sequent.context.declarations,
    context.operators,
    candidates.map((candidate) => candidate.expression),
  );
  return menu(
    parameterId,
    label,
    dedupeBy(
      candidates.filter((candidate) => fits(candidate.expression)),
      (candidate) => candidate.expression,
    ).map((candidate) =>
      menuItem(
        parameterId,
        { kind: "term", expression: candidate.expression },
        { kind: "math", expression: candidate.expression },
        candidate.origin,
      ),
    ),
  );
}

function chooseTerm(
  context: Context,
  walk: Walk,
  parameterId: string,
  label: string,
  sort: Sort,
): PlainMathJson | undefined {
  const chosen = choose(context, walk, termMenu(context, parameterId, label, sort));
  return chosen?.value.kind === "term" ? chosen.value.expression : undefined;
}

/**
 * Propositions from the selections, then the conclusion and hypotheses, then proposition
 * subterms. `excludeConclusion` drops candidates alpha-equivalent to the current conclusion.
 */
function chooseProposition(
  context: Context,
  walk: Walk,
  label: string,
  excludeConclusion = false,
): PlainMathJson | undefined {
  const isProposition = propositionFilter(
    context.entry.sequent.context.declarations,
    context.operators,
  );
  const conclusion = context.entry.sequent.conclusion.expression;
  const occurrences = occurrenceCandidates(context);
  const candidates: Candidate[] = [
    ...selectionCandidates(context),
    ...occurrences.filter((candidate) => candidate.origin.kind !== "subterm-of"),
    ...occurrences.filter((candidate) => candidate.origin.kind === "subterm-of"),
  ].filter(
    (candidate) =>
      isProposition(candidate.expression) &&
      !(
        excludeConclusion &&
        alphaEquivalent(candidate.expression, conclusion, { operators: context.operators })
      ),
  );
  const chosen = choose(
    context,
    walk,
    menu(
      "proposition",
      label,
      dedupeBy(candidates, (candidate) => candidate.expression).map((candidate) =>
        menuItem(
          "proposition",
          { kind: "proposition", expression: candidate.expression },
          { kind: "math", expression: candidate.expression },
          candidate.origin,
        ),
      ),
    ),
  );
  return chosen?.value.kind === "proposition" ? chosen.value.expression : undefined;
}

function occurrenceSelection(context: Context, walk: Walk): ResolvedSelection | undefined {
  const selection = context.selections.get("occurrence") ?? context.selections.get("target");
  if (selection === undefined) {
    walk.errors.push({ code: "missing-selection", message: "Select the occurrence to rewrite." });
  }
  return selection;
}

function occurrenceFields(selection: ResolvedSelection): Readonly<Record<string, unknown>> {
  return {
    statement: selection.statement,
    path: selection.path,
    ...(selection.lens === undefined ? {} : { lens: selection.lens }),
  };
}

/** Whether the kernel accepts the operation on the snapshot (used to keep only valid items). */
function kernelAccepts(context: Context, fields: Readonly<Record<string, unknown>>): boolean {
  return applyTransition(
    context.state,
    {
      kind: context.kind,
      expectedStateId: context.state.id,
      resultStateId: `${context.state.id}/menu-probe`,
      target: context.target,
      ...fields,
    },
    context.environment,
  ).ok;
}

const DIRECTIONS = ["forward", "backward"] as const;

function directionMenu(
  parameterId: string,
  directions: readonly ("forward" | "backward")[],
): ParameterMenu {
  return menu(
    parameterId,
    "Direction",
    directions.map((direction) =>
      menuItem(
        parameterId,
        { kind: "direction", direction },
        { kind: "text", text: direction === "forward" ? "Left to right" : "Right to left" },
        { kind: "rule" },
      ),
    ),
  );
}

function rewriteWithEquality(
  context: Context,
  walk: Walk,
): Readonly<Record<string, unknown>> | undefined {
  const occurrence = occurrenceSelection(context, walk);
  const equalityHypothesisId = selectedHypothesis(context, walk, "equality");
  if (occurrence === undefined || equalityHypothesisId === undefined) return undefined;
  const base = { equalityHypothesisId, ...occurrenceFields(occurrence) };
  const chosen = choose(
    context,
    walk,
    directionMenu(
      "direction",
      DIRECTIONS.filter((direction) => kernelAccepts(context, { ...base, direction })),
    ),
  );
  return chosen?.value.kind === "direction"
    ? { ...base, direction: chosen.value.direction }
    : undefined;
}

/**
 * Rewrite sources: the selected source hypothesis first, then local hypotheses of the source
 * operator in context order, then approved premise-free results whose side matches the occurrence.
 * A result is listed only when matching that side determines its whole instantiation. Only
 * sources the kernel accepts for some direction are kept.
 */
function deepRewrite(
  context: Context,
  walk: Walk,
  kind: "rewrite-with-equivalence" | "rewrite-with-implication",
): Readonly<Record<string, unknown>> | undefined {
  const occurrence = occurrenceSelection(context, walk);
  if (occurrence === undefined) return undefined;
  const operator = kind === "rewrite-with-equivalence" ? "Equivalent" : "Implies";
  const sourceSlot = kind === "rewrite-with-equivalence" ? "equivalence" : "implication";
  const base = occurrenceFields(occurrence);
  const directionsFor = (source: RewriteSource): readonly ("forward" | "backward")[] =>
    kind === "rewrite-with-equivalence"
      ? DIRECTIONS.filter((direction) => kernelAccepts(context, { ...base, source, direction }))
      : kernelAccepts(context, { ...base, source })
        ? ["forward"]
        : [];

  const selectedSource = context.selections.get(sourceSlot);
  const hypotheses = context.entry.sequent.context.hypotheses;
  const orderedHypotheses = [
    ...hypotheses.filter(
      (hypothesis) =>
        selectedSource?.statement.kind === "hypothesis" &&
        hypothesis.id === selectedSource.statement.id,
    ),
    ...hypotheses,
  ];
  const candidates: { source: RewriteSource; label: MenuLabel; origin: MenuItemOrigin }[] = [];
  orderedHypotheses.forEach((hypothesis) => {
    if (operatorOperands(hypothesis.statement.expression, operator)?.length !== 2) return;
    const selected =
      selectedSource?.statement.kind === "hypothesis" &&
      selectedSource.statement.id === hypothesis.id;
    candidates.push({
      source: { kind: "hypothesis", hypothesisId: hypothesis.id },
      label: { kind: "math", expression: hypothesis.statement.expression },
      origin: selected
        ? { kind: "selection", slotId: sourceSlot }
        : { kind: "hypothesis", hypothesisId: hypothesis.id },
    });
  });
  const applicationDirection: ResultApplicationDirection =
    occurrence.statement.kind === "conclusion" ? "backward" : "forward";
  context.results.forEach((result) => {
    const sides = operatorOperands(result.conclusion.expression, operator);
    if (
      result.premises.length > 0 ||
      sides?.length !== 2 ||
      !result.directions.includes(applicationDirection)
    ) {
      return;
    }
    const required = freeResultParameters(result, context.operators);
    sides.forEach((side) => {
      const match = matchResultConclusion(
        syntheticResult(result.id, result.parameters, side),
        { expression: occurrence.fragment },
        { operators: context.operators },
      );
      if (
        !match.ok ||
        !required.every((parameter) => Object.hasOwn(match.instantiation, parameter.symbol))
      ) {
        return;
      }
      candidates.push({
        source: { kind: "result", resultId: result.id, instantiation: match.instantiation },
        label: { kind: "text", text: result.id },
        origin: { kind: "result", resultId: result.id },
      });
    });
  });
  const accepted = candidates.filter((candidate) => directionsFor(candidate.source).length > 0);
  const seed = context.seed;
  const chosen = choose(
    context,
    walk,
    menu(
      "source",
      kind === "rewrite-with-equivalence" ? "Equivalence source" : "Implication source",
      accepted.map((candidate) =>
        menuItem(
          "source",
          { kind: "rewrite-source", source: candidate.source },
          candidate.label,
          candidate.origin,
        ),
      ),
    ),
    seed === undefined
      ? undefined
      : (item) =>
          item.value.kind === "rewrite-source" &&
          item.value.source.kind === "result" &&
          item.value.source.resultId === seed.resultId &&
          (seed.direction === undefined ||
            directionsFor(item.value.source).includes(seed.direction)),
  );
  if (chosen?.value.kind !== "rewrite-source") return undefined;
  const source = chosen.value.source;
  if (kind === "rewrite-with-implication") return { ...base, source };
  const direction = choose(
    context,
    walk,
    directionMenu("direction", directionsFor(source)),
    seed?.direction === undefined
      ? undefined
      : (item) => item.value.kind === "direction" && item.value.direction === seed.direction,
  );
  return direction?.value.kind === "direction"
    ? { ...base, source, direction: direction.value.direction }
    : undefined;
}

function syntheticResult(
  id: string,
  parameters: readonly KernelResultParameter[],
  conclusion: PlainMathJson,
): Readonly<Record<string, unknown>> {
  return {
    id,
    parameters,
    premises: [],
    conclusion: { expression: conclusion },
    directions: ["forward"],
  };
}

type Bindings = Map<string, PlainMathJson>;

/** Merge terms into bindings; false (bindings unchanged) when a symbol is bound differently. */
function mergeBindings(
  bindings: Bindings,
  terms: Readonly<Record<string, PlainMathJson>>,
  operators: readonly OperatorDeclaration[],
): boolean {
  const entries = Object.entries(terms);
  const consistent = entries.every(([symbol, term]) => {
    const existing = bindings.get(symbol);
    return existing === undefined || alphaEquivalent(existing, term, { operators });
  });
  if (consistent) entries.forEach(([symbol, term]) => bindings.set(symbol, term));
  return consistent;
}

function seedBindings(
  context: Context,
  walk: Walk,
  parameters: readonly KernelResultParameter[],
  bindings: Bindings,
): boolean {
  const seed = context.seed;
  if (seed === undefined) return true;
  const symbols = new Set(parameters.map((parameter) => parameter.symbol));
  if (!seed.substitutions.every((substitution) => symbols.has(substitution.symbol))) {
    walk.errors.push({
      code: "invalid-request",
      message: "A suggestion substitution names a symbol that is not a parameter of the result.",
    });
    return false;
  }
  const merged = mergeBindings(
    bindings,
    Object.fromEntries(seed.substitutions.map(({ symbol, expression }) => [symbol, expression])),
    context.operators,
  );
  if (!merged) {
    walk.errors.push({
      code: "invalid-request",
      message: "The suggestion substitutions contradict the target.",
    });
  }
  return merged;
}

/**
 * Extend bindings by matching premises against local hypotheses: for each premise with an
 * unbound parameter, in order, the first hypothesis (context order) whose match is consistent
 * with the bindings so far is used. This is greedy and deterministic, and it never backtracks.
 */
function bindFromHypotheses(
  context: Context,
  parameters: readonly KernelResultParameter[],
  premises: readonly PlainMathJson[],
  bindings: Bindings,
): void {
  const symbols = new Set(parameters.map((parameter) => parameter.symbol));
  for (const premise of premises) {
    const free = freeParameterSymbols(context, premise, symbols);
    if (free.every((symbol) => bindings.has(symbol))) continue;
    for (const hypothesis of context.entry.sequent.context.hypotheses) {
      const match = matchResultConclusion(
        syntheticResult("result:premise-match", parameters, premise),
        { expression: hypothesis.statement.expression },
        { operators: context.operators },
      );
      if (match.ok && mergeBindings(bindings, match.instantiation, context.operators)) break;
    }
  }
}

function freeParameterSymbols(
  context: Context,
  expression: PlainMathJson,
  parameters: ReadonlySet<string>,
): readonly string[] {
  return freeSymbolNames(expression, { operators: context.operators }).filter((symbol) =>
    parameters.has(symbol),
  );
}

/** Complete an instantiation with term menus (`instantiation/<symbol>`) for unbound parameters. */
function completeInstantiation(
  context: Context,
  walk: Walk,
  required: readonly KernelResultParameter[],
  bindings: Bindings,
): ResultInstantiation | undefined {
  let complete = true;
  for (const parameter of required) {
    if (bindings.has(parameter.symbol)) continue;
    const term = chooseTerm(
      context,
      walk,
      `instantiation/${parameter.symbol}`,
      `Term for ${parameter.symbol}`,
      parameter.sort,
    );
    if (term === undefined) complete = false;
    else bindings.set(parameter.symbol, term);
  }
  if (!complete) return undefined;
  return Object.fromEntries(
    required.map((parameter) => [
      parameter.symbol,
      bindings.get(parameter.symbol) as PlainMathJson,
    ]),
  );
}

function resultMenu(
  context: Context,
  walk: Walk,
  results: readonly KernelResult[],
): KernelResult | undefined {
  const seed = context.seed;
  const chosen = choose(
    context,
    walk,
    menu(
      "resultId",
      "Result",
      results.map((result) =>
        menuItem(
          "resultId",
          { kind: "result", resultId: result.id },
          { kind: "text", text: result.id },
          { kind: "result", resultId: result.id },
        ),
      ),
    ),
    seed === undefined
      ? undefined
      : (item) => item.value.kind === "result" && item.value.resultId === seed.resultId,
  );
  const value = chosen?.value;
  return value?.kind === "result"
    ? results.find((result) => result.id === value.resultId)
    : undefined;
}

function applyResultBackward(
  context: Context,
  walk: Walk,
): Readonly<Record<string, unknown>> | undefined {
  const conclusion = context.entry.sequent.conclusion.expression;
  const matches = new Map<string, ResultInstantiation>();
  const candidates = context.results.filter((result) => {
    if (!result.directions.includes("backward")) return false;
    const match = matchResultConclusion(
      result,
      { expression: conclusion },
      {
        operators: context.operators,
      },
    );
    if (match.ok) matches.set(result.id, match.instantiation);
    return match.ok;
  });
  const result = resultMenu(context, walk, candidates);
  if (result === undefined) return undefined;
  const bindings: Bindings = new Map(Object.entries(matches.get(result.id) ?? {}));
  if (!seedBindings(context, walk, result.parameters, bindings)) return undefined;
  const instantiation = completeInstantiation(
    context,
    walk,
    freeResultParameters(result, context.operators),
    bindings,
  );
  const premiseTargetIds = generated(
    context,
    walk,
    "premiseTargetIds",
    "statement",
    "premise-target",
    result.premises.length,
  );
  return instantiation === undefined || premiseTargetIds === undefined
    ? undefined
    : { resultId: result.id, instantiation, premiseTargetIds };
}

function applyResultForward(
  context: Context,
  walk: Walk,
): Readonly<Record<string, unknown>> | undefined {
  const result = resultMenu(
    context,
    walk,
    context.results.filter((candidate) => candidate.directions.includes("forward")),
  );
  if (result === undefined) return undefined;
  const bindings: Bindings = new Map();
  if (!seedBindings(context, walk, result.parameters, bindings)) return undefined;
  bindFromHypotheses(
    context,
    result.parameters,
    result.premises.map((premise) => premise.expression),
    bindings,
  );
  const instantiation = completeInstantiation(
    context,
    walk,
    freeResultParameters(result, context.operators),
    bindings,
  );
  if (instantiation === undefined) return undefined;
  const premiseHypothesisIds: (string | null)[] = [];
  for (const premise of result.premises) {
    const instance = instantiate(context, premise.expression, instantiation);
    if (instance === undefined) {
      return notApplicable(walk, "The result premises could not be instantiated.");
    }
    premiseHypothesisIds.push(matchingHypothesis(context, instance)?.id ?? null);
  }
  const resultHypothesisIds = generated(
    context,
    walk,
    "resultHypothesisId",
    "statement",
    "result-hypothesis",
    1,
  );
  const obligationIds = generated(
    context,
    walk,
    "obligationIds",
    "statement",
    "obligation",
    premiseHypothesisIds.filter((id) => id === null).length,
  );
  return resultHypothesisIds === undefined || obligationIds === undefined
    ? undefined
    : {
        resultId: result.id,
        instantiation,
        premiseHypothesisIds,
        resultHypothesisId: resultHypothesisIds[0],
        obligationIds,
      };
}

function instantiate(
  context: Context,
  expression: PlainMathJson,
  instantiation: ResultInstantiation,
): PlainMathJson | undefined {
  const substituted = substituteMathJson(
    expression,
    Object.entries(instantiation).map(([symbol, replacement]) => ({ symbol, replacement })),
    { operators: context.operators },
  );
  return substituted.ok ? substituted.expression : undefined;
}

function matchingHypothesis(context: Context, expression: PlainMathJson): Hypothesis | undefined {
  return context.entry.sequent.context.hypotheses.find((hypothesis) =>
    alphaEquivalent(hypothesis.statement.expression, expression, { operators: context.operators }),
  );
}

type AssumptionAnalysis = Readonly<{
  assumption: AdditionalAssumption;
  parameters: readonly KernelResultParameter[];
  /** The instantiated leading binders, outermost first. */
  binders: readonly KernelResultParameter[];
  bindings: ReadonlyMap<string, PlainMathJson>;
  premises: readonly PlainMathJson[];
}>;

/**
 * Find the longest prefix of an assumption's leading binders whose body, or the consequent of
 * whose body, matches the target conclusion. The antecedent's conjuncts become premises.
 */
function analyzeAssumption(
  context: Context,
  assumption: AdditionalAssumption,
): AssumptionAnalysis | undefined {
  const parameters = assumption.declarations.map(({ symbol, sort }) => ({ symbol, sort }));
  const leading: KernelResultParameter[] = [];
  const bodies: PlainMathJson[] = [assumption.statement.expression];
  for (let body = assumption.statement.expression; ;) {
    const operands = operatorOperands(body, "ForAll");
    const symbol = operands?.length === 2 ? symbolValue(operands[0] as PlainMathJson) : undefined;
    const parameter = parameters.find((candidate) => candidate.symbol === symbol);
    if (operands === undefined || parameter === undefined) break;
    leading.push(parameter);
    body = operands[1] as PlainMathJson;
    bodies.push(body);
  }
  const conclusion = context.entry.sequent.conclusion.expression;
  for (let prefix = leading.length; prefix >= 0; prefix -= 1) {
    const body = bodies[prefix] as PlainMathJson;
    const implication = operatorOperands(body, "Implies");
    const attempts: readonly (readonly [PlainMathJson, readonly PlainMathJson[]])[] = [
      [body, []],
      ...(implication?.length === 2
        ? [
            [
              implication[1] as PlainMathJson,
              operatorOperands(implication[0] as PlainMathJson, "And") ?? [
                implication[0] as PlainMathJson,
              ],
            ] as const,
          ]
        : []),
    ];
    for (const [pattern, premises] of attempts) {
      const match = matchResultConclusion(
        syntheticResult("result:assumption-match", parameters, pattern),
        { expression: conclusion },
        { operators: context.operators },
      );
      if (!match.ok) continue;
      const binders = leading.slice(0, prefix);
      const binderSymbols = new Set(binders.map((binder) => binder.symbol));
      if (Object.keys(match.instantiation).some((symbol) => !binderSymbols.has(symbol))) continue;
      return {
        assumption,
        parameters,
        binders,
        bindings: new Map(Object.entries(match.instantiation)),
        premises,
      };
    }
  }
  return undefined;
}

function closeByAssumption(
  context: Context,
  walk: Walk,
): Readonly<Record<string, unknown>> | undefined {
  const analyses = (context.state.assumptions ?? []).flatMap((assumption) => {
    const analysis = analyzeAssumption(context, assumption);
    return analysis === undefined ? [] : [analysis];
  });
  const chosen = choose(
    context,
    walk,
    menu(
      "assumptionId",
      "Additional assumption",
      analyses.map(({ assumption }) =>
        menuItem(
          "assumptionId",
          { kind: "assumption", assumptionId: assumption.id },
          { kind: "math", expression: assumption.statement.expression },
          { kind: "assumption", assumptionId: assumption.id },
        ),
      ),
    ),
  );
  if (chosen?.value.kind !== "assumption") return undefined;
  const assumptionId = chosen.value.assumptionId;
  const analysis = analyses.find(({ assumption }) => assumption.id === assumptionId);
  if (analysis === undefined) return undefined;
  const bindings: Bindings = new Map(analysis.bindings);
  bindFromHypotheses(context, analysis.binders, analysis.premises, bindings);
  const instantiation = completeInstantiation(context, walk, analysis.binders, bindings);
  return instantiation === undefined ? undefined : { assumptionId, instantiation };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Two independent 32-bit FNV-1a hashes: a stable, platform-independent 16-hex-digit digest. */
function stableHash(text: string): string {
  let first = 0x811c9dc5;
  let second = 0x01000193 ^ 0x5bd1e995;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x01000193) ^ (second >>> 15);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function walkFailure(
  code: MaterializationDiagnosticCode,
  message: string,
): Extract<WalkOutcome, { ok: false }> {
  return { ok: false, diagnostics: [{ code, message }] };
}

function materializationFailure(
  code: MaterializationDiagnosticCode,
  message: string,
): MaterializationResult {
  return { ok: false, missingParameters: [], diagnostics: [{ code, message }] };
}

function freezeDetached<Value>(value: Value): Value {
  return deepFreeze(structuredClone(value));
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
