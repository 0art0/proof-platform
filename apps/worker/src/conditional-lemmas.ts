/**
 * Conditional lemmas saved from a closed proof subtree (roadmap N44; refinement §9, N12, N24).
 *
 * The pure pieces live in `@proof/protocol` (`planConditionalLemma`, `usedHypotheses`) and
 * `@proof/library` (`extractDerivedResult`). This module wires them to stored data:
 *
 * - `buildConditionalLemma` plans the lemma from the stored subtree, keeps only the hypotheses the
 *   subtree used, and renders the statement server-side with `@proof/language` from the lemma's
 *   MathJSON. The caller supplies no renderings, IDs or classification.
 * - `previewConditionalLemma` is the read-only view of that: the statement, the hypotheses it keeps
 *   and drops, and why a target cannot be saved.
 * - `reviewConditionalLemma` records a human decision about a draft as a new derived-layer artifact
 *   `<draft>.review.<commandId>` restating the lemma with its review (the N35 pattern). Only an
 *   approved review makes the lemma retrievable.
 * - `approvedDerivedResults` / `sessionDefinitions` add approved lemmas to a session's retrieval
 *   catalog beside the reviewed packs. Drafts, rejections and other sessions' lemmas never join it.
 */
import {
  extractDerivedResult,
  type BackgroundClassification,
  type LibraryArtifact,
  type LibraryResult,
  type LibraryResultReview,
} from "@proof/library";
import { createPresentation } from "@proof/language";
import type { PlainMathJson, ProofContext, StatementView } from "@proof/mathjson-model";
import { approvedKernelResults } from "@proof/moves";
import {
  planConditionalLemma,
  type ConditionalLemmaPlan,
  type ConservativeHypothesisUse,
  type ProofNode,
} from "@proof/protocol";
import { adaptApprovedCatalog, type DefinitionCatalog } from "./approved-catalog";
import {
  addLibraryArtifact,
  listLibrary,
  readAdditionEvents,
  type LibraryRepositoryFailure,
  type LibraryStore,
} from "./library-repository";
import type { ProofSession } from "./proof-repository";

export type LemmaFailureCode =
  | "lemma-target-not-found"
  | "lemma-not-closed"
  | "lemma-uses-sorry"
  | "lemma-local-dependency"
  | "lemma-invalid"
  | "lemma-already-saved"
  | "draft-not-found"
  | "draft-already-reviewed"
  | "review-notes-required"
  | "library-admission-rejected"
  | "event-id-conflict";

export type LemmaFailure = Readonly<{
  status: "rejected";
  diagnostics: readonly [Readonly<{ code: LemmaFailureCode; message: string }>];
}>;

function refused(code: LemmaFailureCode, message: string): LemmaFailure {
  return { status: "rejected", diagnostics: [{ code, message }] };
}

export type LemmaTarget = Readonly<{ kind: "goal" | "obligation"; id: string }>;

export type RenderedStatement = Readonly<{
  latex: string;
  naturalLanguage: string;
}>;

type Operators = ProofSession["operators"];

/** `∀ parameters. (premises) ⇒ conclusion` as MathJSON, with no premises the conclusion alone. */
function lemmaExpression(
  premises: readonly StatementView[],
  conclusion: StatementView,
): PlainMathJson {
  if (premises.length === 0) return conclusion.expression;
  const antecedent: PlainMathJson =
    premises.length === 1
      ? (premises[0] as StatementView).expression
      : (["And", ...premises.map(({ expression }) => expression)] as PlainMathJson);
  return ["Implies", antecedent, conclusion.expression] as PlainMathJson;
}

/** The deterministic LaTeX and prose of a statement, from its MathJSON and the session operators. */
export function renderLemmaStatement(
  operators: Operators,
  context: ProofContext,
  expression: PlainMathJson,
): RenderedStatement {
  const presentation = createPresentation({ operators });
  return {
    latex: presentation.latex(expression),
    naturalLanguage: presentation.naturalLanguage(expression, {
      declarations: context.declarations.map(({ symbol, sort }) => ({ symbol, sort })),
    }),
  };
}

export type BuiltLemma = Readonly<{
  plan: ConditionalLemmaPlan;
  lemma: LibraryResult;
  statement: RenderedStatement;
  conclusion: RenderedStatement;
  premises: readonly (Readonly<{ id: string }> & RenderedStatement)[];
  unused: readonly (Readonly<{ id: string }> & RenderedStatement)[];
}>;

