/**
 * Solved status, provability route, and pruned proof over a stored proof-discovery tree
 * (design plan §10 and §16.5, refinement §9).
 *
 * Everything here is a pure computation over stored snapshots: it never calls the kernel or
 * retrieval, and every result is a frozen, detached copy.
 *
 * Semantics. Each node holds a full proof-state snapshot whose goals and obligations are its
 * targets. An edge applies one operation to one target of its parent and yields the child state;
 * targets it does not touch are carried into the child with the same ID. Sibling edges are
 * alternative attempts, never conjunctive obligations: case splits put every case into one state.
 * A node is complete when its state has no goals and no obligations. The root is solved iff some
 * path root → … → complete node uses only equivalence and strengthening edges. Weakening edges
 * never count; weakening-only branches stay in the tree but are never on a route.
 *
 * Route choice (earliest completed). Each edge has an ordering key: its optional `sequence`
 * (event order; an absent sequence sorts after every present one), then its edge ID. A route is
 * ranked by the key of its final edge, so among several complete routes the one whose closing edge
 * was recorded first wins; a complete root (no edges) precedes every other route. When the tree is
 * unsolved, the reported route is the best partial route: the counted-reachable node with the
 * fewest open targets, ties broken by the longer path (more progress) and then by the same
 * earliest-final-edge rule.
 */
import type { KernelOperation, TransitionClass } from "@proof/kernel";
import type {
  AdditionalAssumption,
  ExecutableProofState,
  StatementId,
} from "@proof/mathjson-model";
import { PRIMITIVE_TRANSITION_EVIDENCE } from "@proof/moves";
import type { ProofEdge, ProofEdgeId, ProofNode, ProofNodeId } from "./index";

/** How a transition is supported (refinement §9), extended with explicit sorry assumptions. */
export const DISCOVERY_EVIDENCE_KINDS = [
  "structural",
  "library-result",
  "background-inference",
  "sorry",
] as const;
export type DiscoveryEvidence = (typeof DISCOVERY_EVIDENCE_KINDS)[number];

/**
 * A stored edge. It carries its recorded `evidence` and transition `sequence` when it was stored
 * with them; when `evidence` is absent (a record or version-1 artifact from before it was stored)
 * it is derived: `sorry` if the child gained a sorry assumption whose source is the edge's target,
 * otherwise the primitive's evidence from `PRIMITIVE_TRANSITION_EVIDENCE`.
 */
export type DiscoveryTreeEdge = ProofEdge;

/** Accepts bare edges or the worker's `{ edge, name }` history records. */
export type DiscoveryTreeEdgeInput = DiscoveryTreeEdge | Readonly<{ edge: DiscoveryTreeEdge }>;

export type DiscoveryTreeInput = Readonly<{
  nodes: readonly ProofNode[];
  edges: readonly DiscoveryTreeEdgeInput[];
  rootId: ProofNodeId;
}>;

export type DiscoveryTarget = Readonly<{ kind: "goal" | "obligation"; id: StatementId }>;

export type DiscoveryRouteStep = Readonly<{
  edgeId: ProofEdgeId;
  parentNodeId: ProofNodeId;
  childNodeId: ProofNodeId;
  target: DiscoveryTarget;
  operation: KernelOperation;
  transitionClass: TransitionClass;
  evidence: DiscoveryEvidence;
  beforeTargets: readonly DiscoveryTarget[];
  afterTargets: readonly DiscoveryTarget[];
  /** Targets present in the child but not the parent: the acted-on target's replacements. */
  createdTargets: readonly DiscoveryTarget[];
  /** Hypothesis IDs of the acted-on target in the parent state. */
  contextHypothesisIds: readonly StatementId[];
  /**
   * Present only when the step purely appended these hypotheses to its target and changed nothing
   * else in the state; such a step is a pruning candidate.
   */
  addedHypothesisIds?: readonly StatementId[];
}>;

export type DiscoveryTargetStatus = Readonly<{
  target: DiscoveryTarget;
  status: "closed" | "open";
  /** The first route edge at or after this node that acts on the target, if any. */
  handledByEdgeId?: ProofEdgeId;
}>;

export type DiscoveryNodeTargetStatus = Readonly<{
  nodeId: ProofNodeId;
  targets: readonly DiscoveryTargetStatus[];
}>;

