/**
 * Backtracking with information (design plan §16.3).
 *
 * A proposition `P` found in a descendant snapshot is carried back to an ancestor, where a
 * classical case split on `P` versus `Not P` creates a new child and leaves the original branch
 * untouched. Everything here is pure: it reads stored snapshots and edges, never the kernel's
 * transition function, and returns frozen, detached values. The worker validates and applies the
 * planned operations through the ordinary command path.
 *
 * Availability. `P` must be a proposition over the source target's context. Each free symbol of
 * `P` is available at an ancestor's target when that target's context declares it with the same
 * sort and it is not only bound there: a symbol that occurs in the sequent, but never free, is still
 * waiting to be introduced (for example by `introduce-universal`), so `P`'s free occurrence would
 * mean a different, unrelated parameter. Operators are session-wide; `P` must also be a
 * well-formed proposition over the ancestor target's declarations.
 *
 * Targets. The source target defaults to the source node's first goal, then its first obligation.
 * Its lineage is traced upward: a target keeps its ID while carried or rewritten in place, and a
 * target absent from the parent was created by the edge's acted-on target. At each strict
 * ancestor the lineage target is the one to split.
 *
 * Ancestor choice. Ancestors are listed closest first. Without an explicit choice the closest
 * eligible ancestor is chosen. A case whose conclusion is its own case hypothesis (`P` for the
 * positive case, `Not P` for the negative one), up to alpha-equivalence, is closed by that
 * hypothesis. Focus moves to the remaining open case; when neither case closes, to the `P` case.
 */
import { alphaEquivalent, type KernelOperation } from "@proof/kernel";
import {
  RESERVED_BUILTIN_SYMBOLS,
  declarationSchema,
  freeSymbolNames,
  parseStatementView,
  plainMathJsonSchema,
  proofStateIdSchema,
  sortEquals,
  stableIdentifierSchema,
  statementIdSchema,
  type ContextualSequent,
  type Declaration,
  type OperatorDeclaration,
  type PlainMathJson,
} from "@proof/mathjson-model";
import { commandIdGenerator } from "@proof/moves";
import { z } from "zod";
import type { ProofNode } from "./index";

// Local copies of the branded identifiers in `index.ts`: the brands are structural, so values
// parsed here are interchangeable with those schemas' outputs without an import cycle.
const actorIdSchema = stableIdentifierSchema.brand("ActorId");
const commandIdSchema = stableIdentifierSchema.brand("CommandId");
const proofNodeIdSchema = stableIdentifierSchema.brand("ProofNodeId");

export const backtrackTargetSchema = z
  .object({ kind: z.enum(["goal", "obligation"]), id: statementIdSchema })
  .strict();
export type BacktrackTarget = z.infer<typeof backtrackTargetSchema>;

const backtrackRequestShape = {
  /** The descendant snapshot the proposition was found in. */
  sourceNodeId: proofNodeIdSchema,
  /** Defaults to the source node's first goal, then its first obligation. */
  sourceTarget: backtrackTargetSchema.optional(),
  proposition: plainMathJsonSchema,
  /** A different eligible ancestor; defaults to the closest eligible one. */
  ancestorNodeId: proofNodeIdSchema.optional(),
} as const;

/** The question "where can `P` go?", without committing anything. */
export const backtrackAnalysisRequestSchema = z.object(backtrackRequestShape).strict();
export type BacktrackAnalysisRequest = z.infer<typeof backtrackAnalysisRequestSchema>;

/** Insert a case split on `P` at an ancestor, as one idempotent command. */
export const backtrackWithInformationCommandSchema = z
  .object({
    commandId: commandIdSchema,
    actor: z.object({ id: actorIdSchema, kind: z.enum(["human", "agent"]) }).strict(),
    expectedCurrentNodeId: proofNodeIdSchema,
    ...backtrackRequestShape,
  })
  .strict();
export type BacktrackWithInformationCommand = z.infer<typeof backtrackWithInformationCommandSchema>;

export const backtrackAncestorSchema = z
  .object({
    nodeId: proofNodeIdSchema,
    /** Edges between this ancestor and the source node (the parent has distance 1). */
    distance: z.number().int().min(1),
    /** The source target's lineage in this ancestor: the target a case split would act on. */
    target: backtrackTargetSchema,
    eligible: z.boolean(),
    /** Free symbols of `P` that are undeclared, differently sorted, or only bound here. */
    unavailableSymbols: z.array(z.string()),
    /** Whether `P` is a proposition over this target's declarations and the session operators. */
    wellFormed: z.boolean(),
  })
  .strict();