export type BuildLemmaInput = Readonly<{
  session: ProofSession;
  nodes: readonly ProofNode[];
  edges: Parameters<typeof planConditionalLemma>[0]["edges"];
  nodeId: string;
  target: LemmaTarget;
  lemmaId: string;
  name?: string | undefined;
}>;

function classificationFor(session: ProofSession): BackgroundClassification {
  const background = session.metadata?.background;
  return {
    domains:
      background?.domains !== undefined && background.domains.length > 0
        ? [...background.domains]
        : ["derived-in-session"],
    level: background?.maximumLevel ?? "foundational",
  };
}

/** Plan the lemma and extract it as a draft derived result, or say exactly why it cannot be. */
export function buildConditionalLemma(input: BuildLemmaInput): BuiltLemma | LemmaFailure {
  const planned = planConditionalLemma({
    nodes: input.nodes,
    edges: input.edges,
    nodeId: input.nodeId,
    target: input.target,
  });
  if (!planned.ok) {
    const diagnostic = planned.diagnostics[0];
    switch (diagnostic.code) {
      case "target-not-found":
        return refused("lemma-target-not-found", diagnostic.message);
      case "not-established":
        return refused("lemma-not-closed", diagnostic.message);
      case "depends-on-sorry":
        return refused("lemma-uses-sorry", diagnostic.message);
      default:
        return refused("lemma-invalid", diagnostic.message);
    }
  }
  const { plan } = planned;
  const operators = input.session.operators;
  const statementRendering = (expression: PlainMathJson) =>
    renderLemmaStatement(operators, plan.context, expression);
  const conclusion = statementRendering(plan.conclusion.expression);
  const keptIds = new Set(plan.retainedHypothesisIds);
  const hypothesisViews = (keep: boolean) =>
    plan.context.hypotheses
      .filter(({ id }) => keptIds.has(id) === keep)
      .map(({ id, statement }) => ({ id, ...statementRendering(statement.expression) }));
  const premises = hypothesisViews(true);
  const unused = hypothesisViews(false);
  const premiseStatements = plan.context.hypotheses
    .filter(({ id }) => keptIds.has(id))
    .map(({ statement }) => statement);
  const statement = statementRendering(lemmaExpression(premiseStatements, plan.conclusion));
  const extraction = extractDerivedResult({
    sessionId: input.session.id,
    proofNodeId: input.nodeId,
    id: input.lemmaId,
    name: input.name ?? `Lemma: ${truncate(conclusion.latex, 120)}`,
    context: plan.context,
    conclusion: plan.conclusion,
    usedHypothesisIds: plan.retainedHypothesisIds,
    classification: classificationFor(input.session),
    renderings: statement,
    approval: { status: "draft" },
    operators,
  });
  if (!extraction.ok) {
    const diagnostic = extraction.diagnostics[0];
    return refused(
      diagnostic.code === "local-dependency" ? "lemma-local-dependency" : "lemma-invalid",
      diagnostic.message,
    );
  }
  return { plan, lemma: extraction.result, statement, conclusion, premises, unused };
}