export type DiscoveryRoute = Readonly<{
  nodeIds: readonly ProofNodeId[];
  leafNodeId: ProofNodeId;
  steps: readonly DiscoveryRouteStep[];
  /** Per-node target status, computed by target-ID tracking along the route. */
  targetStatus: readonly DiscoveryNodeTargetStatus[];
}>;

export type DiscoveryEvidenceSummary = Readonly<
  Record<DiscoveryEvidence, Readonly<{ count: number; edgeIds: readonly ProofEdgeId[] }>>
>;

export type SolvedRelativeTo = Readonly<{
  backgroundInferences: readonly Readonly<{
    edgeId: ProofEdgeId;
    target: DiscoveryTarget;
    attestationId?: string;
  }>[];
  sorries: readonly Readonly<{
    edgeId: ProofEdgeId;
    target: DiscoveryTarget;
    assumptionIds: readonly string[];
  }>[];
}>;

export type DiscoveryTreeDiagnosticCode =
  | "invalid-input"
  | "duplicate-node"
  | "duplicate-edge"
  | "root-not-found"
  | "unknown-node"
  | "not-a-tree"
  | "snapshot-mismatch"
  | "target-not-found";

export type DiscoveryTreeDiagnostic = Readonly<{
  code: DiscoveryTreeDiagnosticCode;
  message: string;
}>;

export type DiscoveryTreeAnalysis = Readonly<{
  ok: true;
  rootId: ProofNodeId;
  solved: boolean;
  /** The chosen complete route when solved, otherwise the best partial route. */
  route: DiscoveryRoute;
  evidenceSummary: DiscoveryEvidenceSummary;
  /** Closed sorry assumptions of the route's final state, deduplicated by ID. */
  assumptions: readonly AdditionalAssumption[];
  solvedRelativeTo: SolvedRelativeTo;
  /** Empty when solved; otherwise the open targets at the best partial route's leaf. */
  openTargets: readonly DiscoveryTarget[];
  diagnostics: readonly [];
}>;

export type DiscoveryTreeAnalysisResult =
  DiscoveryTreeAnalysis | Readonly<{ ok: false; diagnostics: readonly DiscoveryTreeDiagnostic[] }>;

export type PrunedProofStep = Readonly<{
  edgeId: ProofEdgeId;
  parentNodeId: ProofNodeId;
  childNodeId: ProofNodeId;
  target: DiscoveryTarget;
  beforeTargets: readonly DiscoveryTarget[];
  afterTargets: readonly DiscoveryTarget[];
  operation: KernelOperation;
  transitionClass: TransitionClass;
  evidence: DiscoveryEvidence;
}>;

export type PrunedProof = Readonly<{
  rootId: ProofNodeId;
  leafNodeId: ProofNodeId;
  steps: readonly PrunedProofStep[];
  removedSteps: readonly Readonly<{
    edgeId: ProofEdgeId;
    unusedHypothesisIds: readonly StatementId[];
  }>[];
  evidenceSummary: DiscoveryEvidenceSummary;
  solvedRelativeTo: SolvedRelativeTo;
  assumptions: readonly AdditionalAssumption[];
}>;

export type PrunedProofResult =
  | Readonly<{ ok: true; proof: PrunedProof; diagnostics: readonly [] }>
  | Readonly<{
      ok: false;
      diagnostics: readonly Readonly<{ code: "not-solved"; message: string }>[];
    }>;

type Entry = ExecutableProofState["goals"][number] | ExecutableProofState["obligations"][number];
type NormalizedEdge = Readonly<{ edge: DiscoveryTreeEdge; evidence: DiscoveryEvidence }>;

/** Analyze a stored discovery tree; see the module comment for the exact semantics. */
export function analyzeDiscoveryTree(input: DiscoveryTreeInput): DiscoveryTreeAnalysisResult {
  try {
    return analyze(input);
  } catch {
    return failure("invalid-input", "The discovery tree could not be inspected safely.");
  }
}

