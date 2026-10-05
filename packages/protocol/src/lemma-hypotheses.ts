/**
 * Which hypotheses of a context a closed subtree actually used (roadmap N44).
 *
 * A pure derivation over the stored establishing route steps: the hypothesis IDs each stored kernel
 * operation names, closed over hypotheses the route itself produced (an expanded conjunct, an
 * instantiated universal, an unpacked existential...) back to the hypotheses of the context the
 * subtree started from. Nothing is recomputed from history and no kernel is called.
 *
 * Soundness comes before economy. An operation kind this table does not know, a step whose support
 * the kernel did not check (an accepted background inference), and construction operations are
 * treated as using every hypothesis of the context, and the reason is recorded. Unused
 * hypotheses are never silently dropped on the strength of a guess.
 */
import type { DiscoveryRouteStep } from "./discovery-tree";

export type ConservativeHypothesisUse = Readonly<{
  edgeId: string;
  operationKind: string;
  reason: string;
}>;

export type HypothesisUsage = Readonly<{
  /** Context hypotheses the route used, in context order. */
  usedHypothesisIds: readonly string[];
  /** Context hypotheses no establishing step used (dropped from the lemma). */
  unusedHypothesisIds: readonly string[];
  /** Steps whose usage could not be determined, which forced every hypothesis to be kept. */
  conservative: readonly ConservativeHypothesisUse[];
}>;

type StepUse = Readonly<{
  /** Hypotheses the step needs whatever happens next. */
  direct: readonly string[];
  /** Hypotheses the step produces. */
  produced?: readonly string[];
  /** Hypotheses the step needs only if one of the hypotheses it produces is needed. */
  viaProduced?: readonly string[];
  /**
   * Set when the step may also rely on a context hypothesis its record does not name: if one of
   * the hypotheses it produces is needed, every hypothesis is kept for this reason.
   */
  untracedIfProducedNeeded?: string;
}>;

type OperationRecord = Readonly<Record<string, unknown>>;

const NO_USE: StepUse = { direct: [] };

function ids(...values: readonly unknown[]): string[] {
  return values.flat().filter((value): value is string => typeof value === "string");
}

function statementHypothesis(statement: unknown): string[] {
  const record = statement as { kind?: unknown; id?: unknown } | undefined;
  return record?.kind === "hypothesis" ? ids(record.id) : [];
}

function sourceHypothesis(source: unknown): string[] {
  const record = source as { kind?: unknown; hypothesisId?: unknown } | undefined;
  return record?.kind === "hypothesis" ? ids(record.hypothesisId) : [];
}

/** The use of one stored operation, or a reason string when it cannot be determined. */
function stepUse(operation: OperationRecord): StepUse | string {
  switch (operation["kind"]) {
    case "close-true":
    case "close-reflexive-equality":
    case "split-goal-conjunction":
    case "choose-goal-disjunct":
    case "replace-goal":
    case "suffices":
    case "choose-existential-witness":
    case "drop-hypothesis":
    case "apply-result-backward":
      return NO_USE;
    case "introduce-universal":
      // A typed binder produces the membership hypothesis `x ∈ S`, which needs nothing before it.
      return { direct: [], produced: ids(operation["membershipHypothesisId"]) };
    case "introduce-implication":
    case "introduce-negation":
    case "assume-hypothesis":
      return { direct: [], produced: ids(operation["hypothesisId"]) };
    case "split-classical-cases":
      return { direct: [], produced: ids(operation["branchHypothesisIds"]) };
    case "close-by-hypothesis":
    case "close-false-hypothesis":
      return { direct: ids(operation["hypothesisId"]) };
    case "split-hypothesis-disjunction":
      return {
        direct: ids(operation["hypothesisId"]),
        produced: ids(operation["branchHypothesisIds"]),
      };
    case "close-by-contradiction":
      return { direct: ids(operation["hypothesisId"], operation["negationHypothesisId"]) };
    case "rewrite-with-equality":
      return {
        direct: ids(operation["equalityHypothesisId"], statementHypothesis(operation["statement"])),
      };
    case "rewrite-with-equivalence":
    case "rewrite-with-implication":
      return {
        direct: [
          ...sourceHypothesis(operation["source"]),
          ...statementHypothesis(operation["statement"]),
        ],
      };
    case "expand-hypothesis-conjunction":
      return {
        direct: [],
        produced: ids(operation["expandedHypothesisIds"]),
        viaProduced: ids(operation["hypothesisId"]),
      };
    case "unpack-existential-hypothesis":
      // A typed binder also produces `w ∈ S`; using only that still uses the unpacked hypothesis.
      return {
        direct: [],
        produced: ids(operation["resultHypothesisId"], operation["membershipHypothesisId"]),
        viaProduced: ids(operation["hypothesisId"]),
      };
    case "instantiate-universal-hypothesis":
      // A typed binder `∀x∈S` instantiated at `t` is discharged by any hypothesis stating `t ∈ S`
      // without the record naming it; only an obligation ID shows the membership was not found.
      return {
        direct: [],
        produced: ids(operation["resultHypothesisId"]),
        viaProduced: ids(operation["hypothesisId"]),
        ...(operation["membershipObligationId"] === undefined
          ? {
              untracedIfProducedNeeded:
                "an instantiated universal may have been discharged by a membership hypothesis the record does not name",
            }
          : {}),
      };
    case "apply-implication-hypothesis":
      return {
        direct: [],
        produced: ids(operation["resultHypothesisId"]),
        viaProduced: ids(operation["implicationHypothesisId"], operation["antecedentHypothesisId"]),
      };
    case "apply-result-forward":
      return {
        direct: [],
        produced: ids(operation["resultHypothesisId"]),
        viaProduced: ids(operation["premiseHypothesisIds"]),
      };
    case "close-by-accepted-inference":
      return "an accepted background inference is not checked against the context";
    case "mark-sorry":
    case "close-by-assumption":
      return "a sorry or assumption step is not checked against the context";
    default:
      return `the operation kind ${String(operation["kind"])} has no recorded hypothesis usage`;
  }
}

