/**
 * The pruned proof as a view model (design plan §4.6, §16; roadmap N28). The solved status, the
 * pruned steps and the sorry assumptions are the stored final material; a step's motivating
 * inquiry records are found by stored identifiers, never by a search or a recomputation.
 */
import type { AdditionalAssumption } from "@proof/mathjson-model";
import type {
  DiscoveryEvidence,
  DiscoveryTarget,
  InquiryRecord,
  ProofArtifact,
  PrunedProofStep,
} from "@proof/protocol";
import {
  edgeLabel,
  indexArtifact,
  storedAnalysis,
  storedPrunedProof,
  storedSorryAssumptions,
  type ArtifactIndex,
} from "./artifact-data";

/** Why an inquiry record is shown next to a proof step. */
export type MotivationRelation =
  /** The record is an attempt that chose the very stored suggestion this step applied. */
  | "chose-this-suggestion"
  /** The record is an attempt at the same move, anchored at the node the step starts from. */
  | "same-move-at-node"
  /** The record is the objective or question the attempt above belongs to. */
  | "motivating-context";

export type MotivatingRecordLink = Readonly<{
  recordId: string;
  kind: InquiryRecord["kind"];
  relation: MotivationRelation;
}>;

export type PrunedStepView = Readonly<{
  /** 1-based position in the pruned proof. */
  number: number;
  edgeId: string;
  parentNodeId: string;
  childNodeId: string;
  label: string;
  operationKind: string;
  transitionClass: PrunedProofStep["transitionClass"];
  evidence: DiscoveryEvidence;
  target: DiscoveryTarget;
  afterTargets: readonly DiscoveryTarget[];
  motivatingRecords: readonly MotivatingRecordLink[];
}>;

export type SorryDependencyView = Readonly<{
  edgeId: string;
  target: DiscoveryTarget;
  assumptionIds: readonly string[];
}>;

export type PrunedProofView =
  | Readonly<{
      solved: true;
      rootNodeId: string;
      leafNodeId: string;
      steps: readonly PrunedStepView[];
      removedSteps: readonly Readonly<{
        edgeId: string;
        unusedHypothesisIds: readonly string[];
      }>[];
      /** The sorry assumptions this proof is stated relative to. */
      assumptions: readonly AdditionalAssumption[];
      sorryDependencies: readonly SorryDependencyView[];
      backgroundInferenceEdgeIds: readonly string[];
      /** Sorry assumptions in the retained tree that this proof does not use. */
      unusedSorryAssumptions: readonly AdditionalAssumption[];
    }>
  | Readonly<{
      solved: false;
      openTargets: readonly DiscoveryTarget[];
      /** Sorry assumptions in the retained tree. */
      sorryAssumptions: readonly AdditionalAssumption[];
    }>;

function motivatingRecords(
  artifact: ProofArtifact,
  index: ArtifactIndex,
  step: PrunedProofStep,
): readonly MotivatingRecordLink[] {
  const edge = index.edgesByChild.get(step.childNodeId);
  if (edge === undefined) return [];
  const byId = new Map(artifact.inquiryRecords.map((record) => [record.id, record]));
  const links = new Map<string, MotivatingRecordLink>();
  const add = (record: InquiryRecord, relation: MotivationRelation) => {
    if (!links.has(record.id))
      links.set(record.id, { recordId: record.id, kind: record.kind, relation });
  };
  for (const record of artifact.inquiryRecords) {
    if (record.kind !== "attempt") continue;
    const chose =
      record.suggestion !== undefined &&
      record.suggestion.suggestionSetId === edge.suggestionSetId &&
      record.suggestion.suggestionId === edge.chosenSuggestionId;
    const sameMove =
      record.method.kind === "move" &&
      record.method.moveId === edge.moveId &&
      record.nodeId === edge.parentNodeId;
    if (!chose && !sameMove) continue;
    add(record, chose ? "chose-this-suggestion" : "same-move-at-node");
    const objective = byId.get(record.objectiveId);
    if (objective?.kind === "objective") {
      add(objective, "motivating-context");
      const question = byId.get(objective.questionId);
      if (question !== undefined) add(question, "motivating-context");
    }
  }
  return [...links.values()];
}

export function buildPrunedProofView(artifact: ProofArtifact): PrunedProofView {
  const index = indexArtifact(artifact);
  const pruned = artifact.final.solved ? storedPrunedProof(artifact) : undefined;
  const allSorries = storedSorryAssumptions(artifact);
  if (pruned === undefined) {
    return {
      solved: false,
      openTargets: storedAnalysis(artifact)?.openTargets ?? [],
      sorryAssumptions: allSorries,
    };
  }
  const used = new Set(pruned.assumptions.map(({ id }) => id));
  return {
    solved: true,
    rootNodeId: pruned.rootId,
    leafNodeId: pruned.leafNodeId,
    steps: pruned.steps.map((step, position) => {
      const edge = index.edgesByChild.get(step.childNodeId);
      return {
        number: position + 1,
        edgeId: step.edgeId,
        parentNodeId: step.parentNodeId,
        childNodeId: step.childNodeId,
        label: edge === undefined ? step.operation.kind : edgeLabel(index, edge),
        operationKind: step.operation.kind,
        transitionClass: step.transitionClass,
        evidence: step.evidence,
        target: step.target,
        afterTargets: step.afterTargets,
        motivatingRecords: motivatingRecords(artifact, index, step),
      };
    }),
    removedSteps: pruned.removedSteps,
    assumptions: pruned.assumptions,
    sorryDependencies: pruned.solvedRelativeTo.sorries.map(({ edgeId, target, assumptionIds }) => ({
      edgeId,
      target,
      assumptionIds,
    })),
    backgroundInferenceEdgeIds: pruned.solvedRelativeTo.backgroundInferences.map(
      ({ edgeId }) => edgeId,
    ),
    unusedSorryAssumptions: allSorries.filter(({ id }) => !used.has(id)),
  };
}