function analyze(input: DiscoveryTreeInput): DiscoveryTreeAnalysisResult {
  if (!Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
    return failure("invalid-input", "Nodes and edges must be arrays.");
  }
  const nodes = new Map<ProofNodeId, ProofNode>();
  for (const node of input.nodes) {
    if (nodes.has(node.id)) return failure("duplicate-node", `Node ${node.id} is duplicated.`);
    nodes.set(node.id, node);
  }
  const root = nodes.get(input.rootId);
  if (root === undefined) return failure("root-not-found", `Root ${input.rootId} is missing.`);

  const edgeIds = new Set<ProofEdgeId>();
  const parentOf = new Map<ProofNodeId, ProofEdgeId>();
  const children = new Map<ProofNodeId, NormalizedEdge[]>();
  for (const raw of input.edges) {
    const edge = "edge" in raw ? raw.edge : raw;
    if (edgeIds.has(edge.id)) return failure("duplicate-edge", `Edge ${edge.id} is duplicated.`);
    edgeIds.add(edge.id);
    const parent = nodes.get(edge.parentNodeId);
    const child = nodes.get(edge.childNodeId);
    if (parent === undefined || child === undefined) {
      return failure("unknown-node", `Edge ${edge.id} references an unknown node.`);
    }
    if (edge.childNodeId === input.rootId || parentOf.has(edge.childNodeId)) {
      return failure("not-a-tree", `Node ${edge.childNodeId} has more than one parent edge.`);
    }
    parentOf.set(edge.childNodeId, edge.id);
    if (
      edge.operation.expectedStateId !== parent.state.id ||
      edge.operation.resultStateId !== child.state.id
    ) {
      return failure("snapshot-mismatch", `Edge ${edge.id} does not link its node snapshots.`);
    }
    if (findEntry(parent.state, edge.operation.target) === undefined) {
      return failure("target-not-found", `Edge ${edge.id} acts on a target its parent lacks.`);
    }
    const list = children.get(edge.parentNodeId) ?? [];
    list.push({ edge, evidence: edgeEvidence(edge, parent.state, child.state) });
    children.set(edge.parentNodeId, list);
  }
  for (const list of children.values()) list.sort((a, b) => compareEdges(a.edge, b.edge));

  // Enumerate every path from the root that uses only counted (equivalence/strengthening) edges.
  // Every node has at most one parent, so each reachable node has exactly one such path.
  type Candidate = Readonly<{ path: readonly NormalizedEdge[]; node: ProofNode }>;
  const candidates: Candidate[] = [];
  const stack: Candidate[] = [{ path: [], node: root }];
  const visited = new Set<ProofNodeId>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current.node.id)) continue;
    visited.add(current.node.id);
    candidates.push(current);
    if (isComplete(current.node.state)) continue;
    for (const next of children.get(current.node.id) ?? []) {
      if (next.edge.transitionClass === "weakening") continue;
      stack.push({ path: [...current.path, next], node: nodes.get(next.edge.childNodeId)! });
    }
  }
  const rankPath = (left: Candidate, right: Candidate): number => {
    const a = left.path.at(-1);
    const b = right.path.at(-1);
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    return compareEdges(a.edge, b.edge);
  };
  const complete = candidates.filter((candidate) => isComplete(candidate.node.state));
  const solved = complete.length > 0;
  const chosen = solved
    ? complete.sort(rankPath)[0]!
    : candidates.sort(
        (left, right) =>
          targetCount(left.node.state) - targetCount(right.node.state) ||
          right.path.length - left.path.length ||
          rankPath(left, right),
      )[0]!;

  const routeNodes = [root, ...chosen.path.map((entry) => nodes.get(entry.edge.childNodeId)!)];
  const steps = chosen.path.map((entry, index) =>
    routeStep(entry, routeNodes[index]!.state, routeNodes[index + 1]!.state),
  );
  const leafState = chosen.node.state;
  const analysis: DiscoveryTreeAnalysis = {
    ok: true,
    rootId: input.rootId,
    solved,
    route: {
      nodeIds: routeNodes.map((node) => node.id),
      leafNodeId: chosen.node.id,
      steps,
      targetStatus: targetStatuses(routeNodes, steps),
    },
    evidenceSummary: summarizeEvidence(steps),
    assumptions: dedupeAssumptions(leafState.assumptions ?? []),
    solvedRelativeTo: relativeTo(steps, routeNodes),
    openTargets: solved ? [] : targetsOf(leafState),
    diagnostics: [],
  };
  return freezeDetached(analysis);
}

/**
 * Conservative dependency-based pruning of a solved route. A route step is removable only if it
 * purely added hypotheses to its target (every other target, the target's conclusion, its other
 * context, and the state assumptions are unchanged, and the old hypotheses are an exact prefix of
 * the new ones) and no later retained step references any added hypothesis. References are the
 * operation fields that name existing hypotheses (for example `hypothesisId`,
 * `premiseHypothesisIds`, `equalityHypothesisId`, a rewritten hypothesis); a background-inference
 * or sorry step is treated as referencing every hypothesis of its target, because its support is
 * not checked by the kernel. Steps are scanned from the end, so removals cascade. This is not a
 * claim of global minimality, and the retained steps keep their original snapshots.
 */
