import { z } from "zod";
import {
  canonicalJson,
  plainMathJsonSchema,
  readBinderDeclaration,
  sortSchema,
  stableIdentifierSchema,
  type Declaration,
  type OperatorDeclaration,
  type PlainMathJson,
  type ProofContext,
  type ProofState,
  type Sort,
} from "@proof/mathjson-model";
import {
  formatOperandPath,
  functionParts,
  isOperandPathPrefix,
  positionAtPath,
  type AnchoredProofSelection,
  type LogicalPolarity,
  type OperandPath,
  type SelectionPosition,
  type StatementAnchor,
} from "./index";

/**
 * The logical structure of a proof state: its contexts, and each statement's connectives and
 * quantifiers down to atomic statements.
 *
 * This is a derived projection, never stored. Atoms hold the exact authoritative MathJSON, and
 * every node records the operand path it was read from and the position `positionAtPath` computes
 * there, so the structure can always be recomputed and cannot disagree with the proof state.
 */

export const selectionPositionSchema: z.ZodType<SelectionPosition> = z
  .object({
    polarity: z.enum(["positive", "negative", "mixed", "neutral"]),
    role: z.enum(["proposition", "term", "binder"]),
  })
  .strict();

const operandPathSchema = z.array(z.number().int().nonnegative());

/** Where a node sits in its statement's MathJSON, and its logical position there. */
type LogicalNode = Readonly<{ path: OperandPath; position: SelectionPosition }>;

/** A variable bound by a quantifier; `domain` is the set of a typed binder `x ∈ S`. */
export type BoundVariable = Readonly<{ name: string; domain?: PlainMathJson | undefined }>;

export type LogicalStatement = LogicalNode &
  (
    | Readonly<{ kind: "atomic"; expression: PlainMathJson }>
    | Readonly<{ kind: "conjunction" | "disjunction"; statements: readonly LogicalStatement[] }>
    | Readonly<{ kind: "negation"; statement: LogicalStatement }>
    | Readonly<{ kind: "implication"; antecedent: LogicalStatement; consequent: LogicalStatement }>
    | Readonly<{ kind: "equivalence"; left: LogicalStatement; right: LogicalStatement }>
    | Readonly<{
        kind: "universal" | "existential";
        variable: BoundVariable;
        statement: LogicalStatement;
      }>
    /** Marks an occurrence for attention. It shares the path and position of what it wraps. */
    | Readonly<{ kind: "highlight"; statement: LogicalStatement }>
  );

export const boundVariableSchema: z.ZodType<BoundVariable> = z
  .object({ name: z.string().min(1), domain: plainMathJsonSchema.optional() })
  .strict();

const nodeShape = { path: operandPathSchema, position: selectionPositionSchema };

export const logicalStatementSchema: z.ZodType<LogicalStatement> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ ...nodeShape, kind: z.literal("atomic"), expression: plainMathJsonSchema }).strict(),
    z
      .object({
        ...nodeShape,
        kind: z.enum(["conjunction", "disjunction"]),
        statements: z.array(logicalStatementSchema),
      })
      .strict(),
    z
      .object({ ...nodeShape, kind: z.literal("negation"), statement: logicalStatementSchema })
      .strict(),
    z
      .object({
        ...nodeShape,
        kind: z.literal("implication"),
        antecedent: logicalStatementSchema,
        consequent: logicalStatementSchema,
      })
      .strict(),
    z
      .object({
        ...nodeShape,
        kind: z.literal("equivalence"),
        left: logicalStatementSchema,
        right: logicalStatementSchema,
      })
      .strict(),
    z
      .object({
        ...nodeShape,
        kind: z.enum(["universal", "existential"]),
        variable: boundVariableSchema,
        statement: logicalStatementSchema,
      })
      .strict(),
    z
      .object({ ...nodeShape, kind: z.literal("highlight"), statement: logicalStatementSchema })
      .strict(),
  ]),
);

/**
 * - `free`: arbitrary but fixed (a universal parameter or a local witness);
 * - `meta`: to be instantiated later (an unresolved construction);
 * - `let`: defined to equal a specific value (a resolved construction).
 */
export type ContextVariable = Readonly<{ id: string; name: string; sort: Sort }> &
  (Readonly<{ kind: "free" | "meta" }> | Readonly<{ kind: "let"; value: PlainMathJson }>);

const variableShape = { id: stableIdentifierSchema, name: z.string().min(1), sort: sortSchema };

export const contextVariableSchema: z.ZodType<ContextVariable> = z.discriminatedUnion("kind", [
  z.object({ ...variableShape, kind: z.enum(["free", "meta"]) }).strict(),
  z.object({ ...variableShape, kind: z.literal("let"), value: plainMathJsonSchema }).strict(),
]);

export const labelledStatementSchema = z
  .object({
    /** The stable identifier of the hypothesis, goal, obligation, or assumption. */
    id: stableIdentifierSchema,
    label: z.string().min(1),
    statement: logicalStatementSchema,
  })
  .strict();
export type LabelledStatement = z.infer<typeof labelledStatementSchema>;

