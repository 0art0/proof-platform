import type { DisplayedSuggestionSet, MovePreview } from "@proof/protocol";

/**
 * Pure projections of stored suggestion and preview records for the suggestion panel
 * (design plan §17.3). Nothing here re-runs retrieval, materialization or the kernel: every
 * value is read from the displayed set or the recorded preview snapshots.
 */

type ProofState = MovePreview["beforeState"];
export type PreviewTarget = ProofState["goals"][number] | ProofState["obligations"][number];
type Hypothesis = PreviewTarget["sequent"]["context"]["hypotheses"][number];
type Assumption = NonNullable<ProofState["assumptions"]>[number];
export type TargetCollection = "goal" | "obligation";

export type StatementChange =
  | Readonly<{ kind: "removed"; collection: TargetCollection; before: PreviewTarget }>
  | Readonly<{
      kind: "updated";
      collection: TargetCollection;
      before: PreviewTarget;
      after: PreviewTarget;
      conclusionChanged: boolean;
      hypothesesRemoved: readonly Hypothesis[];
      hypothesesAdded: readonly Hypothesis[];
    }>
  | Readonly<{ kind: "added"; collection: TargetCollection; after: PreviewTarget }>;

export type PreviewDiff = Readonly<{
  /** Goals then obligations; within each, removed, updated, then added, in snapshot order. */
  changes: readonly StatementChange[];
  /** State-global assumptions present after the move but not before (for example a sorry). */
  assumptionsAdded: readonly Assumption[];
}>;

/**
 * The before → after difference of a recorded preview, keyed by the stored delta. The delta is
 * already checked against both snapshots by the preview schema, so the IDs always resolve.
 */
export function previewDiff(
  preview: Pick<MovePreview, "beforeState" | "afterState" | "delta">,
): PreviewDiff {
  const { beforeState: before, afterState: after, delta } = preview;
  const changes = [
    ...collectionChanges("goal", before.goals, after.goals, delta.goals),
    ...collectionChanges("obligation", before.obligations, after.obligations, delta.obligations),
  ];
  const beforeAssumptions = new Set((before.assumptions ?? []).map(({ id }) => id));
  return {
    changes,
    assumptionsAdded: (after.assumptions ?? []).filter(({ id }) => !beforeAssumptions.has(id)),
  };
}

function collectionChanges(
  collection: TargetCollection,
  before: readonly PreviewTarget[],
  after: readonly PreviewTarget[],
  delta: MovePreview["delta"]["goals"],
): StatementChange[] {
  const removed = new Set<string>(delta.removed);
  const updated = new Set<string>(delta.updated);
  const added = new Set<string>(delta.added);
  const beforeById = new Map(before.map((target) => [target.id as string, target]));
  const changes: StatementChange[] = [];
  for (const target of before) {
    if (removed.has(target.id)) changes.push({ kind: "removed", collection, before: target });
  }
  for (const target of after) {
    const previous = beforeById.get(target.id);
    if (!updated.has(target.id) || previous === undefined) continue;
    const beforeHypotheses = new Map(
      previous.sequent.context.hypotheses.map((hypothesis) => [hypothesis.id, hypothesis]),
    );
    const afterHypotheses = new Map(
      target.sequent.context.hypotheses.map((hypothesis) => [hypothesis.id, hypothesis]),
    );
    changes.push({
      kind: "updated",
      collection,
      before: previous,
      after: target,
      conclusionChanged: !sameJson(
        previous.sequent.conclusion.expression,
        target.sequent.conclusion.expression,
      ),
      hypothesesRemoved: previous.sequent.context.hypotheses.filter(
        (hypothesis) => !sameHypothesis(hypothesis, afterHypotheses.get(hypothesis.id)),
      ),
      hypothesesAdded: target.sequent.context.hypotheses.filter(
        (hypothesis) => !sameHypothesis(hypothesis, beforeHypotheses.get(hypothesis.id)),
      ),
    });
  }
  for (const target of after) {
    if (added.has(target.id)) changes.push({ kind: "added", collection, after: target });
  }
  return changes;
}

function sameHypothesis(left: Hypothesis, right: Hypothesis | undefined): boolean {
  return right !== undefined && sameJson(left.statement.expression, right.statement.expression);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The kernel's evidence kinds (`TransitionEvidence`), kept visibly distinct in the panel. */
export type TransitionEvidence = "structural" | "background-inference" | "library-result" | "sorry";

/**
 * The evidence the recorded operation carries. This reads the stored operation only: a sorry
 * and an accepted background inference are named by their operation kinds, and a library result
 * by the result the operation (or its rewrite source) cites. Every other kernel rule is
 * structural. The protocol does not yet store the kernel's evidence on previews or edges.
 */
export function transitionEvidenceOf(operation: MovePreview["operation"]): TransitionEvidence {
  if (operation.kind === "mark-sorry") return "sorry";
  if (operation.kind === "close-by-accepted-inference") return "background-inference";
  const record = operation as Readonly<Record<string, unknown>>;
  if (typeof record.resultId === "string") return "library-result";
  const source = record.source;
  if (typeof source === "object" && source !== null && "resultId" in source) {
    return "library-result";
  }
  return "structural";
}

type Suggestion = DisplayedSuggestionSet["suggestions"][number];

/**
 * The retrieval category the stored suggestion was ranked in (§14.3): immediately applicable,
 * a near miss that applies once its predicted obligations are proved, or needing input.
 */
export type SuggestionCategory = "immediate" | "near-miss" | "requires-input";

export function suggestionCategory(suggestion: Suggestion): SuggestionCategory {
  if (suggestion.applicability === "requires-input") return "requires-input";
  return suggestion.predictedObligations === undefined ? "immediate" : "near-miss";
}

export type SuggestionLayoutEntry =
  | Readonly<{ kind: "single"; suggestion: Suggestion }>
  | Readonly<{
      kind: "variant-group";
      familyId: string;
      name: string;
      /** The first displayed family member, shown in its stored position. */
      lead: Suggestion;
      /** The remaining members in stored order, behind an expandable control. */
      variants: readonly Suggestion[];
    }>;

/**
 * Lay out the displayed suggestions in stored order, gathering each stored variant group at
 * the position of its first member. Nothing is reranked or dropped.
 */
export function layoutSuggestions(
  set: Pick<DisplayedSuggestionSet, "suggestions" | "variantGroups">,
): readonly SuggestionLayoutEntry[] {
  const byId = new Map(set.suggestions.map((suggestion) => [suggestion.id as string, suggestion]));
  const groupOf = new Map<string, DisplayedSuggestionSet["variantGroups"][number]>();
  for (const group of set.variantGroups) {
    for (const id of group.suggestionIds) groupOf.set(id, group);
  }
  const placed = new Set<string>();
  const entries: SuggestionLayoutEntry[] = [];
  for (const suggestion of set.suggestions) {
    if (placed.has(suggestion.id)) continue;
    const group = groupOf.get(suggestion.id);
    if (group === undefined) {
      placed.add(suggestion.id);
      entries.push({ kind: "single", suggestion });
      continue;
    }
    const members = group.suggestionIds.flatMap((id) => {
      const member = byId.get(id);
      return member === undefined ? [] : [member];
    });
    members.forEach(({ id }) => placed.add(id));
    const [lead, ...variants] = members;
    if (lead === undefined) continue;
    entries.push(
      variants.length === 0
        ? { kind: "single", suggestion: lead }
        : { kind: "variant-group", familyId: group.familyId, name: group.name, lead, variants },
    );
  }
  return entries;
}