export function prunedProof(analysis: DiscoveryTreeAnalysis): PrunedProofResult {
  if (!analysis.solved) {
    return freezeDetached({
      ok: false,
      diagnostics: [{ code: "not-solved", message: "Only a solved route has a pruned proof." }],
    });
  }
  const route = analysis.route;
  const referenced = new Set<string>();
  const kept: DiscoveryRouteStep[] = [];
  const removed: { edgeId: ProofEdgeId; unusedHypothesisIds: StatementId[] }[] = [];
  for (let index = route.steps.length - 1; index >= 0; index -= 1) {
    const step = route.steps[index]!;
    const added = step.addedHypothesisIds;
    if (added !== undefined && added.every((id) => !referenced.has(id))) {
      removed.unshift({ edgeId: step.edgeId, unusedHypothesisIds: [...added] });
      continue;
    }
    kept.unshift(step);
    for (const id of referencedHypotheses(step)) referenced.add(id);
  }
  const proof: PrunedProof = {
    rootId: analysis.rootId,
    leafNodeId: route.leafNodeId,
    steps: kept.map((step) => ({
      edgeId: step.edgeId,
      parentNodeId: step.parentNodeId,
      childNodeId: step.childNodeId,
      target: step.target,
      beforeTargets: step.beforeTargets,
      afterTargets: step.afterTargets,
      operation: step.operation,
      transitionClass: step.transitionClass,
      evidence: step.evidence,
    })),
    removedSteps: removed,
    evidenceSummary: summarizeEvidence(kept),
    solvedRelativeTo: {
      backgroundInferences: analysis.solvedRelativeTo.backgroundInferences.filter((entry) =>
        kept.some((step) => step.edgeId === entry.edgeId),
      ),
      sorries: analysis.solvedRelativeTo.sorries.filter((entry) =>
        kept.some((step) => step.edgeId === entry.edgeId),
      ),
    },
    assumptions: analysis.assumptions,
  };
  return freezeDetached({ ok: true, proof, diagnostics: [] });
}

function routeStep(
  entry: NormalizedEdge,
  before: ExecutableProofState,
  after: ExecutableProofState,
): DiscoveryRouteStep {
  const { edge } = entry;
  const beforeTargets = targetsOf(before);
  const afterTargets = targetsOf(after);
  const beforeKeys = new Set(beforeTargets.map(targetKey));
  const acted = findEntry(before, edge.operation.target)!;
  const added = pureAddedHypotheses(before, after, edge.operation.target);
  return {
    edgeId: edge.id,
    parentNodeId: edge.parentNodeId,
    childNodeId: edge.childNodeId,
    target: { kind: edge.operation.target.kind, id: edge.operation.target.id },
    operation: edge.operation,
    transitionClass: edge.transitionClass,
    evidence: entry.evidence,
    beforeTargets,
    afterTargets,
    createdTargets: afterTargets.filter((target) => !beforeKeys.has(targetKey(target))),
    contextHypothesisIds: acted.sequent.context.hypotheses.map((hypothesis) => hypothesis.id),
    ...(added === undefined ? {} : { addedHypothesisIds: added }),
  };
}

/** The appended hypothesis IDs when a step changed nothing but appending them; else undefined. */
function pureAddedHypotheses(
  before: ExecutableProofState,
  after: ExecutableProofState,
  target: DiscoveryTarget,
): readonly StatementId[] | undefined {
  if (!jsonEquals(before.assumptions ?? [], after.assumptions ?? [])) return undefined;
  const beforeTargets = targetsOf(before);
  const afterTargets = targetsOf(after);
  if (
    beforeTargets.length !== afterTargets.length ||
    !beforeTargets.every((entry, index) => targetKey(entry) === targetKey(afterTargets[index]!))
  ) {
    return undefined;
  }
  for (const other of beforeTargets) {
    if (targetKey(other) === targetKey(target)) continue;
    if (!jsonEquals(findEntry(before, other), findEntry(after, other))) return undefined;
  }
  const old = findEntry(before, target);
  const next = findEntry(after, target);
  if (old === undefined || next === undefined) return undefined;
  const { hypotheses: oldHypotheses, ...oldContext } = old.sequent.context;
  const { hypotheses: newHypotheses, ...newContext } = next.sequent.context;
  const { sequent: oldSequent, ...oldRest } = old;
  const { sequent: newSequent, ...newRest } = next;
  if (
    !jsonEquals(oldRest, newRest) ||
    !jsonEquals(oldSequent.conclusion, newSequent.conclusion) ||
    !jsonEquals(oldContext, newContext) ||
    newHypotheses.length <= oldHypotheses.length ||
    !oldHypotheses.every((hypothesis, index) => jsonEquals(hypothesis, newHypotheses[index]))
  ) {
    return undefined;
  }
  return newHypotheses.slice(oldHypotheses.length).map((hypothesis) => hypothesis.id);
}

