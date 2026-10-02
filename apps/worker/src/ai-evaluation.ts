/**
 * Offline scoring contracts for AI adapters. The adapters are injected by callers; this module
 * never contacts a model. Corpus answers remain evaluator-side and are not part of role context.
 */
import { alphaEquivalent } from "@proof/kernel";
import { isDeepStrictEqual } from "node:util";
import { analyzeDiscoveryTree, type ProofEdge, type ProofNode } from "@proof/protocol";
import {
  BENCHMARK_CORPUS,
  corpusRootState,
  type CorpusProblem,
  type CorpusSelection,
  type CorpusStep,
  starterLibraryPacks,
  type LibraryPack,
} from "@proof/library";
import type { MoveShortlisterContext } from "@proof/llm";
import {
  PROBLEM_SETUP_SORT_CHOICES,
  problemSetupSortIdSchema,
  type ProblemDraft,
} from "@proof/protocol";
import { validateProblemDraft, type ProblemDraftValidation } from "./problem-setup";

export type RankedSuggestion = Readonly<{
  source: "move" | "result";
  artifactId: string;
  patternId?: string;
}>;

export type ShortlisterPrediction = Readonly<{
  problemId: string;
  /** One ordered list per corpus step, matching the request order. */
  rankedSteps: readonly (readonly RankedSuggestion[])[];
}>;

export type ShortlisterScore = Readonly<{
  totalSteps: number;
  scoredSteps: number;
  missingSteps: number;
  coverage: number;
  top1Matches: number;
  /** Missing steps count as misses. */
  top1Accuracy: number;
  /** Accuracy among steps with at least one returned candidate. */
  scoredAccuracy: number;
  hitAtK: Readonly<Record<number, number>>;
}>;

/** Score exact corpus choices while preserving the corpus's optional pattern wildcard. */
export function scoreShortlister(
  predictions: readonly ShortlisterPrediction[],
  problems: readonly CorpusProblem[] = BENCHMARK_CORPUS,
  ks: readonly number[] = [3, 5],
): ShortlisterScore {
  const byProblem = new Map(predictions.map((prediction) => [prediction.problemId, prediction]));
  const hitAtK: Record<number, number> = Object.fromEntries(ks.map((k) => [k, 0]));
  let totalSteps = 0;
  let scoredSteps = 0;
  let top1Matches = 0;
  for (const problem of problems) {
    const prediction = byProblem.get(problem.id);
    for (const [index, step] of problem.steps.entries()) {
      totalSteps += 1;
      const ranked = prediction?.rankedSteps[index];
      if (ranked === undefined || ranked.length === 0) continue;
      scoredSteps += 1;
      const matches = (choice: RankedSuggestion) =>
        choice.source === step.suggestion.source &&
        choice.artifactId === step.suggestion.artifactId &&
        (step.suggestion.patternId === undefined || choice.patternId === step.suggestion.patternId);
      if (matches(ranked[0]!)) top1Matches += 1;
      for (const k of ks) {
        if (ranked.slice(0, k).some(matches)) hitAtK[k] = hitAtK[k]! + 1;
      }
    }
  }
  return Object.freeze({
    totalSteps,
    scoredSteps,
    missingSteps: totalSteps - scoredSteps,
    coverage: totalSteps === 0 ? 0 : scoredSteps / totalSteps,
    top1Matches,
    top1Accuracy: totalSteps === 0 ? 0 : top1Matches / totalSteps,
    scoredAccuracy: scoredSteps === 0 ? 0 : top1Matches / scoredSteps,
    hitAtK: Object.freeze(hitAtK),
  });
}

export type ShortlisterEvaluationSession = Readonly<{
  /** Build from current HTTP state and selections. The recorded choice is withheld. */
  prepareContext(selections: readonly CorpusSelection[]): Promise<
    Readonly<{
      context: MoveShortlisterContext;
      /** Resolve returned displayed suggestion IDs in evaluator-private state. */
      resolveChoiceIds(ids: readonly string[]): readonly RankedSuggestion[];
    }>
  >;
  /** Apply the recorded corpus choice after inference, then advance the session state. */
  teacherForce(step: CorpusStep, index: number): Promise<void>;
}>;