export type BacktrackAncestor = z.infer<typeof backtrackAncestorSchema>;

export const backtrackAnalysisSchema = z
  .object({
    sourceNodeId: proofNodeIdSchema,
    sourceTarget: backtrackTargetSchema,
    proposition: plainMathJsonSchema,
    freeSymbols: z.array(z.string()),
    /** Built-in and session operators used as function heads, sorted. */
    operators: z.array(z.string()),
    /** The source context's declarations of the free symbols, in free-symbol order. */
    declarations: z.array(declarationSchema),
    /** Strict ancestors of the source, closest first. */
    ancestors: z.array(backtrackAncestorSchema),
    closestEligibleAncestorNodeId: proofNodeIdSchema.optional(),
  })
  .strict();
export type BacktrackAnalysis = z.infer<typeof backtrackAnalysisSchema>;

export type BacktrackDiagnosticCode =
  | "invalid-input"
  | "source-not-in-tree"
  | "source-is-root"
  | "source-target-not-found"
  | "invalid-proposition"
  | "invalid-history"
  | "ancestor-not-on-path"
  | "ancestor-not-eligible"
  | "no-eligible-ancestor";

export type BacktrackDiagnostic = Readonly<{ code: BacktrackDiagnosticCode; message: string }>;

/** The edge fields the analysis reads; `ProofEdge` satisfies this shape. */
export type BacktrackEdge = Readonly<{
  parentNodeId: string;
  childNodeId: string;
  operation: Readonly<{ target: Readonly<{ kind: "goal" | "obligation"; id: string }> }>;
}>;

export type BacktrackAnalysisInput = Readonly<{
  rootNodeId: string;
  nodes: readonly ProofNode[];
  edges: readonly BacktrackEdge[];
  operators?: readonly OperatorDeclaration[];
  request: unknown;
}>;

export type BacktrackAnalysisResult =
  | Readonly<{ ok: true; analysis: BacktrackAnalysis; diagnostics: readonly [] }>
  | Readonly<{
      ok: false;
      diagnostics: readonly [BacktrackDiagnostic];
      /** Present once the proposition was validated at the source. */
      analysis?: BacktrackAnalysis;
    }>;

/** The IDs one planned command's records use; the worker passes its derivation. */
export type BacktrackRecordIds = (commandId: string) => Readonly<{
  resultNodeId: string;
  edgeId: string;
  eventId: string;
  resultStateId: string;
}>;

/** An `apply-kernel-operation` command, validated by `prepareProofCommand` before it is applied. */
export type BacktrackKernelCommand = Readonly<{
  commandId: string;
  kind: "apply-kernel-operation";
  actor: Readonly<{ id: string; kind: "human" | "agent" }>;
  parentNodeId: string;
  resultNodeId: string;
  edgeId: string;
  eventId: string;
  operation: KernelOperation;
}>;

export type BacktrackPlan = Readonly<{
  analysis: BacktrackAnalysis;
  ancestorNodeId: string;
  splitTarget: BacktrackTarget;
  /** The case split at the ancestor, then the auto-close of a case, if one closes. */
  commands: readonly BacktrackKernelCommand[];
  autoClosedTarget?: BacktrackTarget;
  /** The case left open for the user: the target to focus in the final node. */
  focusTarget: BacktrackTarget;
  /** The node the session cursor moves to. */
  finalNodeId: string;
}>;

export type BacktrackPlanResult =
  | Readonly<{ ok: true; plan: BacktrackPlan; diagnostics: readonly [] }>
  | Readonly<{
      ok: false;
      diagnostics: readonly [BacktrackDiagnostic];
      analysis?: BacktrackAnalysis;
    }>;

/** The auto-close command's ID, derived from the backtrack command ID. */
export function backtrackAutoCloseCommandId(commandId: string): string {
  return `${commandId}:auto-close`;
}

type Entry = ProofNode["state"]["goals"][number];

/** Where can `P` go? See the module comment for the exact rules. */
export function analyzeBacktrack(input: BacktrackAnalysisInput): BacktrackAnalysisResult {
  try {
    return analyze(input);
  } catch {
    return failure("invalid-input", "The backtracking request could not be inspected safely.");
  }
}