/**
 * Hypothesis IDs a step may depend on. Unchecked (background-inference or sorry) steps depend on
 * their target's whole context. Otherwise the operation is scanned generically, so new primitive
 * kinds are covered: every `hypothesisId` or `…HypothesisId(s)` field value, and every nested
 * `{ kind: "hypothesis", id }` reference (a rewritten statement or rewrite source). This
 * over-approximates, since it also collects fresh result IDs, which only makes pruning keep more.
 */
function referencedHypotheses(step: DiscoveryRouteStep): readonly string[] {
  if (step.evidence === "background-inference" || step.evidence === "sorry") {
    return step.contextHypothesisIds;
  }
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    if (value.kind === "hypothesis" && typeof value.id === "string") found.push(value.id);
    for (const [key, field] of Object.entries(value)) {
      if (key === "hypothesisId" || /HypothesisIds?$/.test(key)) {
        for (const id of Array.isArray(field) ? field : [field]) {
          if (typeof id === "string") found.push(id);
        }
      } else {
        visit(field);
      }
    }
  };
  visit(step.operation);
  return found;
}

/**
 * Target T at route node i is closed iff some route edge j >= i acts on it while it is carried
 * forward, and every replacement (T itself if it survives, plus every target created by edge j)
 * is closed from node j + 1. A target still present at the route's leaf is open.
 */
function targetStatuses(
  routeNodes: readonly ProofNode[],
  steps: readonly DiscoveryRouteStep[],
): readonly DiscoveryNodeTargetStatus[] {
  const survives = (step: DiscoveryRouteStep, key: string): boolean =>
    step.afterTargets.some((target) => targetKey(target) === key);
  const handledBy = (key: string, index: number): ProofEdgeId | undefined => {
    for (const step of steps.slice(index)) {
      if (targetKey(step.target) === key) return step.edgeId;
      if (!survives(step, key)) return undefined;
    }
    return undefined;
  };
  const memo = new Map<string, boolean>();
  const closed = (key: string, index: number): boolean => {
    const memoKey = `${index}|${key}`;
    const cached = memo.get(memoKey);
    if (cached !== undefined) return cached;
    const step = steps[index];
    let result = false;
    if (step !== undefined) {
      if (targetKey(step.target) === key) {
        const replacements = [
          ...(survives(step, key) ? [key] : []),
          ...step.createdTargets.map(targetKey),
        ];
        result = replacements.every((replacement) => closed(replacement, index + 1));
      } else {
        result = survives(step, key) && closed(key, index + 1);
      }
    }
    memo.set(memoKey, result);
    return result;
  };
  return routeNodes.map((node, index) => ({
    nodeId: node.id,
    targets: targetsOf(node.state).map((target) => {
      const key = targetKey(target);
      const edgeId = handledBy(key, index);
      return {
        target,
        status: closed(key, index) ? ("closed" as const) : ("open" as const),
        ...(edgeId === undefined ? {} : { handledByEdgeId: edgeId }),
      };
    }),
  }));
}

function edgeEvidence(
  edge: DiscoveryTreeEdge,
  parent: ExecutableProofState,
  child: ExecutableProofState,
): DiscoveryEvidence {
  if (edge.evidence !== undefined) return edge.evidence;
  if (addedAssumptions(parent, child).some((assumption) => isSorryFor(assumption, edge))) {
    return "sorry";
  }
  // A primitive may admit one evidence kind or several (a rewrite whose source is a hypothesis or
  // an approved result); several are disambiguated by whether the operation names a result.
  // Construction-task operations have no primitive entry and are structural.
  const recorded: unknown = (PRIMITIVE_TRANSITION_EVIDENCE as Readonly<Record<string, unknown>>)[
    edge.operation.kind
  ];
  const admitted = (Array.isArray(recorded) ? recorded : [recorded]).filter(
    (kind): kind is DiscoveryEvidence => DISCOVERY_EVIDENCE_KINDS.some((known) => known === kind),
  );
  if (admitted.length <= 1) return admitted[0] ?? "structural";
  if (admitted.includes("library-result") && namesResult(edge.operation)) return "library-result";
  return admitted.find((kind) => kind !== "library-result") ?? "library-result";
}

