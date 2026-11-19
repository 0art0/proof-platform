import {
  alphaEquivalent,
  matchExpressionPattern,
  previewGeneralizedRewrite,
  rewriteRelationOf,
  type KernelResult,
  type ResultInstantiation,
  type TransitionClass,
} from "@proof/kernel";
import type { LibraryResult } from "@proof/library";
import {
  binderShape,
  canonicalJson,
  type OperatorDeclaration,
  type PlainMathJson,
  type ExecutableProofState,
} from "@proof/mathjson-model";
import { libraryResultToKernelResult, type GeneralizedRewriteSeed } from "@proof/moves";
import type { ResolvedProofSelection } from "@proof/selections";
import { DiscriminationTree } from "./discrimination-tree";
import type { RetrievalSuggestion } from "./index";
import { functionParts } from "./matching";

export type CheckedRewrite = GeneralizedRewriteSeed &
  Readonly<{
    replacement: PlainMathJson;
    obligations: readonly PlainMathJson[];
    transitionClass: TransitionClass;
  }>;

type RewriteSubject = Readonly<{ id: string; selection: ResolvedProofSelection }>;
type Direction = GeneralizedRewriteSeed["direction"];
type RewriteProbe = Omit<GeneralizedRewriteSeed, "congruenceResultIds">;

type IndexedRule = Readonly<{
  result: KernelResult;
  library: LibraryResult;
  pattern: PlainMathJson;
  premises: readonly { expression: PlainMathJson }[];
  direction: Direction;
  premiseIndex?: number;
}>;

const DIRECTIONS = ["forward", "backward"] as const;
const MATCH_OPTIONS = { associativeGrouping: false };
const MAX_INSTANTIATIONS_PER_RULE = 16;

export class GeneralizedRewriteIndex {
  readonly #rules = new DiscriminationTree<IndexedRule>();
  readonly #results: KernelResult[] = [];

  constructor(results: readonly LibraryResult[], operators: readonly OperatorDeclaration[]) {
    for (const library of results) {
      if (library.approval.status !== "approved") continue;
      const adapted = libraryResultToKernelResult(library, { operators });
      if (!adapted.ok) continue;
      const { result } = adapted;
      this.#results.push(result);
      const original = result.congruenceRule ?? result;
      const relation = rewriteRelationOf(original.conclusion.expression);
      const wildcards = new Set(result.parameters.map(({ symbol }) => symbol));
      const insert = (
        left: PlainMathJson,
        right: PlainMathJson,
        premises: IndexedRule["premises"],
        premiseIndex?: number,
      ): void => {
        for (const direction of DIRECTIONS) {
          const pattern = direction === "forward" ? left : right;
          const rule = {
            result,
            library,
            pattern,
            premises,
            direction,
            ...(premiseIndex === undefined ? {} : { premiseIndex }),
          };
          // A fixed binder variable may be alpha-renamed at the occurrence.
          if (containsBinder(pattern, operators)) {
            this.#rules.insert("wild", new Set(["wild"]), MATCH_OPTIONS, "", rule);
          } else {
            this.#rules.insert(pattern, wildcards, MATCH_OPTIONS, "", rule);
          }
        }
      };
      if (relation !== undefined) insert(relation.left, relation.right, original.premises);
      for (const [index, premise] of result.premises.entries()) {
        insert(
          premise.expression,
          result.conclusion.expression,
          result.premises.filter((_, position) => index !== position),
          index,
        );
      }
    }
  }

