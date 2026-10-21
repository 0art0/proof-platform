/**
 * The local situation a move author is shown (design plan section 15.3, 13.3), abstracted
 * deterministically from a move-executor call that was applied.
 *
 * Nothing here is chosen by a model. From the executor call's stored context and stored plan this
 * module produces:
 *
 * - the target sequent restricted to the hypotheses the plan and the selections use and to the
 *   declarations those statements use, with the problem's symbols renamed to neutral names and
 *   every statement, hypothesis and goal ID replaced by a neutral one;
 * - the applied plan with its references and its mathematics renamed the same way;
 * - the outcome: the state that plan leaves from that sequent, by running it through the kernel.
 *
 * The original problem, the other goals and obligations, the discovery history, the branches and
 * the alternative suggestions are never part of the input, so they cannot leak. A plan that the
 * restricted sequent does not run is retried on the whole target sequent; a plan that no
 * abstraction reproduces gives no situation. This module imports nothing from `./index`.
 */
import type { KernelEnvironment } from "@proof/kernel";
import { planMoveSequence } from "@proof/moves";
import {
  RESERVED_BUILTIN_SYMBOLS,
  createProofNodeSchema,
  declarationSchema,
  freeSymbolNames,
  plainMathJsonSchema,
  sortSchema,
  stableIdentifierSchema,
  substituteMathJson,
  type OperatorDeclaration,
  type PlainMathJson,
  type ProofNode,
  type Sort,
} from "@proof/protocol";
import { z } from "zod";
import {
  executorPlanOperations,
  isExecutorStep,
  mapExecutorStepReferences,
  type ExecutorPlanStep,
  type ExecutorResultCard,
} from "./move-executor-plan";

/** Neutral identifiers of the abstracted situation. */
export const SITUATION_STATE_ID = "state:situation";
export const SITUATION_TARGET_ID = "goal:situation";
const SITUATION_CALL_ID = "situation";

const MAX_HYPOTHESES = 64;
const MAX_DECLARATIONS = 256;

const hypothesisSchema = z
  .object({ id: stableIdentifierSchema, expression: plainMathJsonSchema })
  .strict();

/** The sequent the executor was asked about, before its plan. */
export const situationSequentSchema = z
  .object({
    id: stableIdentifierSchema,
    declarations: z.array(declarationSchema).max(MAX_DECLARATIONS),
    hypotheses: z.array(hypothesisSchema).max(MAX_HYPOTHESES),
    conclusion: plainMathJsonSchema,
  })
  .strict();
export type SituationSequent = z.infer<typeof situationSequentSchema>;

/** A goal or obligation the plan leaves. */
export const situationOutcomeSequentSchema = z
  .object({
    kind: z.enum(["goal", "obligation"]),
    id: stableIdentifierSchema,
    declarations: z
      .array(z.object({ symbol: z.string().min(1).max(200), sort: sortSchema }).strict())
      .max(MAX_DECLARATIONS),
    hypotheses: z.array(hypothesisSchema).max(MAX_HYPOTHESES),
    conclusion: plainMathJsonSchema,
  })
  .strict();
export type SituationOutcomeSequent = z.infer<typeof situationOutcomeSequentSchema>;

const operandPathSchema = z.array(z.number().int().nonnegative()).max(64);

/** What the user had selected, in neutral names. */
export const situationSelectionSchema = z
  .object({
    statement: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("conclusion") }).strict(),
      z.object({ kind: z.literal("hypothesis"), id: stableIdentifierSchema }).strict(),
    ]),
    occurrence: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("exact"), path: operandPathSchema }).strict(),
      z
        .object({
          kind: z.literal("associative"),
          containerPath: operandPathSchema,
          startOperand: z.number().int().nonnegative(),
          endOperand: z.number().int().nonnegative(),
        })
        .strict(),
    ]),
    expression: plainMathJsonSchema,
  })
  .strict();
export type SituationSelection = z.infer<typeof situationSelectionSchema>;

const planStepSchema = z.custom<ExecutorPlanStep>(isExecutorStep, {
  message: "A situation plan step must be an allowed kernel operation without state IDs.",
});

export const situationSchema = z
  .object({
    /** Whether the plan was applied to a goal or to an obligation (the situation shows a goal). */
    targetKind: z.enum(["goal", "obligation"]),
    /** Whether the sequent was restricted to the hypotheses the step uses. */
    restricted: z.boolean(),
    before: situationSequentSchema,
    selections: z.array(situationSelectionSchema).max(16),
    plan: z.array(planStepSchema).min(1).max(16),
    after: z
      .object({
        transitionClass: z.enum(["equivalence", "strengthening", "weakening"]),
        goals: z.array(situationOutcomeSequentSchema).max(256),
        obligations: z.array(situationOutcomeSequentSchema).max(256),
      })
      .strict(),
  })
  .strict();