export type ShortlisterCorpusAdapter = Readonly<{
  /** Initialize from the root snapshot; step answers stay with the evaluator. */
  createSession(problem: EvaluationProblemSeed): Promise<ShortlisterEvaluationSession>;
  /** Return ranked displayed suggestion IDs (the shape emitted by the LLM role). */
  shortlist(context: MoveShortlisterContext): Promise<readonly string[]>;
}>;

/**
 * Evaluate a shortlister across recorded HTTP steps. Only a role context reaches `shortlist`;
 * the corpus suggestion is supplied to teacher forcing after the proposal is complete.
 */
export async function evaluateShortlisterCorpus(
  adapter: ShortlisterCorpusAdapter,
  problems: readonly CorpusProblem[] = BENCHMARK_CORPUS,
  ks: readonly number[] = [3, 5],
): Promise<Readonly<{ score: ShortlisterScore; predictions: readonly ShortlisterPrediction[] }>> {
  const predictions: ShortlisterPrediction[] = [];
  for (const problem of problems) {
    const session = await adapter.createSession(evaluationProblemSeed(problem));
    const rankedSteps: RankedSuggestion[][] = [];
    for (const [index, step] of problem.steps.entries()) {
      const context = await session.prepareContext(step.selections);
      const choiceIds = await adapter.shortlist(context.context);
      rankedSteps.push([...context.resolveChoiceIds(choiceIds)]);
      await session.teacherForce(step, index);
    }
    predictions.push({ problemId: problem.id, rankedSteps });
  }
  return Object.freeze({
    score: scoreShortlister(predictions, problems, ks),
    predictions: Object.freeze(predictions),
  });
}

export type FormalizerScore = Readonly<{
  problemId: string;
  valid: boolean;
  matchesReference: boolean;
  diagnostics: readonly string[];
}>;

export type FormalizerTask = Readonly<{
  problemId: string;
  title: string;
  statement: string;
  domain: string;
  background: ProblemDraft["background"];
  packs: readonly string[];
  approvedLibrary: readonly LibraryPack[];
  libraryLayerIds: readonly ProblemDraft["libraryLayerIds"][number][];
}>;

/** Safe problem data for opening an HTTP session; it deliberately has no recorded solution steps. */
export type EvaluationProblemSeed = Readonly<{
  problemId: string;
  title: string;
  statement: string;
  domain: string;
  packs: readonly string[];
  operators: CorpusProblem["operators"];
  initialState: unknown;
}>;

function evaluationProblemSeed(problem: CorpusProblem): EvaluationProblemSeed {
  return Object.freeze({
    problemId: problem.id,
    title: problem.title,
    statement: problem.statement,
    domain: problem.domain,
    packs: [...problem.packs],
    operators: problem.operators,
    initialState: corpusRootState(problem, "state:evaluation-root"),
  });
}

export function formalizerTask(problem: CorpusProblem): FormalizerTask {
  const background: ProblemDraft["background"] = {
    level: "first-year undergraduate",
    summary: `Benchmark background for ${problem.domain}.`,
    assumptions: [],
    domains: [problem.domain],
    maximumLevel: "undergraduate",
  };
  const libraryLayerIds: ProblemDraft["libraryLayerIds"] = [
    "layer:global",
    "layer:initial-problem",
  ];
  const selectedPacks = new Set(problem.packs);
  const approvedLibrary = starterLibraryPacks().filter((pack) => selectedPacks.has(pack.id));
  return Object.freeze({
    problemId: problem.id,
    title: problem.title,
    statement: problem.statement,
    domain: problem.domain,
    background,
    packs: [...problem.packs],
    approvedLibrary,
    libraryLayerIds,
  });
}

export type FormalizerCorpusAdapter = Readonly<{
  formalize(task: FormalizerTask): Promise<unknown>;
}>;

/** Run an injected formalizer over the corpus; tasks omit hypotheses, goals, and solution steps. */
export async function evaluateFormalizerCorpus(
  adapter: FormalizerCorpusAdapter,
  problems: readonly CorpusProblem[] = BENCHMARK_CORPUS,
): Promise<
  Readonly<{ cases: readonly FormalizerScore[]; valid: number; referenceMatches: number }>
