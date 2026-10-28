/**
 * The deterministic half of walking a proof plan (`docs/motivated-proof-plans.md` section 3): the
 * planner's context, the focus of a unit, the realization checks, and the candidate actions Jev
 * chooses among. Nothing here calls a model or changes proof state.
 */
import { alphaEquivalent } from "@proof/kernel";
import { createLatexRenderer, type LatexRenderer } from "@proof/language";
import type { LibraryResult } from "@proof/library";
import {
  MAX_PROOF_PLAN_HYPOTHESES,
  MAX_PROOF_PLAN_LIBRARY_RESULTS,
  MAX_TRANSLATOR_CANDIDATES,
  criterionLabel,
  type ProofPlanStep,
  type ProofPlanUnit,
  type ProofPlannerContext,
  type TranslatorCandidate,
  type TranslatorSelection,
} from "@proof/llm";
import type { PlainMathJson } from "@proof/mathjson-model";
import {
  prepareDisplayedSuggestionSet,
  type DisplayedSuggestionSet,
  type OperatorDeclaration,
  type ProofNode,
  type ProofSessionMetadata,
} from "@proof/protocol";
import type { RetrievalIndex } from "@proof/retrieval";
import { expressionAtPath, listExpressionPaths } from "@proof/selections";

type Goal = ProofNode["state"]["goals"][number];
type Operators = readonly OperatorDeclaration[];

/** Never offered to Jev: sorries stay user-selected and attestation is a separate role. */
const EXCLUDED_ARTIFACTS: ReadonlySet<string> = new Set([
  "move:mark-sorry",
  "move:close-by-accepted-inference",
]);
const MAX_SELECTION_SETS = 64;
const MAX_REWRITE_SUBTERMS = 16;
const MAX_HYPOTHESES_PAIRED = 24;

const renderers = new Map<string, LatexRenderer>();
const RENDERER_CACHE_LIMIT = 16;

/** Renderers build a Compute Engine dictionary; reuse one per operator environment. */
export function latexRenderer(operators: Operators): LatexRenderer {
  const key = JSON.stringify(operators);
  const cached = renderers.get(key);
  if (cached !== undefined) return cached;
  const renderer = createLatexRenderer({ operators });
  if (renderers.size >= RENDERER_CACHE_LIMIT) {
    renderers.delete(renderers.keys().next().value as string);
  }
  renderers.set(key, renderer);
  return renderer;
}

function sortText(sort: unknown): string {
  const kind = (sort as { kind?: unknown } | null)?.kind;
  return kind === "proposition" ? "proposition" : JSON.stringify(sort);
}

// ---------------------------------------------------------------------------------------------
// The planner's context
// ---------------------------------------------------------------------------------------------

export type PlannerContextInput = Readonly<{
  node: ProofNode;
  metadata: ProofSessionMetadata | undefined;
  operators: Operators;
  results: readonly LibraryResult[];
}>;

/**
 * The planner proves the first open goal of the current node from its hypotheses. Library results
 * are shown with their own results first and derived variants after, up to the limit.
 */
export function plannerContext(
  input: PlannerContextInput,
): Readonly<{ ok: true; context: ProofPlannerContext }> | Readonly<{ ok: false; message: string }> {
  const { node, metadata, operators } = input;
  if (metadata === undefined) {
    return { ok: false, message: "The session records no problem statement to plan from." };
  }
  const goal = node.state.goals[0];
  if (goal === undefined) return { ok: false, message: "Nothing is left to prove." };
  const hypotheses = goal.sequent.context.hypotheses;
  if (hypotheses.length > MAX_PROOF_PLAN_HYPOTHESES) {
    return { ok: false, message: "The goal has too many hypotheses to plan from." };
  }
  const latex = latexRenderer(operators);
  const isVariant = (result: LibraryResult) => result.provenance.kind === "derived-variant";
  const shown = [
    ...input.results.filter((result) => !isVariant(result)),
    ...input.results.filter(isVariant),
  ].slice(0, MAX_PROOF_PLAN_LIBRARY_RESULTS);
  return {
    ok: true,
    context: {
      problem: { title: metadata.problem.title, statement: metadata.problem.statement },
      background: metadata.background,
      constants: [...operators].slice(0, 128),
      library: shown.map(({ id, name, description, statement, premises }) => ({
        id,
        name,
        description,
        statement: latex.serialize(statement.expression),
        premises: premises.map((premise) => latex.serialize(premise.expression)),
      })),
      initialState: {
        nodeId: node.id,
        goalId: goal.id,
        declarations: goal.sequent.context.declarations.map(({ symbol, sort }) => ({
          symbol,
          sort: sortText(sort),
        })),
        hypotheses: hypotheses.map((hypothesis, index) => ({
          label: `H${index + 1}`,
          statementId: hypothesis.id,
          latex: latex.serialize(hypothesis.statement.expression),
        })),
        goal: latex.serialize(goal.sequent.conclusion.expression),
      },
    },
  };
}