function analyze(input: BacktrackAnalysisInput): BacktrackAnalysisResult {
  const parsed = backtrackAnalysisRequestSchema.safeParse(input.request);
  if (!parsed.success) return failure("invalid-input", "The backtracking request is invalid.");
  const request = parsed.data;
  const operators = input.operators ?? [];
  const nodes = new Map(input.nodes.map((node) => [node.id as string, node]));
  const parentEdge = new Map(input.edges.map((edge) => [edge.childNodeId, edge]));

  const source = nodes.get(request.sourceNodeId);
  if (source === undefined) {
    return failure("source-not-in-tree", "The source node is not in the discovery tree.");
  }
  if (source.id === input.rootNodeId) {
    return failure("source-is-root", "The root node has no ancestor to backtrack to.");
  }
  const sourceEntry =
    request.sourceTarget === undefined
      ? (source.state.goals[0] ?? source.state.obligations[0])
      : findEntry(source, request.sourceTarget.id);
  if (sourceEntry === undefined) {
    return failure(
      "source-target-not-found",
      "The source target is not a goal or obligation of the source node.",
    );
  }
  const sourceTarget = targetOf(source, sourceEntry);
  if (request.sourceTarget !== undefined && request.sourceTarget.kind !== sourceTarget.kind) {
    return failure("source-target-not-found", "The source target has a different kind.");
  }

  const proposition = request.proposition;
  const sourceSequent = sourceEntry.sequent;
  if (
    parseStatementView(proposition, {
      declarations: sourceSequent.context.declarations,
      operators,
    }) === undefined
  ) {
    return failure(
      "invalid-proposition",
      "The proposition is not well-formed over the source target's context.",
    );
  }
  const freeSymbols = freeSymbolNames(proposition, { operators });
  const declarations: Declaration[] = [];
  for (const symbol of freeSymbols) {
    const declaration = sourceSequent.context.declarations.find((item) => item.symbol === symbol);
    if (declaration === undefined) {
      return failure("invalid-proposition", `The symbol ${symbol} is not declared at the source.`);
    }
    declarations.push(declaration);
  }
  const notInScope = unavailableSymbols(sourceSequent, declarations, operators);
  if (notInScope.length > 0) {
    return failure(
      "invalid-proposition",
      `The symbols ${notInScope.join(", ")} occur only bound at the source; P cannot refer to them.`,
    );
  }

  const ancestors: BacktrackAncestor[] = [];
  let childId: string = source.id;
  let lineageId: string = sourceTarget.id;
  for (let distance = 1; childId !== input.rootNodeId; distance += 1) {
    const edge = parentEdge.get(childId);
    const parent = edge === undefined ? undefined : nodes.get(edge.parentNodeId);
    if (edge === undefined || parent === undefined || distance > input.edges.length) {
      return failure("invalid-history", "The source is not connected to the root by a path.");
    }
    const carried = findEntry(parent, lineageId);
    const entry = carried ?? findEntry(parent, edge.operation.target.id);
    if (entry === undefined) {
      return failure("invalid-history", "The source target's lineage could not be traced.");
    }
    const target = targetOf(parent, entry);
    const unavailable = unavailableSymbols(entry.sequent, declarations, operators);
    const wellFormed =
      parseStatementView(proposition, {
        declarations: entry.sequent.context.declarations,
        operators,
      }) !== undefined;
    ancestors.push({
      nodeId: parent.id,
      distance,
      target,
      eligible: wellFormed && unavailable.length === 0,
      unavailableSymbols: unavailable,
      wellFormed,
    });
    childId = parent.id;
    lineageId = target.id;
  }

  const closest = ancestors.find(({ eligible }) => eligible);
  const analysis = freezeDetached<BacktrackAnalysis>({
    sourceNodeId: source.id,
    sourceTarget,
    proposition,
    freeSymbols: [...freeSymbols],
    operators: operatorHeads(proposition, operators, new Set(freeSymbols)),
    declarations,
    ancestors,
    ...(closest === undefined ? {} : { closestEligibleAncestorNodeId: closest.nodeId }),
  });
  return { ok: true, analysis, diagnostics: [] };
}

/**
 * Plan the case split at the chosen (or closest eligible) ancestor, and the auto-close of a case
 * whose conclusion is its case hypothesis.
 */
export function planBacktrackWithInformation(
  input: Omit<BacktrackAnalysisInput, "request"> &
    Readonly<{ command: unknown; recordIds: BacktrackRecordIds }>,
): BacktrackPlanResult {
  try {
    return plan(input);
  } catch {
    return failure("invalid-input", "The backtracking command could not be inspected safely.");
  }
}

