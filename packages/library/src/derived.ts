/**
 * Conditional-lemma extraction for results derived in a proof (design plan §12.4, refinement §9,
 * roadmap N12).
 *
 * A conclusion established at a proof node holds only under the hypotheses the proof used, which
 * include any branch assumptions (case-split cases, temporary hypotheses). The extracted result
 * therefore retains exactly the used hypotheses as premises, so reusing it outside the attempt
 * must discharge them; it cannot escape the branch's assumptions.
 *
 * Parameters are the universal-parameter declarations that the conclusion and used hypotheses
 * depend on, in context order. A dependency on a local witness or a construction metavariable
 * (directly, or through a resolved construction's value) is rejected rather than generalized:
 * a witness is a specific object introduced by elimination, and generalizing it would claim the
 * statement for every object of its sort, which the proof did not establish.
 */
import {
  createContextualSequentSchema,
  freeSymbolNames,
  operatorDeclarationsSchema,
  type Declaration,
  type OperatorDeclaration,
  type PlainMathJson,
  type ProofContext,
  type StatementView,
} from "@proof/mathjson-model";
import type { BackgroundClassification } from "./background";
import {
  createLibraryResultSchema,
  type DeterministicRenderings,
  type LibraryApproval,
  type LibraryArtifactId,
  type LibraryResult,
  type ResultPattern,
} from "./index";

export type DerivedResultDiagnosticCode =
  | "invalid-environment"
  | "invalid-sequent"
  | "unknown-hypothesis"
  | "duplicate-hypothesis"
  | "local-dependency"
  | "invalid-result";

export type DerivedResultDiagnostic = Readonly<{
  code: DerivedResultDiagnosticCode;
  message: string;
  symbol?: string;
}>;

export type DerivedResultInput = Readonly<{
  sessionId: string;
  proofNodeId: string;
  id: LibraryArtifactId | string;
  name: string;
  description?: string | undefined;
  context: ProofContext;
  conclusion: StatementView;
  usedHypothesisIds: readonly string[];
  classification: BackgroundClassification;
  renderings: DeterministicRenderings;
  approval: LibraryApproval;
  priority?: number | undefined;
  operators?: readonly OperatorDeclaration[] | undefined;
}>;

export type DerivedResultExtraction =
  | Readonly<{ ok: true; result: LibraryResult; diagnostics: readonly [] }>
  | Readonly<{
      ok: false;
      diagnostics: readonly [DerivedResultDiagnostic, ...DerivedResultDiagnostic[]];
    }>;

const GOAL_REQUIREMENT = { section: "goal", polarity: "any", role: "proposition" } as const;
const HYPOTHESIS_REQUIREMENT = {
  section: "hypothesis",
  polarity: "any",
  role: "proposition",
} as const;