> {
  const cases: FormalizerScore[] = [];
  for (const problem of problems) {
    const proposed = await adapter.formalize(formalizerTask(problem));
    const draft =
      proposed !== null && typeof proposed === "object" && "draft" in proposed
        ? (proposed as { draft: unknown }).draft
        : proposed;
    cases.push(scoreFormalizerDraft(problem, draft));
  }
  return Object.freeze({
    cases: Object.freeze(cases),
    valid: cases.filter(({ valid }) => valid).length,
    referenceMatches: cases.filter(({ matchesReference }) => matchesReference).length,
  });
}

function initialStateMatches(problem: CorpusProblem, actual: ProofNode["state"]): boolean {
  const expected = corpusRootState(problem, "state:expected") as {
    goals: readonly {
      sequent: {
        context: {
          declarations: readonly { symbol: string; sort: unknown; role: string }[];
          hypotheses: readonly {
            statement: { expression: Parameters<typeof alphaEquivalent>[0] };
          }[];
        };
        conclusion: { expression: Parameters<typeof alphaEquivalent>[0] };
      };
    }[];
    obligations: readonly unknown[];
  };
  const actualGoals = actual.goals;
  const expectedGoal = expected.goals[0];
  const actualGoal = actualGoals[0];
  const actualContext = actualGoal?.sequent.context;
  const expectedContext = expectedGoal?.sequent.context;
  const declarationsMatch =
    actualContext?.declarations.length === expectedContext?.declarations.length &&
    actualContext?.declarations.every((declaration, index) => {
      const wanted = expectedContext?.declarations[index];
      return (
        wanted !== undefined &&
        declaration.symbol === wanted.symbol &&
        declaration.role === wanted.role &&
        isDeepStrictEqual(declaration.sort, wanted.sort)
      );
    }) === true;
  const hypothesesMatch =
    actualContext?.hypotheses.length === expectedContext?.hypotheses.length &&
    actualContext?.hypotheses.every((hypothesis, index) => {
      const wanted = expectedContext?.hypotheses[index];
      return (
        wanted !== undefined &&
        alphaEquivalent(hypothesis.statement.expression, wanted.statement.expression, {
          operators: problem.operators,
        })
      );
    }) === true;
  const goalMatches =
    actualGoals.length === 1 &&
    actualGoal !== undefined &&
    expectedGoal !== undefined &&
    alphaEquivalent(
      actualGoal.sequent.conclusion.expression,
      expectedGoal.sequent.conclusion.expression,
      { operators: problem.operators },
    );
  return (
    declarationsMatch &&
    hypothesesMatch &&
    goalMatches &&
    actual.obligations.length === 0 &&
    expected.obligations.length === 0
  );
}

/** Validate through the same pure N26 admission function used by problem setup. */
export function scoreFormalizerDraft(
  problem: CorpusProblem,
  input: unknown,
  validate: (draft: unknown) => ProblemDraftValidation = validateProblemDraft,
): FormalizerScore {
  const validation = validate(input);
  if (!validation.ok) {
    return Object.freeze({
      problemId: problem.id,
      valid: false,
      matchesReference: false,
      diagnostics: validation.diagnostics.map(({ code, path }) => `${code}:${path.join(".")}`),
    });
  }
  const matchesReference = initialStateMatches(problem, validation.value.rootNode.state);
  return Object.freeze({
    problemId: problem.id,
    valid: true,
    matchesReference,
    diagnostics: matchesReference ? [] : ["initial-state-mismatch"],
  });
}