function plan(
  input: Omit<BacktrackAnalysisInput, "request"> &
    Readonly<{ command: unknown; recordIds: BacktrackRecordIds }>,
): BacktrackPlanResult {
  const parsed = backtrackWithInformationCommandSchema.safeParse(input.command);
  if (!parsed.success) return failure("invalid-input", "The backtracking command is invalid.");
  const command = parsed.data;
  const analyzed = analyzeBacktrack({
    ...input,
    request: {
      sourceNodeId: command.sourceNodeId,
      proposition: command.proposition,
      ...(command.sourceTarget === undefined ? {} : { sourceTarget: command.sourceTarget }),
      ...(command.ancestorNodeId === undefined ? {} : { ancestorNodeId: command.ancestorNodeId }),
    },
  });
  if (!analyzed.ok) return analyzed;
  const { analysis } = analyzed;

  let ancestor: BacktrackAncestor | undefined;
  if (command.ancestorNodeId === undefined) {
    ancestor = analysis.ancestors.find(({ eligible }) => eligible);
    if (ancestor === undefined) {
      const symbols = [...new Set(analysis.ancestors.flatMap((item) => item.unavailableSymbols))];
      return {
        ...failure(
          "no-eligible-ancestor",
          symbols.length === 0
            ? "No ancestor can state the proposition."
            : `No ancestor has ${symbols.join(", ")} available.`,
        ),
        analysis,
      };
    }
  } else {
    ancestor = analysis.ancestors.find(({ nodeId }) => nodeId === command.ancestorNodeId);
    if (ancestor === undefined) {
      return {
        ...failure(
          "ancestor-not-on-path",
          "The chosen node is not a strict ancestor of the source.",
        ),
        analysis,
      };
    }
    if (!ancestor.eligible) {
      return {
        ...failure(
          "ancestor-not-eligible",
          ancestor.unavailableSymbols.length === 0
            ? "The proposition is not well-formed at the chosen ancestor."
            : `The chosen ancestor does not have ${ancestor.unavailableSymbols.join(", ")} available.`,
        ),
        analysis,
      };
    }
  }

  const ancestorNode = input.nodes.find(({ id }) => id === ancestor.nodeId);
  const splitEntry =
    ancestorNode === undefined ? undefined : findEntry(ancestorNode, ancestor.target.id);
  if (ancestorNode === undefined || splitEntry === undefined) {
    return failure("invalid-history", "The chosen ancestor's target could not be read.");
  }
  const operatorsList = input.operators ?? [];
  const actor = { id: command.actor.id, kind: command.actor.kind };
  const splitIds = input.recordIds(command.commandId);
  const generator = commandIdGenerator(command.commandId);
  const childIds = [1, 2].map((index) =>
    statementIdSchema.parse(generator.statementId("child", index)),
  );
  const hypothesisIds = [1, 2].map((index) =>
    statementIdSchema.parse(generator.statementId("branch-hypothesis", index)),
  );
  const splitTarget = ancestor.target;
  const caseSplit: BacktrackKernelCommand = {
    commandId: command.commandId,
    kind: "apply-kernel-operation",
    actor,
    parentNodeId: ancestorNode.id,
    resultNodeId: splitIds.resultNodeId,
    edgeId: splitIds.edgeId,
    eventId: splitIds.eventId,
    operation: {
      kind: "split-classical-cases",
      expectedStateId: ancestorNode.state.id,
      resultStateId: proofStateIdSchema.parse(splitIds.resultStateId),
      target: splitTarget,
      proposition: command.proposition,
      childIds: [childIds[0], childIds[1]] as [(typeof childIds)[0], (typeof childIds)[0]],
      branchHypothesisIds: [hypothesisIds[0], hypothesisIds[1]] as [
        (typeof hypothesisIds)[0],
        (typeof hypothesisIds)[0],
      ],
    } as KernelOperation,
  };

  const conclusion = splitEntry.sequent.conclusion.expression;
  const closedIndex = alphaEquivalent(conclusion, command.proposition, { operators: operatorsList })
    ? 0
    : alphaEquivalent(conclusion, ["Not", command.proposition], { operators: operatorsList })
      ? 1
      : undefined;
  const caseTarget = (index: number): BacktrackTarget => ({
    kind: splitTarget.kind,
    id: childIds[index] as BacktrackTarget["id"],
  });
  const commands: BacktrackKernelCommand[] = [caseSplit];
  let finalNodeId: string = splitIds.resultNodeId;
  if (closedIndex !== undefined) {
    const closeCommandId = backtrackAutoCloseCommandId(command.commandId);
    const closeIds = input.recordIds(closeCommandId);
    commands.push({
      commandId: closeCommandId,
      kind: "apply-kernel-operation",
      actor,
      parentNodeId: splitIds.resultNodeId,
      resultNodeId: closeIds.resultNodeId,
      edgeId: closeIds.edgeId,
      eventId: closeIds.eventId,
      operation: {
        kind: "close-by-hypothesis",
        expectedStateId: proofStateIdSchema.parse(splitIds.resultStateId),
        resultStateId: proofStateIdSchema.parse(closeIds.resultStateId),
        target: caseTarget(closedIndex),
        hypothesisId: hypothesisIds[closedIndex],
      } as KernelOperation,
    });
    finalNodeId = closeIds.resultNodeId;
  }

  return {
    ok: true,
    plan: freezeDetached<BacktrackPlan>({
      analysis,
      ancestorNodeId: ancestorNode.id,
      splitTarget,
      commands,
      ...(closedIndex === undefined ? {} : { autoClosedTarget: caseTarget(closedIndex) }),
      focusTarget: caseTarget(closedIndex === 0 ? 1 : 0),
      finalNodeId,
    }),
    diagnostics: [],
  };
}