export type Situation = z.infer<typeof situationSchema>;

/** The part of a stored move-executor call the abstraction reads. */
export type ExecutedStepInput = Readonly<{
  target: Readonly<{ kind: "goal" | "obligation"; id: string }>;
  selections: readonly Readonly<{
    location: Readonly<{
      target: Readonly<{ kind: string; id: string }>;
      statement: Readonly<{ kind: "conclusion" } | { kind: "hypothesis"; id: string }>;
      occurrence: SituationSelection["occurrence"];
    }>;
    expression: PlainMathJson;
  }>[];
  sequent: Readonly<{
    declarations: readonly z.infer<typeof declarationSchema>[];
    hypotheses: readonly Readonly<{ id: string; expression: PlainMathJson }>[];
    conclusion: PlainMathJson;
  }>;
  operators: readonly OperatorDeclaration[];
  results: readonly ExecutorResultCard[];
  steps: readonly ExecutorPlanStep[];
}>;

export type AbstractionResult =
  Readonly<{ ok: true; situation: Situation }> | Readonly<{ ok: false; reason: string }>;

/** Abstract the applied step of a stored executor call into a neutral, minimal situation. */
export function abstractSituation(input: ExecutedStepInput): AbstractionResult {
  try {
    const referenced = referencedHypotheses(input);
    const narrow = new Set(
      input.sequent.hypotheses.map(({ id }) => id).filter((id) => referenced.has(id)),
    );
    const whole = new Set(input.sequent.hypotheses.map(({ id }) => id));
    // Narrowest first: only what the step uses. The whole target sequent is the fallback.
    const attempts =
      narrow.size === whole.size
        ? [{ keep: whole, restricted: false }]
        : [
            { keep: narrow, restricted: true },
            { keep: whole, restricted: false },
          ];
    for (const { keep, restricted } of attempts) {
      const attempt = abstractWith(input, keep, restricted);
      if (attempt !== undefined) return { ok: true, situation: attempt };
    }
    return {
      ok: false,
      reason: "The step could not be reproduced on its abstracted situation.",
    };
  } catch {
    return { ok: false, reason: "The step could not be inspected safely." };
  }
}

/** The existing hypotheses that the plan's operations and the user's selections refer to. */
function referencedHypotheses(input: ExecutedStepInput): ReadonlySet<string> {
  const known = new Set(input.sequent.hypotheses.map(({ id }) => id));
  const found = new Set<string>();
  for (const step of input.steps) {
    mapExecutorStepReferences(step, (id) => {
      if (known.has(id)) found.add(id);
      return id;
    });
  }
  for (const { location } of input.selections) {
    if (location.statement.kind === "hypothesis") found.add(location.statement.id);
  }
  return found;
}