/** Construct a reference draft for adapters and tests from the handwritten corpus state. */
export function corpusReferenceDraft(problem: CorpusProblem): ProblemDraft {
  const declarations = problem.declarations.map(([symbol, sort]) => {
    const match = PROBLEM_SETUP_SORT_CHOICES.find(
      (choice) => JSON.stringify(choice.sort) === JSON.stringify(sort),
    );
    if (match === undefined) throw new Error(`No problem-setup sort for corpus symbol ${symbol}.`);
    return { symbol, sort: problemSetupSortIdSchema.parse(match.id) };
  });
  return {
    problem: { title: problem.title, statement: problem.statement },
    background: {
      level: "first-year undergraduate",
      summary: `Benchmark background for ${problem.domain}.`,
      assumptions: [],
      domains: [problem.domain],
      maximumLevel: "undergraduate",
    },
    libraryLayerIds: ["layer:global", "layer:initial-problem"],
    packs: [...problem.packs],
    declarations,
    hypotheses: problem.hypotheses.map((expression) => ({ format: "mathjson", expression })),
    goals: [{ format: "mathjson", expression: problem.goal }],
  };
}

export type AgentHttpTrace = Readonly<{
  session: Readonly<{ rootNodeId: ProofNode["id"] }>;
  nodes: readonly ProofNode[];
  edges: readonly Readonly<{ edge: ProofEdge }>[];
}>;

export type StatefulAgentScore = Readonly<{
  problemId: string;
  analyzed: boolean;
  initialStateMatches: boolean;
  solved: boolean;
  clean: boolean;
  passed: boolean;
  diagnostics: readonly string[];
}>;

/** Score the trace captured from an HTTP protocol session; this function runs no agent. */
export function scoreStatefulAgentTrace(
  problem: CorpusProblem,
  trace: AgentHttpTrace,
): StatefulAgentScore {
  const root = trace.nodes.find((node) => node.id === trace.session.rootNodeId);
  const rootMatches = root !== undefined && initialStateMatches(problem, root.state);
  if (!rootMatches) {
    return Object.freeze({
      problemId: problem.id,
      analyzed: false,
      initialStateMatches: false,
      solved: false,
      clean: false,
      passed: false,
      diagnostics: ["initial-state-mismatch"],
    });
  }
  const analysis = analyzeDiscoveryTree({
    nodes: [...trace.nodes],
    edges: trace.edges.map(({ edge }) => edge),
    rootId: trace.session.rootNodeId,
  });
  if (!analysis.ok) {
    return Object.freeze({
      problemId: problem.id,
      analyzed: false,
      initialStateMatches: true,
      solved: false,
      clean: false,
      passed: false,
      diagnostics: [analysis.diagnostics.map(({ code }) => code).join(",")],
    });
  }
  const solved = analysis.solved;
  const clean =
    analysis.solvedRelativeTo.backgroundInferences.length === 0 &&
    analysis.solvedRelativeTo.sorries.length === 0;
  return Object.freeze({
    problemId: problem.id,
    analyzed: true,
    initialStateMatches: true,
    solved,
    clean,
    passed: solved && clean,
    diagnostics: solved && clean ? [] : ["unsolved-or-relies-on-background-inference-or-sorry"],
  });
}

export type EvaluationHttpSession = Readonly<{
  get(path?: string): Promise<Response>;
  post(path: string, body: unknown): Promise<Response>;
}>;

export type StatefulAgentHttpAdapter = Readonly<{
  /** Create a fresh HTTP proof session; the evaluator withholds the recorded solution steps. */
  createSession(problem: EvaluationProblemSeed): Promise<EvaluationHttpSession>;
  /** Drive the session using the same HTTP protocol commands available to a human. */
  run(problem: EvaluationProblemSeed, session: EvaluationHttpSession): Promise<void>;
}>;

/** Run an injected agent adapter over its HTTP client and score the fetched stored history. */
export async function evaluateStatefulAgentOverHttp(
  problem: CorpusProblem,
  adapter: StatefulAgentHttpAdapter,
): Promise<StatefulAgentScore> {
  const seed = evaluationProblemSeed(problem);
  const session = await adapter.createSession(seed);
  await adapter.run(seed, session);
  const historyResponse = await session.get("history");
  if (!historyResponse.ok) {
    return Object.freeze({
      problemId: problem.id,
      analyzed: false,
      initialStateMatches: false,
      solved: false,
      clean: false,
      passed: false,
      diagnostics: [`history-http-${historyResponse.status}`],
    });
  }
  const trace = (await historyResponse.json()) as AgentHttpTrace;
  return scoreStatefulAgentTrace(problem, trace);
}