function findEntry(node: ProofNode, id: string): Entry | undefined {
  return (
    node.state.goals.find((goal) => goal.id === id) ??
    node.state.obligations.find((obligation) => obligation.id === id)
  );
}

function targetOf(node: ProofNode, entry: Entry): BacktrackTarget {
  return {
    kind: node.state.goals.some(({ id }) => id === entry.id) ? "goal" : "obligation",
    id: entry.id,
  };
}

function unavailableSymbols(
  sequent: ContextualSequent,
  declarations: readonly Declaration[],
  operators: readonly OperatorDeclaration[],
): string[] {
  const expressions = [
    sequent.conclusion.expression,
    ...sequent.context.hypotheses.map(({ statement }) => statement.expression),
  ];
  const free = new Set(
    expressions.flatMap((expression) => freeSymbolNames(expression, { operators })),
  );
  const occurring = new Set<string>();
  expressions.forEach((expression) => collectSymbols(expression, occurring));
  return declarations
    .filter((declaration) => {
      const local = sequent.context.declarations.find(
        ({ symbol }) => symbol === declaration.symbol,
      );
      if (local === undefined || !sortEquals(local.sort, declaration.sort)) return true;
      return occurring.has(declaration.symbol) && !free.has(declaration.symbol);
    })
    .map(({ symbol }) => symbol);
}

/** Every symbol name occurring anywhere, bound or free, including function heads. */
function collectSymbols(expression: PlainMathJson, result: Set<string>): void {
  if (typeof expression === "string") {
    result.add(expression);
    return;
  }
  if (Array.isArray(expression)) {
    expression.forEach((operand) => collectSymbols(operand as PlainMathJson, result));
    return;
  }
  if (typeof expression !== "object" || expression === null) return;
  const record = expression as Readonly<Record<string, unknown>>;
  if (typeof record.sym === "string") result.add(record.sym);
  if (Array.isArray(record.fn)) {
    record.fn.forEach((operand) => collectSymbols(operand as PlainMathJson, result));
  }
}

function operatorHeads(
  expression: PlainMathJson,
  operators: readonly OperatorDeclaration[],
  freeSymbols: ReadonlySet<string>,
): string[] {
  const declared = new Set(operators.map(({ symbol }) => symbol));
  const heads = new Set<string>();
  const visit = (value: PlainMathJson): void => {
    const operands = Array.isArray(value)
      ? value
      : typeof value === "object" && value !== null && Array.isArray((value as { fn?: unknown }).fn)
        ? ((value as { fn: PlainMathJson[] }).fn as readonly PlainMathJson[])
        : undefined;
    if (operands === undefined) return;
    const [head, ...rest] = operands;
    if (
      typeof head === "string" &&
      !freeSymbols.has(head) &&
      (RESERVED_BUILTIN_SYMBOLS.has(head) || declared.has(head))
    ) {
      heads.add(head);
    }
    if (head !== undefined && typeof head !== "string") visit(head);
    rest.forEach((operand) => visit(operand as PlainMathJson));
  };
  visit(expression);
  return [...heads].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function failure(
  code: BacktrackDiagnosticCode,
  message: string,
): Readonly<{ ok: false; diagnostics: readonly [BacktrackDiagnostic] }> {
  return { ok: false, diagnostics: [{ code, message }] };
}

function freezeDetached<Value>(value: Value): Value {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return Object.freeze(value);
}