/** Parse a claim's LaTeX in the session's notation; undefined when it is prose only or unparsable. */
export function parseClaim(
  latex: string | null | undefined,
  operators: Operators,
): PlainMathJson | undefined {
  if (latex === null || latex === undefined) return undefined;
  const parsed = latexRenderer(operators).parse(latex);
  return parsed.ok ? parsed.expression : undefined;
}

/**
 * The plan's statements as LaTeX serialized from their parsed MathJSON, by step: the only LaTeX a
 * client typesets. The model's own LaTeX is text; a statement that does not parse is `null`.
 */
export function renderedLatex(
  plan: Readonly<{ theorem: ProofPlanStep["claim"]; steps: readonly ProofPlanStep[] }>,
  operators: Operators,
): Readonly<{
  theorem: string | null;
  steps: Readonly<
    Record<
      string,
      Readonly<{ claim: string | null; term: string | null; assumptions: (string | null)[] }>
    >
  >;
}> {
  const latex = latexRenderer(operators);
  const render = (source: string | null | undefined) => {
    const parsed = parseClaim(source, operators);
    return parsed === undefined ? null : latex.serialize(parsed);
  };
  return {
    theorem: render(plan.theorem?.latex),
    steps: Object.fromEntries(
      plan.steps.map((step) => [
        step.id,
        {
          claim: render(step.claim?.latex),
          term: render(step.term?.latex),
          assumptions: step.assumptions.map(({ latex: source }) => render(source)),
        },
      ]),
    ),
  };
}