function abstractWith(
  input: ExecutedStepInput,
  keep: ReadonlySet<string>,
  restricted: boolean,
): Situation | undefined {
  const operators = input.operators;
  const hypotheses = input.sequent.hypotheses.filter(({ id }) => keep.has(id));
  const selections = input.selections.filter(
    ({ location }) => location.statement.kind === "conclusion" || keep.has(location.statement.id),
  );
  const planExpressions = input.steps.flatMap(stepExpressions);
  const statements: PlainMathJson[] = [
    input.sequent.conclusion,
    ...hypotheses.map(({ expression }) => expression),
    ...selections.map(({ expression }) => expression),
    ...planExpressions,
  ];
  const used = new Set(
    statements.flatMap((expression) => freeSymbolNames(expression, { operators })),
  );
  const declarations = input.sequent.declarations.filter(({ symbol }) => used.has(symbol));

  // Neutral names never collide with any symbol the situation mentions, bound ones included, so
  // renaming cannot make a binder rename itself and break a later reference to its parameter.
  const taken = new Set<string>([
    ...operators.map(({ symbol }) => symbol),
    ...RESERVED_BUILTIN_SYMBOLS,
    ...statements.flatMap((expression) => allSymbols(expression)),
    ...input.sequent.declarations.map(({ symbol }) => symbol),
  ]);
  const renames = new Map<string, string>();
  const counters = new Map<string, number>();
  for (const declaration of declarations) {
    const category = sortCategory(declaration.sort);
    const index = counters.get(category) ?? 0;
    counters.set(category, index + 1);
    const names = NEUTRAL_NAMES[category];
    const base = names[index % names.length] as string;
    const preferred = index < names.length ? base : `${base}${Math.floor(index / names.length)}`;
    const neutral = freshName(preferred, taken);
    taken.add(neutral);
    renames.set(declaration.symbol, neutral);
  }
  const rename = (expression: PlainMathJson): PlainMathJson | undefined => {
    const substitutions = [...renames].map(([symbol, replacement]) => ({ symbol, replacement }));
    if (substitutions.length === 0) return expression;
    const substituted = substituteMathJson(expression, substitutions, { operators });
    return substituted.ok ? substituted.expression : undefined;
  };

  const neutralHypotheses = hypotheses.map(({ id, expression }, index) => ({
    original: id,
    id: `hypothesis:${index + 1}`,
    expression: rename(expression),
  }));
  const conclusion = rename(input.sequent.conclusion);
  if (
    conclusion === undefined ||
    neutralHypotheses.some(({ expression }) => expression === undefined)
  ) {
    return undefined;
  }
  const idMap = new Map<string, string>([
    [input.target.id, SITUATION_TARGET_ID],
    ...neutralHypotheses.map(({ original, id }) => [original, id] as [string, string]),
  ]);
  const neutralDeclarations = declarations.map((declaration) =>
    declarationSchema.safeParse({
      ...declaration,
      id: `declaration:${renames.get(declaration.symbol)}`,
      symbol: renames.get(declaration.symbol) as string,
    }),
  );
  if (neutralDeclarations.some((parsed) => !parsed.success)) return undefined;
  const neutralSelections: SituationSelection[] = [];
  for (const { location, expression } of selections) {
    const renamed = rename(expression);
    if (renamed === undefined) return undefined;
    neutralSelections.push({
      statement:
        location.statement.kind === "conclusion"
          ? { kind: "conclusion" }
          : { kind: "hypothesis", id: idMap.get(location.statement.id) as string },
      occurrence: location.occurrence,
      expression: renamed,
    });
  }
  const steps: ExecutorPlanStep[] = [];
  for (const step of input.steps) {
    const renamed = renameStepMathematics(
      asSituationTarget(mapExecutorStepReferences(step, (id) => idMap.get(id) ?? id)),
      rename,
    );
    if (renamed === undefined) return undefined;
    steps.push(renamed);
  }

  const before: SituationSequent = {
    id: SITUATION_TARGET_ID,
    declarations: neutralDeclarations.flatMap((parsed) => (parsed.success ? [parsed.data] : [])),
    hypotheses: neutralHypotheses.map(({ id, expression }) => ({
      id,
      expression: expression as PlainMathJson,
    })),
    conclusion,
  };
  const node = createProofNodeSchema({ operators }).safeParse(situationNode(before));
  if (!node.success) return undefined;
  const environment = kernelEnvironment(operators, input.results);
  const planned = planMoveSequence(
    node.data.state,
    executorPlanOperations(steps, { stateId: SITUATION_STATE_ID, callId: SITUATION_CALL_ID }),
    environment,
  );
  if (!planned.ok) return undefined;
  type Entry = Readonly<{ id: string; sequent: ProofNode["state"]["goals"][number]["sequent"] }>;
  const outcome = (kind: "goal" | "obligation") => (entry: Entry) => ({
    kind,
    id: neutralLabel(entry.id),
    declarations: entry.sequent.context.declarations.map(({ symbol, sort }) => ({ symbol, sort })),
    hypotheses: entry.sequent.context.hypotheses.map(({ id, statement }) => ({
      id: neutralLabel(id),
      expression: statement.expression,
    })),
    conclusion: entry.sequent.conclusion.expression,
  });
  const situation = {
    targetKind: input.target.kind,
    restricted,
    before,
    selections: neutralSelections,
    plan: steps,
    after: {
      transitionClass: planned.preview.transitionClass,
      goals: planned.preview.state.goals.map(outcome("goal")),
      obligations: planned.preview.state.obligations.map(outcome("obligation")),
    },
  };
  const parsed = situationSchema.safeParse(situation);
  return parsed.success ? (parsed.data as Situation) : undefined;
}

/** The situation shows its target as a goal, so a step on it names a goal even if it was an obligation. */
function asSituationTarget(step: ExecutorPlanStep): ExecutorPlanStep {
  const target = step.target as { kind: string; id: string };
  return target.id === SITUATION_TARGET_ID
    ? ({ ...step, target: { ...target, kind: "goal" } } as ExecutorPlanStep)
    : step;
}

/** The labels the plan introduced carry the call ID the run used; the situation shows the label. */
function neutralLabel(id: string): string {
  return id.startsWith(`${SITUATION_CALL_ID}:`) ? id.slice(SITUATION_CALL_ID.length + 1) : id;
}