function namesResult(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(namesResult);
  if (!isRecord(value)) return false;
  return "resultId" in value || Object.values(value).some(namesResult);
}

function isSorryFor(assumption: AdditionalAssumption, edge: DiscoveryTreeEdge): boolean {
  return (
    assumption.origin.kind === "sorry" &&
    assumption.origin.sourceTarget.kind === edge.operation.target.kind &&
    assumption.origin.sourceTarget.id === edge.operation.target.id
  );
}

function addedAssumptions(
  parent: ExecutableProofState,
  child: ExecutableProofState,
): readonly AdditionalAssumption[] {
  const existing = new Set((parent.assumptions ?? []).map((assumption) => assumption.id));
  return (child.assumptions ?? []).filter((assumption) => !existing.has(assumption.id));
}

function summarizeEvidence(steps: readonly DiscoveryRouteStep[]): DiscoveryEvidenceSummary {
  const entry = (kind: DiscoveryEvidence) => {
    const edgeIds = steps.filter((step) => step.evidence === kind).map((step) => step.edgeId);
    return { count: edgeIds.length, edgeIds };
  };
  return {
    structural: entry("structural"),
    "library-result": entry("library-result"),
    "background-inference": entry("background-inference"),
    sorry: entry("sorry"),
  };
}

function relativeTo(
  steps: readonly DiscoveryRouteStep[],
  routeNodes: readonly ProofNode[],
): SolvedRelativeTo {
  return {
    backgroundInferences: steps
      .filter((step) => step.evidence === "background-inference")
      .map((step) => ({
        edgeId: step.edgeId,
        target: step.target,
        ...(step.operation.kind === "close-by-accepted-inference"
          ? { attestationId: step.operation.attestationId }
          : {}),
      })),
    sorries: steps.flatMap((step, index) =>
      step.evidence === "sorry"
        ? [
            {
              edgeId: step.edgeId,
              target: step.target,
              assumptionIds: addedAssumptions(
                routeNodes[index]!.state,
                routeNodes[index + 1]!.state,
              ).map((assumption) => assumption.id),
            },
          ]
        : [],
    ),
  };
}

function dedupeAssumptions(
  assumptions: readonly AdditionalAssumption[],
): readonly AdditionalAssumption[] {
  const seen = new Set<string>();
  return assumptions.filter((assumption) => {
    if (seen.has(assumption.id)) return false;
    seen.add(assumption.id);
    return true;
  });
}

/** Edge order: present `sequence` ascending (absent sorts last), then edge ID. */
function compareEdges(left: DiscoveryTreeEdge, right: DiscoveryTreeEdge): number {
  const a = left.sequence ?? Number.POSITIVE_INFINITY;
  const b = right.sequence ?? Number.POSITIVE_INFINITY;
  if (a !== b) return a < b ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function isComplete(state: ExecutableProofState): boolean {
  return targetCount(state) === 0;
}

function targetCount(state: ExecutableProofState): number {
  return state.goals.length + state.obligations.length;
}

function targetsOf(state: ExecutableProofState): readonly DiscoveryTarget[] {
  return [
    ...state.goals.map((goal) => ({ kind: "goal" as const, id: goal.id })),
    ...state.obligations.map((obligation) => ({ kind: "obligation" as const, id: obligation.id })),
  ];
}

function targetKey(target: DiscoveryTarget): string {
  return `${target.kind}|${target.id}`;
}

function findEntry(state: ExecutableProofState, target: DiscoveryTarget): Entry | undefined {
  const entries: readonly Entry[] = target.kind === "goal" ? state.goals : state.obligations;
  return entries.find((entry) => entry.id === target.id);
}

function failure(code: DiscoveryTreeDiagnosticCode, message: string): DiscoveryTreeAnalysisResult {
  return freezeDetached({ ok: false, diagnostics: [{ code, message }] });
}

function jsonEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEquals(value, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && jsonEquals(left[key], right[key]))
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