/** The claims, assumptions and witnesses of a plan whose LaTeX does not parse, by step. */
export function unparsedLatex(
  steps: readonly ProofPlanStep[],
  operators: Operators,
): readonly Readonly<{ stepId: string; field: string }>[] {
  const warnings: { stepId: string; field: string }[] = [];
  for (const step of steps) {
    const fields: [string, string | null | undefined][] = [
      ["claim", step.claim?.latex],
      ["term", step.term?.latex],
      ...step.assumptions.map(({ latex }, index): [string, string | null] => [
        `assumptions.${index}`,
        latex,
      ]),
    ];
    for (const [field, latex] of fields) {
      if (latex !== null && latex !== undefined && parseClaim(latex, operators) === undefined) {
        warnings.push({ stepId: step.id, field });
      }
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------------------------
// Focus and realization
// ---------------------------------------------------------------------------------------------

export type UnitFocus = Readonly<{
  /** The focus at the start of the unit. */
  start: Goal;
  /** The open goals that now stand for it: itself while it is open, else the goals created since. */
  successors: readonly Goal[];
}>;

/** Follow the focus from the unit's start node to the current one (goal IDs survive updates). */
export function followFocus(
  startNode: ProofNode,
  startFocusId: string,
  current: ProofNode,
): UnitFocus | undefined {
  const start = startNode.state.goals.find(({ id }) => id === startFocusId);
  if (start === undefined) return undefined;
  const same = current.state.goals.find(({ id }) => id === startFocusId);
  if (same !== undefined) return { start, successors: [same] };
  const before = new Set(startNode.state.goals.map(({ id }) => id));
  return { start, successors: current.state.goals.filter(({ id }) => !before.has(id)) };
}

export type UnitOutputs = Readonly<{
  /** The goal later steps of the same list work on, when there is one. */
  focusTargetId?: string | undefined;
  /** For a `cases` unit: the goal of each case, by case step label. */
  caseTargets?: Readonly<Record<string, string>> | undefined;
  /** The hypotheses the step's label now names (its fact, its assumptions or picked facts). */
  produced: readonly string[];
}>;

export type Realization =
  | Readonly<{ realized: true; outputs: UnitOutputs }>
  | Readonly<{ realized: false; decidable: boolean }>;

type CheckInput = Readonly<{
  unit: ProofPlanUnit;
  step: ProofPlanStep;
  /** The `case` children of a `cases` step, in order. */
  cases: readonly ProofPlanStep[];
  focus: UnitFocus;
  movesApplied: number;
  operators: Operators;
}>;

const NOT_YET: Realization = { realized: false, decidable: true };
const UNDECIDED: Realization = { realized: false, decidable: false };

function equivalent(left: PlainMathJson, right: PlainMathJson, operators: Operators): boolean {
  return alphaEquivalent(left, right, { operators });
}

function newHypotheses(start: Goal, goal: Goal): Goal["sequent"]["context"]["hypotheses"] {
  const before = new Set(start.sequent.context.hypotheses.map(({ id }) => id));
  return goal.sequent.context.hypotheses.filter(({ id }) => !before.has(id));
}

/** Whether the unit's effect (section 2.3) is present; section 3.3 of the design document. */
export function checkRealization(input: CheckInput): Realization {
  const { step, focus, operators, movesApplied } = input;
  const claim = parseClaim(step.claim?.latex, operators);
  const [only, ...others] = focus.successors;
  const single = only !== undefined && others.length === 0 ? only : undefined;
  const conclusionOf = (goal: Goal) => goal.sequent.conclusion.expression;
  const changed = (goal: Goal) =>
    !equivalent(conclusionOf(goal), conclusionOf(focus.start), operators);

  switch (step.form) {
    case "qed":
      // The goal was open at the unit's start; once it and everything since are closed, the QED
      // holds, even when an earlier step's move closed it.
      return focus.successors.length === 0
        ? { realized: true, outputs: { produced: [] } }
        : NOT_YET;
    case "have": {
      if (claim === undefined) return movesApplied > 0 ? UNDECIDED : NOT_YET;
      for (const goal of focus.successors) {
        const match = goal.sequent.context.hypotheses.find(({ statement }) =>
          equivalent(statement.expression, claim, operators),
        );
        if (match !== undefined) {
          return { realized: true, outputs: { focusTargetId: goal.id, produced: [match.id] } };
        }
      }
      return NOT_YET;
    }
    case "suffices": {
      if (single === undefined || movesApplied === 0) return NOT_YET;
      const added = newHypotheses(focus.start, single);
      const outputs = { focusTargetId: single.id, produced: added.map(({ id }) => id) };
      if (claim === undefined) {
        return changed(single) && added.length >= step.assumptions.length
          ? { realized: true, outputs }
          : UNDECIDED;
      }
      if (!equivalent(conclusionOf(single), claim, operators)) return NOT_YET;
      const assumed = step.assumptions.map(({ latex }) => parseClaim(latex, operators));
      const allPresent = assumed.every(
        (assumption) =>
          assumption === undefined ||
          single.sequent.context.hypotheses.some(({ statement }) =>
            equivalent(statement.expression, assumption, operators),
          ),
      );
      return allPresent ? { realized: true, outputs } : NOT_YET;
    }
    case "cases": {
      const goals = focus.successors;
      if (goals.length < input.cases.length || goals.includes(focus.start)) return NOT_YET;
      const remaining = [...goals];
      const caseTargets: Record<string, string> = {};
      // A parsed condition picks the goal that gained it; the rest are matched in order.
      for (const entry of input.cases) {
        const condition = parseClaim(entry.claim?.latex, operators);
        const index =
          condition === undefined
            ? -1
            : remaining.findIndex((goal) =>
                newHypotheses(focus.start, goal).some(({ statement }) =>
                  equivalent(statement.expression, condition, operators),
                ),
              );
        if (index >= 0) caseTargets[entry.id] = remaining.splice(index, 1)[0]!.id;
      }
      for (const entry of input.cases) {
        if (caseTargets[entry.id] === undefined) caseTargets[entry.id] = remaining.shift()!.id;
      }
      return { realized: true, outputs: { caseTargets, produced: [] } };
    }
    case "pick": {
      if (single === undefined || movesApplied === 0) return NOT_YET;
      const declarations =
        single.sequent.context.declarations.length -
        focus.start.sequent.context.declarations.length;
      const added = newHypotheses(focus.start, single);
      if (declarations < step.variables.length || added.length === 0) return NOT_YET;
      const matching =
        claim === undefined
          ? []
          : added.filter(({ statement }) => equivalent(statement.expression, claim, operators));
      const produced = (matching.length > 0 ? matching : added).map(({ id }) => id);
      return { realized: true, outputs: { focusTargetId: single.id, produced } };
    }
    case "witness": {
      if (single === undefined || movesApplied === 0 || !changed(single)) return NOT_YET;
      if (claim !== undefined && !equivalent(conclusionOf(single), claim, operators)) {
        return NOT_YET;
      }
      return { realized: true, outputs: { focusTargetId: single.id, produced: [] } };
    }
    case "case":
    case "assume":
      return NOT_YET;
  }
}

// ---------------------------------------------------------------------------------------------
// Candidate actions
// ---------------------------------------------------------------------------------------------

type Statement =
  | Readonly<{ kind: "conclusion"; expression: PlainMathJson }>
  | Readonly<{ kind: "hypothesis"; id: string; expression: PlainMathJson }>;

function statementsOf(goal: Goal): readonly Statement[] {
  return [
    { kind: "conclusion", expression: goal.sequent.conclusion.expression },
    ...goal.sequent.context.hypotheses.map(({ id, statement }) => ({
      kind: "hypothesis" as const,
      id,
      expression: statement.expression,
    })),
  ];
}

function selectionOf(
  node: ProofNode,
  goal: Goal,
  statement: Statement,
  path: readonly number[] = [],
): TranslatorSelection {
  return {
    kind: "exact",
    anchor: {
      stateId: node.state.id,
      target: { kind: "goal", id: goal.id },
      statement:
        statement.kind === "conclusion"
          ? { kind: "conclusion" }
          : { kind: "hypothesis", id: statement.id },
    },
    path: [...path],
  };
}

function selectionKey(selections: readonly TranslatorSelection[]): string {
  return JSON.stringify(selections.map(({ anchor, path }) => [anchor.statement, path]));
}

/**
 * The selection sets of section 3.2, in order: everything the step acts on together, each of
 * those alone, the conclusion, each hypothesis, the conclusion with each hypothesis, and each
 * equation or equivalence with every occurrence of one of its sides in another statement.
 */
export function selectionSets(
  node: ProofNode,
  goal: Goal,
  actsOn: readonly ("conclusion" | string)[],
  operators: Operators,
): readonly (readonly TranslatorSelection[])[] {
  const statements = statementsOf(goal);
  const conclusion = statements[0]!;
  const hypotheses = statements.slice(1).slice(0, MAX_HYPOTHESES_PAIRED);
  const named = actsOn.flatMap((reference) => {
    const found =
      reference === "conclusion"
        ? conclusion
        : statements.find((entry) => entry.kind === "hypothesis" && entry.id === reference);
    return found === undefined ? [] : [found];
  });
  const sets: TranslatorSelection[][] = [];
  const seen = new Set<string>();
  const add = (selections: TranslatorSelection[]) => {
    const key = selectionKey(selections);
    if (selections.length === 0 || seen.has(key) || sets.length >= MAX_SELECTION_SETS) return;
    seen.add(key);
    sets.push(selections);
  };
  if (named.length > 1) add(named.map((entry) => selectionOf(node, goal, entry)));
  for (const entry of named) add([selectionOf(node, goal, entry)]);
  add([selectionOf(node, goal, conclusion)]);
  for (const hypothesis of hypotheses) add([selectionOf(node, goal, hypothesis)]);
  for (const hypothesis of hypotheses) {
    add([selectionOf(node, goal, conclusion), selectionOf(node, goal, hypothesis)]);
  }
  for (const equation of hypotheses) {
    const parts = Array.isArray(equation.expression) ? equation.expression : undefined;
    if (parts === undefined || (parts[0] !== "Equal" && parts[0] !== "Equivalent")) continue;
    const sides = parts.slice(1) as PlainMathJson[];
    let found = 0;
    for (const other of statements) {
      if (other === equation) continue;
      for (const path of listExpressionPaths(other.expression)) {
        if (found >= MAX_REWRITE_SUBTERMS) break;
        const subterm = expressionAtPath(other.expression, path);
        if (subterm === undefined) continue;
        if (sides.some((side) => equivalent(subterm, side, operators))) {
          found += 1;
          add([selectionOf(node, goal, equation), selectionOf(node, goal, other, path)]);
        }
      }
    }
  }
  return sets;
}

/** The suggestion request for a selection set, shaped as a recorded request is. */
export function suggestionRequestSelection(selections: readonly TranslatorSelection[]) {
  return selections.length === 1
    ? selections[0]!
    : {
        kind: "selection-query" as const,
        selections: selections.map((selection, position) => ({
          id: `selection:request-${position + 1}`,
          selection,
        })),
      };
}

export type CandidateActions = Readonly<{
  selectionSets: readonly Readonly<{ id: string; selections: readonly TranslatorSelection[] }>[];
  candidates: readonly TranslatorCandidate[];
  /** Candidates dropped beyond the limit. */
  dropped: number;
}>;

type Suggestion = DisplayedSuggestionSet["suggestions"][number];

function applicableSuggestion(suggestion: Suggestion): boolean {
  return (
    !EXCLUDED_ARTIFACTS.has(suggestion.artifactId) &&
    suggestion.unresolvedSelectionSlots.length === 0
  );
}

/**
 * Run the ordinary retrieval on every selection set (in process, recording nothing) and collect
 * each displayed suggestion once per selection set, up to the candidate limit.
 */
export function candidateActions(
  input: Readonly<{
    index: RetrievalIndex;
    node: ProofNode;
    goal: Goal;
    actsOn: readonly string[];
    operators: Operators;
  }>,
): CandidateActions {
  const { index, node, goal, operators } = input;
  const latex = latexRenderer(operators);
  const sets = selectionSets(node, goal, input.actsOn, operators);
  const usedSets: { id: string; selections: readonly TranslatorSelection[] }[] = [];
  const candidates: TranslatorCandidate[] = [];
  let dropped = 0;
  const fragment = (selection: TranslatorSelection) => {
    const statement = selection.anchor.statement;
    const expression =
      statement.kind === "conclusion"
        ? goal.sequent.conclusion.expression
        : goal.sequent.context.hypotheses.find(({ id }) => id === statement.id)?.statement
            .expression;
    const at = expression === undefined ? undefined : expressionAtPath(expression, selection.path);
    return at === undefined ? "?" : latex.serialize(at);
  };
  sets.forEach((selections, setIndex) => {
    const setId = `selection-set:${setIndex + 1}`;
    const prepared = prepareDisplayedSuggestionSet(
      index,
      node,
      {
        id: `suggestion-set:candidates-${setIndex + 1}`,
        selection: suggestionRequestSelection(selections),
      },
      { operators },
    );
    if (!prepared.ok) return;
    let used = false;
    prepared.suggestionSet.suggestions.forEach((suggestion, suggestionIndex) => {
      if (!applicableSuggestion(suggestion)) return;
      if (candidates.length >= MAX_TRANSLATOR_CANDIDATES) {
        dropped += 1;
        return;
      }
      const shown = selections.map(fragment);
      used = true;
      candidates.push({
        id: `candidate:${candidates.length + 1}`,
        label: criterionLabel(`${suggestion.name} — on ${shown.join("; ")}`),
        source: suggestion.source,
        artifactId: suggestion.artifactId,
        selectionSetId: setId,
        suggestionIndex,
        selections: shown,
        reasons: suggestion.reasons.slice(0, 16).map((reason) => criterionLabel(reason)),
      });
    });
    if (used) usedSets.push({ id: setId, selections });
  });
  return { selectionSets: usedSets, candidates, dropped };
}