/** The proof node of a situation sequent: one goal in the neutral state. */
export function situationNode(before: SituationSequent): unknown {
  return {
    id: "node:situation",
    state: {
      id: SITUATION_STATE_ID,
      goals: [
        {
          id: before.id,
          sequent: {
            context: {
              declarations: before.declarations,
              hypotheses: before.hypotheses.map(({ id, expression }) => ({
                id,
                statement: { expression },
              })),
            },
            conclusion: { expression: before.conclusion },
          },
        },
      ],
      obligations: [],
    },
  };
}

/** The kernel environment in which a stored executor plan runs: the operators and its results. */
export function kernelEnvironment(
  operators: readonly OperatorDeclaration[],
  results: readonly ExecutorResultCard[],
): KernelEnvironment {
  return {
    operators,
    results: results.map((card) => ({
      id: card.id,
      parameters: card.parameters,
      premises: card.premises.map((expression) => ({ expression })),
      conclusion: { expression: card.conclusion },
      directions: card.directions,
    })) as unknown as NonNullable<KernelEnvironment["results"]>,
  };
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

type SortCategory = "proposition" | "predicate" | "function" | "set" | "term";

const NEUTRAL_NAMES: Readonly<Record<SortCategory, readonly string[]>> = {
  proposition: ["P", "Q", "R", "S", "T"],
  predicate: ["A", "B", "C", "D", "E"],
  function: ["f", "g", "h", "k"],
  set: ["X", "Y", "Z", "W"],
  term: ["x", "y", "z", "u", "v", "w", "t"],
};

function sortCategory(sort: Sort): SortCategory {
  if (sort.kind === "proposition") return "proposition";
  if (sort.kind === "function") {
    return sort.signature.result.kind === "proposition" ? "predicate" : "function";
  }
  return sort.id === "sort:set" ? "set" : "term";
}

function freshName(preferred: string, taken: ReadonlySet<string>): string {
  if (!taken.has(preferred)) return preferred;
  let suffix = 1;
  while (taken.has(`${preferred}_${suffix}`)) suffix += 1;
  return `${preferred}_${suffix}`;
}

/** Every symbol an expression mentions: free, bound and function heads. */
function allSymbols(expression: PlainMathJson, found: string[] = []): string[] {
  if (typeof expression === "string") {
    found.push(expression);
  } else if (Array.isArray(expression)) {
    for (const entry of expression) allSymbols(entry as PlainMathJson, found);
  } else if (typeof expression === "object" && expression !== null) {
    if ("sym" in expression && typeof expression.sym === "string") found.push(expression.sym);
    if ("fn" in expression) for (const entry of expression.fn) allSymbols(entry, found);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// The mathematics of a plan step
// ---------------------------------------------------------------------------------------------

/** The expressions a step carries: propositions, terms, witnesses and instantiations. */
function stepExpressions(step: ExecutorPlanStep): readonly PlainMathJson[] {
  const found: PlainMathJson[] = [];
  for (const field of ["proposition", "term", "witness"] as const) {
    const value = step[field];
    if (value !== undefined) found.push(value as PlainMathJson);
  }
  const instantiations = [
    step.instantiation,
    (step.source as { instantiation?: unknown } | undefined)?.instantiation,
  ];
  for (const instantiation of instantiations) {
    if (typeof instantiation === "object" && instantiation !== null) {
      found.push(...(Object.values(instantiation) as PlainMathJson[]));
    }
  }
  return found;
}

/** The step with `rename` applied to every expression it carries; undefined if one cannot be. */
function renameStepMathematics(
  step: ExecutorPlanStep,
  rename: (expression: PlainMathJson) => PlainMathJson | undefined,
): ExecutorPlanStep | undefined {
  const next: Record<string, unknown> = structuredClone(step) as Record<string, unknown>;
  for (const field of ["proposition", "term", "witness"] as const) {
    if (next[field] === undefined) continue;
    const renamed = rename(next[field] as PlainMathJson);
    if (renamed === undefined) return undefined;
    next[field] = renamed;
  }
  const renameRecord = (record: unknown): unknown => {
    if (typeof record !== "object" || record === null) return record;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      const renamed = rename(value as PlainMathJson);
      if (renamed === undefined) throw new Error("rename");
      out[key] = renamed;
    }
    return out;
  };
  try {
    if (next.instantiation !== undefined) next.instantiation = renameRecord(next.instantiation);
    const source = next.source as { kind: string; instantiation?: unknown } | undefined;
    if (source?.instantiation !== undefined) {
      next.source = { ...source, instantiation: renameRecord(source.instantiation) };
    }
  } catch {
    return undefined;
  }
  return next as ExecutorPlanStep;
}