function truncate(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

// ---------------------------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------------------------

export type ExistingLemma = Readonly<{
  artifactId: string;
  status: "draft" | "approved" | "rejected";
}>;

export type ConditionalLemmaPreview =
  | Readonly<{
      status: "ready";
      nodeId: string;
      target: LemmaTarget;
      name: string;
      statement: RenderedStatement;
      conclusion: RenderedStatement;
      /** The hypotheses the lemma keeps, because the subtree used them. */
      premises: BuiltLemma["premises"];
      /** Hypotheses of the context the subtree never used; the lemma does not need them. */
      unusedHypotheses: BuiltLemma["unused"];
      /** Steps whose usage is unknown, which forced every hypothesis to be kept. */
      conservative: readonly ConservativeHypothesisUse[];
      parameters: readonly string[];
      establishingSteps: number;
      backgroundInferences: number;
      /** Lemmas already saved from this node with this statement. */
      existing: readonly ExistingLemma[];
    }>
  | Readonly<{
      status: "refused";
      code: LemmaFailureCode;
      message: string;
    }>;

/** Derived-layer lemmas of a node whose statement is the built lemma's. */
export function existingLemmas(
  artifacts: readonly LibraryArtifact[],
  nodeId: string,
  lemma: LibraryResult,
): readonly ExistingLemma[] {
  const same = (candidate: LibraryResult) =>
    JSON.stringify([candidate.statement, candidate.premises]) ===
    JSON.stringify([lemma.statement, lemma.premises]);
  const results = artifacts.filter(
    (artifact): artifact is LibraryResult =>
      artifact.kind === "result" &&
      artifact.layer === "derived" &&
      artifact.provenance.kind === "derived" &&
      artifact.provenance.proofNodeId === nodeId &&
      same(artifact),
  );
  const reviewed = new Map<string, LibraryResultReview>();
  for (const result of results) {
    if (result.review !== undefined) reviewed.set(result.review.reviewOf, result.review);
  }
  return results
    .filter((result) => result.review === undefined)
    .map((draft) => {
      const review = reviewed.get(draft.id);
      return {
        artifactId: draft.id,
        status: review?.decision === "approved" ? "approved" : review ? "rejected" : "draft",
      } as const;
    });
}

export function previewConditionalLemma(
  input: Omit<BuildLemmaInput, "lemmaId" | "name">,
  derivedArtifacts: readonly LibraryArtifact[],
): ConditionalLemmaPreview {
  const built = buildConditionalLemma({ ...input, lemmaId: "result:lemma-preview" });
  if ("status" in built) {
    const { code, message } = built.diagnostics[0];
    return { status: "refused", code, message };
  }
  return {
    status: "ready",
    nodeId: input.nodeId,
    target: input.target,
    name: built.lemma.name,
    statement: built.statement,
    conclusion: built.conclusion,
    premises: built.premises,
    unusedHypotheses: built.unused,
    conservative: built.plan.conservativeHypothesisUse,
    parameters: built.lemma.parameters.map(({ symbol }) => symbol),
    establishingSteps: built.plan.establishingEdgeIds.length,
    backgroundInferences: built.plan.backgroundInferenceEdgeIds.length,
    existing: existingLemmas(derivedArtifacts, input.nodeId, built.lemma),
  };
}

// ---------------------------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------------------------

export type ConditionalLemmaCandidate = Readonly<{
  nodeId: string;
  target: LemmaTarget;
  /** The target's conclusion at that node, rendered server-side. */
  goal: RenderedStatement;
  preview: ConditionalLemmaPreview;
}>;

const MAX_CANDIDATES = 200;

/**
 * The steps of a session that could become lemmas: every target a stored edge acted on, at the
 * edge's parent node, with the preview (or the reason it cannot be saved). Nodes with no outgoing
 * edge have no subtree and are not candidates.
 */
export function listConditionalLemmaCandidates(
  input: Omit<BuildLemmaInput, "lemmaId" | "name" | "nodeId" | "target">,
  derivedArtifacts: readonly LibraryArtifact[],
): readonly ConditionalLemmaCandidate[] {
  const nodes = new Map(input.nodes.map((node) => [node.id as string, node]));
  const seen = new Set<string>();
  const candidates: ConditionalLemmaCandidate[] = [];
  for (const edge of input.edges) {
    const nodeId = edge.parentNodeId as string;
    const target = { kind: edge.operation.target.kind, id: edge.operation.target.id as string };
    const key = `${nodeId}|${target.kind}|${target.id}`;
    const node = nodes.get(nodeId);
    if (node === undefined || seen.has(key) || candidates.length >= MAX_CANDIDATES) continue;
    seen.add(key);
    const entry = (target.kind === "goal" ? node.state.goals : node.state.obligations).find(
      ({ id }) => id === target.id,
    );
    if (entry === undefined) continue;
    candidates.push({
      nodeId,
      target,
      goal: renderLemmaStatement(
        input.session.operators,
        entry.sequent.context,
        entry.sequent.conclusion.expression,
      ),
      preview: previewConditionalLemma({ ...input, nodeId, target }, derivedArtifacts),
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------------------------

export type LemmaReviewDecision = "approved" | "rejected";

export type ReviewLemmaInput = Readonly<{
  commandId: string;
  sessionId: string;
  reviewerId: string;
  occurredAt: string;
  draftArtifactId: string;
  decision: LemmaReviewDecision;
  notes: string;
}>;

export type ReviewLemmaResult =
  | Readonly<{
      status: "recorded";
      replayed: boolean;
      artifact: LibraryResult;
      draftArtifactId: string;
      decision: LemmaReviewDecision;
      /** Whether the lemma is now in the session's retrieval catalog. */
      retrievable: boolean;
    }>
  | LemmaFailure
  | LibraryRepositoryFailure;

function derivedResults(artifacts: readonly LibraryArtifact[]): LibraryResult[] {
  return artifacts.filter(
    (artifact): artifact is LibraryResult =>
      artifact.kind === "result" &&
      artifact.layer === "derived" &&
      artifact.provenance.kind === "derived",
  );
}

/** Record a human decision about a derived draft. Approval makes the lemma retrievable. */
export async function reviewConditionalLemma(
  library: LibraryStore,
  input: ReviewLemmaInput,
): Promise<ReviewLemmaResult> {
  const listed = await listLibrary(library, { sessionId: input.sessionId, layers: ["derived"] });
  if (listed.status !== "found") return listed;
  const results = derivedResults(listed.artifacts);
  const eventId = `library-addition:${input.commandId}`;
  const events = await readAdditionEvents(library, input.sessionId);
  if (events.status !== "found") return events;
  const prior = events.events.find(({ id }) => id === eventId);
  if (prior !== undefined) {
    const artifact = prior.artifact;
    if (
      artifact.kind !== "result" ||
      artifact.review === undefined ||
      artifact.review.reviewOf !== input.draftArtifactId
    ) {
      return refused("event-id-conflict", "The command ID is bound to another addition.");
    }
    return {
      status: "recorded",
      replayed: true,
      artifact,
      draftArtifactId: input.draftArtifactId,
      decision: artifact.review.decision as LemmaReviewDecision,
      retrievable: approvedDerivedResults([...results, artifact]).some(
        ({ id }) => id === artifact.id,
      ),
    };
  }
  const draft = results.find(
    ({ id, review }) => id === input.draftArtifactId && review === undefined,
  );
  if (draft === undefined) {
    return refused("draft-not-found", "The session has no such lemma draft.");
  }
  if (results.some(({ review }) => review?.reviewOf === draft.id)) {
    return refused("draft-already-reviewed", "The lemma draft already has a recorded review.");
  }
  if (input.decision !== "approved" && input.notes.trim().length === 0) {
    return refused("review-notes-required", "A rejection needs notes saying why.");
  }
  const review: LibraryResultReview = {
    decision: input.decision,
    reviewerId: input.reviewerId,
    reviewedAt: input.occurredAt,
    notes: input.notes,
    reviewOf: draft.id,
  };
  const artifact = {
    ...draft,
    id: `${draft.id}.review.${input.commandId}`,
    approval:
      input.decision === "approved"
        ? ({ status: "approved", reviewerId: input.reviewerId } as const)
        : ({ status: "draft" } as const),
    review,
  };
  const added = await addLibraryArtifact(library, {
    id: eventId,
    sessionId: input.sessionId,
    occurredAt: input.occurredAt,
    layer: "derived",
    origin: { kind: "user", actorId: input.reviewerId },
    artifact,
  });
  if (added.status !== "recorded") return added;
  if (!added.admitted || added.event.artifact.kind !== "result") {
    return refused(
      "library-admission-rejected",
      added.event.admission.diagnostics[0]?.message ?? "The review was not admitted.",
    );
  }
  return {
    status: "recorded",
    replayed: added.replayed,
    artifact: added.event.artifact,
    draftArtifactId: draft.id,
    decision: input.decision,
    retrievable: input.decision === "approved",
  };
}

// ---------------------------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------------------------

/** The approved, reviewed derived lemmas of a session's stored artifacts. */
export function approvedDerivedResults(
  artifacts: readonly LibraryArtifact[],
): readonly LibraryResult[] {
  const results = derivedResults(artifacts);
  const drafts = new Set(results.filter(({ review }) => review === undefined).map(({ id }) => id));
  return results.filter(
    (result) =>
      result.approval.status === "approved" &&
      result.review?.decision === "approved" &&
      drafts.has(result.review.reviewOf),
  );
}

/** A definition catalog whose approved results also include the session's approved lemmas. */
export function withApprovedLemmas(
  base: DefinitionCatalog,
  lemmas: readonly LibraryResult[],
): DefinitionCatalog {
  if (lemmas.length === 0) return base;
  const cache = new Map<string, ReturnType<DefinitionCatalog["catalog"]>>();
  return Object.freeze({
    ...base,
    catalog(operators: Parameters<DefinitionCatalog["catalog"]>[0]) {
      const key = JSON.stringify(operators);
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const approved = base.catalog(operators);
      const taken = new Set(approved.results.map(({ id }) => id));
      // A lemma the kernel cannot instantiate in this environment is not offered.
      const usable = lemmas.filter(
        (lemma) => !taken.has(lemma.id) && approvedKernelResults([lemma], { operators }).ok,
      );
      const catalog =
        usable.length === 0
          ? approved
          : adaptApprovedCatalog(
              operators,
              [...approved.results, ...usable],
              approved.variantFamilies,
            );
      cache.set(key, catalog);
      return catalog;
    },
  });
}