/**
 * Variables and hypotheses shared by one or more targets. Obligations stay apart from goals so a
 * side condition never reads as a goal the user chose to prove.
 */
export const logicalProofContextSchema = z
  .object({
    variables: z.array(contextVariableSchema),
    hypotheses: z.array(labelledStatementSchema),
    goals: z.array(labelledStatementSchema),
    obligations: z.array(labelledStatementSchema),
  })
  .strict();
export type LogicalProofContext = z.infer<typeof logicalProofContextSchema>;

export const logicalProofStateSchema = z
  .object({
    stateId: stableIdentifierSchema,
    contexts: z.array(logicalProofContextSchema),
    /** State-global assumptions created by sorries, kept visibly distinct from hypotheses. */
    assumptions: z.array(labelledStatementSchema),
  })
  .strict();
export type LogicalProofState = z.infer<typeof logicalProofStateSchema>;

/** A proof state with an optional library statement the user can reference alongside it. */
export const logicalProofStateWithLibraryResultSchema = z
  .object({
    proofState: logicalProofStateSchema,
    libraryResult: labelledStatementSchema.optional(),
  })
  .strict();
export type LogicalProofStateWithLibraryResult = z.infer<
  typeof logicalProofStateWithLibraryResultSchema
>;

export type LogicalEnvironment = Readonly<{
  declarations?: readonly Declaration[] | undefined;
  operators?: readonly OperatorDeclaration[] | undefined;
}>;

type BasePolarity = Extract<LogicalPolarity, "positive" | "negative">;

/**
 * The logical structure of one statement, whose base polarity is positive for a conclusion and
 * negative for a hypothesis. A malformed connective, such as `Implies` with three operands, reads
 * as atomic. `highlights` wraps the logical node that contains each path.
 */
export function logicalStatement(
  expression: PlainMathJson,
  basePolarity: BasePolarity,
  environment: LogicalEnvironment = {},
  highlights: readonly OperandPath[] = [],
): LogicalStatement {
  const read = (highlighted: ReadonlySet<string>) =>
    readNode(expression, [], {
      root: { polarity: basePolarity, role: "proposition" },
      declarations: environment.declarations ?? [],
      operators: environment.operators ?? [],
      statement: expression,
      highlighted,
    });
  const plain = read(new Set());
  if (highlights.length === 0) return plain;
  return read(
    new Set(highlights.map((path) => formatOperandPath(logicalNodeAtPath(plain, path).path))),
  );
}

type ReadContext = Readonly<{
  root: SelectionPosition;
  declarations: readonly Declaration[];
  operators: readonly OperatorDeclaration[];
  statement: PlainMathJson;
  highlighted: ReadonlySet<string>;
}>;