function keepAll(
  contextHypothesisIds: readonly string[],
  conservative: readonly ConservativeHypothesisUse[],
): HypothesisUsage {
  return { usedHypothesisIds: [...contextHypothesisIds], unusedHypothesisIds: [], conservative };
}

/** Derive the hypotheses of `contextHypothesisIds` that the establishing route steps used. */
export function usedHypotheses(
  contextHypothesisIds: readonly string[],
  steps: readonly DiscoveryRouteStep[],
): HypothesisUsage {
  const conservative: ConservativeHypothesisUse[] = [];
  const uses: { edgeId: string; operationKind: string; use: StepUse }[] = [];
  for (const step of steps) {
    const operation = step.operation as unknown as OperationRecord;
    const operationKind = String(operation["kind"]);
    if (step.evidence === "background-inference" || step.evidence === "sorry") {
      conservative.push({
        edgeId: step.edgeId,
        operationKind,
        reason: "its support is not checked against the context, so every hypothesis is kept",
      });
      continue;
    }
    const use = stepUse(operation);
    if (typeof use === "string") {
      conservative.push({
        edgeId: step.edgeId,
        operationKind,
        reason: `${use}, so every hypothesis is kept`,
      });
    } else {
      uses.push({ edgeId: step.edgeId, operationKind, use });
    }
  }
  if (conservative.length > 0) return keepAll(contextHypothesisIds, conservative);
  const needed = new Set<string>(uses.flatMap(({ use }) => use.direct));
  for (let grew = true; grew;) {
    grew = false;
    for (const { use } of uses) {
      if (use.produced === undefined || !use.produced.some((id) => needed.has(id))) continue;
      for (const id of use.viaProduced ?? []) {
        if (!needed.has(id)) {
          needed.add(id);
          grew = true;
        }
      }
    }
  }
  for (const { edgeId, operationKind, use } of uses) {
    if (use.untracedIfProducedNeeded === undefined) continue;
    if (use.produced?.some((id) => needed.has(id)) !== true) continue;
    conservative.push({
      edgeId,
      operationKind,
      reason: `${use.untracedIfProducedNeeded}, so every hypothesis is kept`,
    });
  }
  // Every hypothesis the route needs must be a hypothesis of the context or one a step produced;
  // an ID of unknown origin could be a context hypothesis the trace missed.
  const known = new Set<string>([
    ...contextHypothesisIds,
    ...uses.flatMap(({ use }) => use.produced ?? []),
  ]);
  for (const stray of [...needed].filter((id) => !known.has(id))) {
    const naming = uses.find(({ use }) =>
      [...use.direct, ...(use.viaProduced ?? [])].includes(stray),
    );
    conservative.push({
      edgeId: naming?.edgeId ?? "",
      operationKind: naming?.operationKind ?? "",
      reason: `the hypothesis ${stray} is neither in the context nor produced by an earlier step, so every hypothesis is kept`,
    });
  }
  if (conservative.length > 0) return keepAll(contextHypothesisIds, conservative);
  return {
    usedHypothesisIds: contextHypothesisIds.filter((id) => needed.has(id)),
    unusedHypothesisIds: contextHypothesisIds.filter((id) => !needed.has(id)),
    conservative: [],
  };
}