/** Extract `∀ parameters. used hypotheses ⇒ conclusion` as a derived-layer library result. */
export function extractDerivedResult(input: DerivedResultInput): DerivedResultExtraction {
  const operatorsParse = operatorDeclarationsSchema.safeParse(input.operators ?? []);
  if (!operatorsParse.success) {
    return failure([
      { code: "invalid-environment", message: "The operator environment is invalid." },
    ]);
  }
  const operators = operatorsParse.data;
  const sequent = createContextualSequentSchema({ operators }).safeParse({
    context: input.context,
    conclusion: input.conclusion,
  });
  if (!sequent.success) {
    return failure([
      {
        code: "invalid-sequent",
        message: "The conclusion must be a well-typed proposition in the proof context.",
      },
    ]);
  }
  const { context, conclusion } = sequent.data;

  const diagnostics: DerivedResultDiagnostic[] = [];
  const used = new Set<string>();
  input.usedHypothesisIds.forEach((id) => {
    if (used.has(id)) {
      diagnostics.push({ code: "duplicate-hypothesis", message: `Hypothesis ${id} is repeated.` });
    } else if (!context.hypotheses.some((hypothesis) => hypothesis.id === id)) {
      diagnostics.push({
        code: "unknown-hypothesis",
        message: `Hypothesis ${id} is not in context.`,
      });
    }
    used.add(id);
  });
  const premises = context.hypotheses
    .filter((hypothesis) => used.has(hypothesis.id))
    .map((hypothesis) => hypothesis.statement);

  const declarations = new Map(
    context.declarations.map((declaration) => [declaration.symbol, declaration]),
  );
  const dependencies = dependencySymbols(
    [conclusion.expression, ...premises.map((premise) => premise.expression)],
    declarations,
    operators,
  );
  context.declarations
    .filter((declaration) => dependencies.has(declaration.symbol))
    .forEach((declaration) => {
      if (declaration.role !== "universal-parameter") {
        diagnostics.push({
          code: "local-dependency",
          message: `The statement depends on the ${declaration.role} ${declaration.symbol}, which cannot be generalized.`,
          symbol: declaration.symbol,
        });
      }
    });
  if (diagnostics.length > 0) return failure(diagnostics);

  const parameters = context.declarations.filter(
    (declaration) =>
      declaration.role === "universal-parameter" && dependencies.has(declaration.symbol),
  );
  const patterns: ResultPattern[] = [
    {
      id: `pattern:${input.id}:backward`,
      expression: conclusion.expression,
      direction: "backward",
      requirement: GOAL_REQUIREMENT,
    } as ResultPattern,
  ];
  const firstPremise = premises[0];
  if (firstPremise !== undefined) {
    patterns.push({
      id: `pattern:${input.id}:forward`,
      expression: firstPremise.expression,
      direction: "forward",
      requirement: HYPOTHESIS_REQUIREMENT,
    } as ResultPattern);
  }

  let schema: ReturnType<typeof createLibraryResultSchema>;
  try {
    schema = createLibraryResultSchema({ operators });
  } catch {
    return failure([
      { code: "invalid-environment", message: "The operator environment is invalid." },
    ]);
  }
  const parsed = schema.safeParse({
    kind: "result",
    id: input.id,
    name: input.name,
    description:
      input.description ??
      `Derived at proof node ${input.proofNodeId} of session ${input.sessionId}.`,
    renderings: input.renderings,
    classification: input.classification,
    provenance: { kind: "derived", sessionId: input.sessionId, proofNodeId: input.proofNodeId },
    approval: input.approval,
    layer: "derived",
    related: [],
    priority: input.priority ?? 0,
    parameters,
    statement: conclusion,
    premises,
    sideConditions: [],
    applicationDirections: firstPremise === undefined ? ["backward"] : ["backward", "forward"],
    patterns,
  });
  if (!parsed.success) {
    return failure([
      {
        code: "invalid-result",
        message: parsed.error.issues[0]?.message ?? "The derived result failed validation.",
      },
    ]);
  }
  return deepFreeze({ ok: true, result: parsed.data, diagnostics: [] as const });
}

/** Free symbols of the expressions, closed under resolved construction values. */
function dependencySymbols(
  expressions: readonly PlainMathJson[],
  declarations: ReadonlyMap<string, Declaration>,
  operators: readonly OperatorDeclaration[],
): ReadonlySet<string> {
  const found = new Set<string>();
  const pending = expressions.flatMap((expression) => [
    ...freeSymbolNames(expression, { operators }),
  ]);
  for (let symbol = pending.pop(); symbol !== undefined; symbol = pending.pop()) {
    if (found.has(symbol)) continue;
    found.add(symbol);
    const declaration = declarations.get(symbol);
    if (
      declaration?.role === "construction-metavariable" &&
      declaration.resolution.status === "resolved"
    ) {
      pending.push(...freeSymbolNames(declaration.resolution.value, { operators }));
    }
  }
  return found;
}

function failure(
  diagnostics: readonly DerivedResultDiagnostic[],
): Extract<DerivedResultExtraction, { ok: false }> {
  const [first, ...rest] = diagnostics;
  if (first === undefined) throw new Error("A failure requires a diagnostic.");
  return deepFreeze({ ok: false, diagnostics: [first, ...rest] as const });
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