  query(
    state: ExecutableProofState,
    subjects: readonly RewriteSubject[],
    operators: readonly OperatorDeclaration[],
    resultId: string | undefined,
  ): readonly RetrievalSuggestion[] {
    const result = new Map<string, RetrievalSuggestion>();
    const pairs = rewriteSubjects(subjects);
    const environment = { operators, results: this.#results };
    for (const { occurrence, source } of pairs) {
      const { selection } = occurrence;
      const { target, statement } = selection.anchor;
      const entries = target.kind === "goal" ? state.goals : state.obligations;
      const context = entries.find(({ id }) => id === target.id)?.sequent.context;
      if (context === undefined) continue;
      const address = {
        target,
        statement,
        path: selection.kind === "exact" ? selection.path : selection.containerPath,
        ...(selection.kind === "associative"
          ? { lens: { startOperand: selection.startOperand, endOperand: selection.endOperand } }
          : {}),
      };
      const record = (
        seed: RewriteProbe,
        library?: LibraryResult,
        index = 0,
        hypothesisIndex?: number,
      ): void => {
        const checked = previewGeneralizedRewrite(state, seed, environment);
        if (!checked.ok) return;
        const key = canonicalJson([
          seed.source.kind,
          seed.source.kind === "result" ? seed.source.resultId : seed.source.hypothesisId,
          occurrence.id,
          checked.relation,
          checked.replacement,
          checked.obligations,
        ]);
        if (!result.has(key)) {
          result.set(
            key,
            rewriteSuggestion(occurrence, source, seed, checked, library, index, hypothesisIndex),
          );
        }
      };
      for (const [hypothesisIndex, hypothesis] of context.hypotheses.entries()) {
        if (resultId !== undefined) break;
        const selected = source?.selection.anchor.statement;
        if (selected?.kind === "hypothesis" && hypothesis.id !== selected.id) continue;
        if (statement.kind === "hypothesis" && statement.id === hypothesis.id) continue;
        if (!canSupplyRelation(hypothesis.statement.expression)) continue;
        for (const direction of DIRECTIONS) {
          record(
            { ...address, direction, source: { kind: "hypothesis", hypothesisId: hypothesis.id } },
            undefined,
            0,
            hypothesisIndex + 1,
          );
        }
      }
      if (source !== undefined) continue;
      for (const {
        result: rule,
        library,
        pattern,
        premises,
        direction,
        premiseIndex,
      } of this.#rules.retrieve(selection.fragment)) {
        if (
          (resultId !== undefined && rule.id !== resultId) ||
          !rule.directions.includes(statement.kind === "conclusion" ? "backward" : "forward")
        )
          continue;
        const parameters = rule.parameters.map(({ symbol }) => symbol);
        const bindings = matchExpressionPattern(pattern, selection.fragment, parameters, {
          operators,
        });
        if (bindings === undefined) continue;
        const instances = completeFromHypotheses(
          bindings,
          parameters,
          premises,
          context.hypotheses.map(({ statement }) => statement.expression),
          operators,
        );
        instances.forEach((instantiation, index) =>
          record(
            {
              ...address,
              direction,
              source: {
                kind: "result",
                resultId: rule.id,
                instantiation,
                ...(premiseIndex === undefined ? {} : { premiseIndex }),
              },
            },
            library,
            index,
          ),
        );
      }
    }
    return [...result.values()];
  }
}

function containsBinder(
  expression: PlainMathJson,
  operators: readonly OperatorDeclaration[],
): boolean {
  const parts = functionParts(expression);
  return (
    parts !== undefined &&
    (binderShape(parts.operator, parts.operands.length, operators) !== undefined ||
      parts.operands.some((operand) => containsBinder(operand, operators)))
  );
}

function canSupplyRelation(expression: PlainMathJson): boolean {
  const parts = functionParts(expression);
  if (parts?.operator !== "ForAll") return rewriteRelationOf(expression) !== undefined;
  return parts.operands[1] !== undefined && canSupplyRelation(parts.operands[1]);
}

function rewriteSubjects(
  subjects: readonly RewriteSubject[],
): readonly { occurrence: RewriteSubject; source?: RewriteSubject }[] {
  const first = subjects[0];
  const second = subjects[1];
  if (first === undefined) return [];
  if (subjects.length === 1) return [{ occurrence: first }];
  if (subjects.length !== 2 || second === undefined) return [];
  const left = first.selection.anchor.target;
  const right = second.selection.anchor.target;
  if (left.kind !== right.kind || left.id !== right.id) return [];
  const wholeHypothesis = ({ selection }: RewriteSubject): boolean =>
    selection.kind === "exact" &&
    selection.path.length === 0 &&
    selection.anchor.statement.kind === "hypothesis" &&
    canSupplyRelation(selection.fragment);
  if (wholeHypothesis(first)) return [{ source: first, occurrence: second }];
  return wholeHypothesis(second) ? [{ source: second, occurrence: first }] : [];
}

/** Bind variables absent from the selected side using local instances of a premise. */
function completeFromHypotheses(
  initial: ResultInstantiation,
  parameters: readonly string[],
  premises: readonly { expression: PlainMathJson }[],
  hypotheses: readonly PlainMathJson[],
  operators: readonly OperatorDeclaration[],
): readonly ResultInstantiation[] {
  if (parameters.every((symbol) => Object.hasOwn(initial, symbol))) return [initial];
  let candidates: readonly ResultInstantiation[] = [initial];
  for (const { expression } of premises) {
    const matches = hypotheses.flatMap((hypothesis) => {
      const match = matchExpressionPattern(expression, hypothesis, parameters, { operators });
      return match === undefined ? [] : [match];
    });
    const next = new Map(candidates.map((entry) => [canonicalJson(entry), entry]));
    for (const entry of candidates) {
      for (const match of matches) {
        if (
          Object.entries(match).some(([symbol, value]) => {
            const prior = entry[symbol];
            return prior !== undefined && !alphaEquivalent(prior, value, { operators });
          })
        ) {
          continue;
        }
        const merged = { ...match, ...entry };
        next.set(canonicalJson(merged), merged);
      }
    }
    candidates = [...next.values()]
      .sort((left, right) => Object.keys(right).length - Object.keys(left).length)
      .slice(0, MAX_INSTANTIATIONS_PER_RULE);
  }
  // The preview decides which declarations really require a binding and rejects missing input.
  return candidates;
}

function rewriteSuggestion(
  occurrence: RewriteSubject,
  source: RewriteSubject | undefined,
  seed: RewriteProbe,
  checked: Extract<ReturnType<typeof previewGeneralizedRewrite>, { ok: true }>,
  library: LibraryResult | undefined,
  index: number,
  hypothesisIndex: number | undefined,
): RetrievalSuggestion {
  const { relation, replacement, obligations, transitionClass, congruenceResultIds } = checked;
  const artifactId = library?.id ?? "move:generalized-rewrite";
  const patternId =
    library === undefined ? "move-pattern:generalized-rewrite" : `rewrite:${seed.direction}`;
  const sourceId =
    seed.source.kind === "hypothesis" ? seed.source.hypothesisId : seed.source.resultId;
  const premise = seed.source.kind === "result" ? seed.source.premiseIndex : undefined;
  const id = [
    "rewrite",
    seed.source.kind,
    sourceId,
    occurrence.id,
    seed.direction,
    String(premise ?? "source"),
    String(index),
  ]
    .map((part) => `${part.length}:${part}`)
    .join(":");
  return {
    id,
    source: library === undefined ? "move" : "result",
    artifactId,
    patternId,
    name: library?.name ?? `Rewrite with hypothesis ${hypothesisIndex ?? ""}`.trim(),
    exactRepresentationMatch: true,
    substitutions:
      seed.source.kind === "hypothesis"
        ? []
        : Object.entries(seed.source.instantiation)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([symbol, expression]) => ({ symbol, expression })),
    rank: [
      -1,
      obligations.length === 0 ? 1 : 0,
      1,
      1,
      0,
      occurrence.selection.anchor.statement.kind === "conclusion" ? 1 : 0,
      library === undefined ? 10 : 9,
      library?.priority ?? 50,
    ],
    reasons: [
      `The selected fragment matches the ${seed.direction === "forward" ? "left" : "right"} side of the source.`,
      `The kernel checked transport of ${relation} to the selected statement.`,
      obligations.length === 0
        ? "The rewrite adds no side obligations."
        : `The rewrite adds ${obligations.length} side obligation(s).`,
    ],
    selectionMatches: [
      {
        selectionId: occurrence.id,
        patternId,
        ...(library === undefined ? { selectionSlotId: "occurrence" } : {}),
      },
      ...(source === undefined ? [] : [{ selectionId: source.id, selectionSlotId: "source" }]),
    ],
    unresolvedSelectionSlots: [],
    unresolvedParameters: [],
    applicability: "applicable",
    abstractionFit: "not-used",
    rewriteRelation: relation,
    rewrite: { ...seed, replacement, obligations, transitionClass, congruenceResultIds },
  };
}