function readNode(
  expression: PlainMathJson,
  path: OperandPath,
  context: ReadContext,
): LogicalStatement {
  const position =
    positionAtPath(
      context.statement,
      path,
      context.root,
      context.declarations,
      context.operators,
    ) ?? context.root;
  const node = { path, position };
  const logical: LogicalStatement = { ...node, ...readConnective(expression, path, context) };
  return context.highlighted.has(formatOperandPath(path))
    ? { ...node, kind: "highlight", statement: logical }
    : logical;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function readConnective(
  expression: PlainMathJson,
  path: OperandPath,
  context: ReadContext,
): DistributiveOmit<LogicalStatement, keyof LogicalNode> {
  const parts = functionParts(expression);
  const operands = parts?.operands ?? [];
  const child = (index: number) => readNode(operands[index]!, [...path, index], context);
  const arity = operands.length;

  switch (parts?.operator) {
    case "And":
    case "Or":
      return {
        kind: parts.operator === "And" ? "conjunction" : "disjunction",
        statements: operands.map((_, index) => child(index)),
      };
    case "Not":
      if (arity === 1) return { kind: "negation", statement: child(0) };
      break;
    case "Implies":
      if (arity === 2) return { kind: "implication", antecedent: child(0), consequent: child(1) };
      break;
    case "Equivalent":
      if (arity === 2) return { kind: "equivalence", left: child(0), right: child(1) };
      break;
    case "ForAll":
    case "Exists": {
      const variable = arity === 2 ? boundVariable(operands[0]!) : undefined;
      if (variable !== undefined) {
        return {
          kind: parts.operator === "ForAll" ? "universal" : "existential",
          variable,
          statement: child(1),
        };
      }
      break;
    }
  }
  return { kind: "atomic", expression };
}

function boundVariable(operand: PlainMathJson): BoundVariable | undefined {
  const declaration = readBinderDeclaration(operand, ["symbol", "element"]);
  if (declaration === undefined) return undefined;
  const domain = declaration.form === "element" ? functionParts(operand)?.operands[1] : undefined;
  return domain === undefined ? { name: declaration.name } : { name: declaration.name, domain };
}

function logicalChildren(node: LogicalStatement): readonly LogicalStatement[] {
  switch (node.kind) {
    case "atomic":
      return [];
    case "conjunction":
    case "disjunction":
      return node.statements;
    case "implication":
      return [node.antecedent, node.consequent];
    case "equivalence":
      return [node.left, node.right];
    default:
      return [node.statement];
  }
}

/**
 * The deepest logical node containing `path`. A term or binder occurrence lies inside an atom or a
 * quantifier, so this is the proposition whose logical position governs that occurrence.
 */
export function logicalNodeAtPath(root: LogicalStatement, path: OperandPath): LogicalStatement {
  const inner = logicalChildren(root).find((child) => isOperandPathPrefix(child.path, path));
  return inner === undefined ? root : logicalNodeAtPath(inner, path);
}

function contextVariable(declaration: Declaration): ContextVariable {
  const variable = { id: declaration.id, name: declaration.symbol, sort: declaration.sort };
  if (declaration.role !== "construction-metavariable") return { ...variable, kind: "free" };
  return declaration.resolution.status === "resolved"
    ? { ...variable, kind: "let", value: declaration.resolution.value }
    : { ...variable, kind: "meta" };
}

type Target = Readonly<{
  kind: StatementAnchor["target"]["kind"];
  id: string;
  sequent: ProofState["goals"][number]["sequent"];
}>;

function selectionPaths(selection: AnchoredProofSelection): readonly OperandPath[] {
  if (selection.kind === "exact") return [selection.path];
  return Array.from({ length: selection.endOperand - selection.startOperand }, (_, offset) => [
    ...selection.containerPath,
    selection.startOperand + offset,
  ]);
}

/**
 * The logical structure of a proof state. Targets with identical contexts share one proof context,
 * in order of first appearance. `highlights` are the selections to mark; those anchored to another
 * snapshot are ignored.
 */
export function logicalProofState(
  state: ProofState,
  options: Readonly<{
    operators?: readonly OperatorDeclaration[] | undefined;
    highlights?: readonly AnchoredProofSelection[] | undefined;
  }> = {},
): LogicalProofState {
  const operators = options.operators ?? [];
  const highlights = (options.highlights ?? []).filter(
    (selection) => selection.anchor.stateId === state.id,
  );
  const targets: readonly Target[] = [
    ...state.goals.map((goal) => ({ ...goal, kind: "goal" as const })),
    ...state.obligations.map((obligation) => ({ ...obligation, kind: "obligation" as const })),
  ];

  const groups = new Map<string, Target[]>();
  for (const target of targets) {
    const key = canonicalJson(target.sequent.context as unknown as PlainMathJson);
    groups.set(key, [...(groups.get(key) ?? []), target]);
  }

  return {
    stateId: state.id,
    contexts: [...groups.values()].map((group) =>
      logicalContext(group, group[0]!.sequent.context, operators, highlights),
    ),
    assumptions: (state.assumptions ?? []).map((assumption, index) => ({
      id: assumption.id,
      label: `A${index + 1}`,
      statement: logicalStatement(assumption.statement.expression, "negative", {
        declarations: assumption.declarations,
        operators,
      }),
    })),
  };
}

function logicalContext(
  targets: readonly Target[],
  context: ProofContext,
  operators: readonly OperatorDeclaration[],
  highlights: readonly AnchoredProofSelection[],
): LogicalProofContext {
  const environment = { declarations: context.declarations, operators };
  const inGroup = (anchor: StatementAnchor) =>
    targets.some(({ kind, id }) => anchor.target.kind === kind && anchor.target.id === id);
  const pathsWhere = (matches: (anchor: StatementAnchor) => boolean) =>
    highlights.filter(({ anchor }) => matches(anchor)).flatMap(selectionPaths);

  const conclusions = (kind: Target["kind"], prefix: string): LabelledStatement[] =>
    targets
      .filter((target) => target.kind === kind)
      .map((target, index) => ({
        id: target.id,
        label: `${prefix}${index + 1}`,
        statement: logicalStatement(
          target.sequent.conclusion.expression,
          "positive",
          environment,
          pathsWhere(
            (anchor) =>
              anchor.statement.kind === "conclusion" &&
              anchor.target.kind === target.kind &&
              anchor.target.id === target.id,
          ),
        ),
      }));

  return {
    variables: context.declarations.map(contextVariable),
    hypotheses: context.hypotheses.map((hypothesis, index) => ({
      id: hypothesis.id,
      label: `H${index + 1}`,
      statement: logicalStatement(
        hypothesis.statement.expression,
        "negative",
        environment,
        pathsWhere(
          (anchor) =>
            anchor.statement.kind === "hypothesis" &&
            anchor.statement.id === hypothesis.id &&
            inGroup(anchor),
        ),
      ),
    })),
    goals: conclusions("goal", "G"),
    obligations: conclusions("obligation", "O"),
  };
}

/** Pair a proof state with a library statement, which reads like a hypothesis: it is available. */
export function withLibraryResult(
  proofState: LogicalProofState,
  result?: Readonly<{ id: string; label: string; expression: PlainMathJson }>,
  environment: LogicalEnvironment = {},
): LogicalProofStateWithLibraryResult {
  if (result === undefined) return { proofState };
  return {
    proofState,
    libraryResult: {
      id: result.id,
      label: result.label,
      statement: logicalStatement(result.expression, "negative", environment),
    },
  };
}
