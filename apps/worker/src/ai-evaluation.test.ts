import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BENCHMARK_CORPUS } from "@proof/library";
import { buildMoveShortlisterContext } from "@proof/llm";
import {
  corpusReferenceDraft,
  evaluateFormalizerCorpus,
  evaluateShortlisterCorpus,
  scoreFormalizerDraft,
  scoreShortlister,
  scoreStatefulAgentTrace,
  evaluateStatefulAgentOverHttp,
  type StatefulAgentHttpAdapter,
} from "./ai-evaluation";
import {
  currentNode,
  json,
  runCorpusStep,
  selectionDescriptor,
  startCorpusSession,
  type CorpusSession,
} from "./proof-http/corpus-harness.testing";
import type { ProofHttpService } from "./proof-http";

const problem = BENCHMARK_CORPUS[0]!;
const smallestProblem = BENCHMARK_CORPUS.reduce((smallest, candidate) =>
  candidate.steps.length < smallest.steps.length ? candidate : smallest,
);
const services: ProofHttpService[] = [];
const coverageGolden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./proof-http/corpus-coverage.golden.json", import.meta.url)),
    "utf8",
  ),
) as { totals: { problems: number; steps: number } };

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

describe("offline AI evaluation contracts", () => {
  it("scores the checked-in 37-problem, 124-step benchmark corpus", () => {
    expect(BENCHMARK_CORPUS).toHaveLength(coverageGolden.totals.problems);
    expect(BENCHMARK_CORPUS.reduce((count, item) => count + item.steps.length, 0)).toBe(
      coverageGolden.totals.steps,
    );
  });

  it("builds a validating reference draft for every corpus problem", () => {
    for (const corpusProblem of BENCHMARK_CORPUS) {
      expect(
        scoreFormalizerDraft(corpusProblem, corpusReferenceDraft(corpusProblem)),
      ).toMatchObject({
        valid: true,
        matchesReference: true,
      });
    }
  });

  it("runs the formalizer adapter across private corpus targets", async () => {
    const seen: string[] = [];
    const result = await evaluateFormalizerCorpus({
      formalize: async (task) => {
        seen.push(task.problemId);
        expect(task).not.toHaveProperty("goals");
        expect(task).not.toHaveProperty("hypotheses");
        expect(task).not.toHaveProperty("steps");
        const reference = BENCHMARK_CORPUS.find(({ id }) => id === task.problemId)!;
        return { kind: "formalization", draft: corpusReferenceDraft(reference) };
      },
    });
    expect(seen).toHaveLength(37);
    expect(result).toMatchObject({ valid: 37, referenceMatches: 37 });
  });

  it("scores a valid formalizer draft against the handwritten initial state", () => {
    const draft = corpusReferenceDraft(problem);
    expect(scoreFormalizerDraft(problem, draft)).toMatchObject({
      valid: true,
      matchesReference: true,
      diagnostics: [],
    });
    expect(scoreFormalizerDraft(problem, { ...draft, goals: [] })).toMatchObject({
      valid: false,
      matchesReference: false,
    });
    expect(
      scoreFormalizerDraft(problem, {
        ...draft,
        goals: [{ format: "mathjson", expression: ["Not", problem.goal] }],
      }),
    ).toMatchObject({
      valid: true,
      matchesReference: false,
      diagnostics: ["initial-state-mismatch"],
    });
  });

  it("scores the exact recorded shortlister choice and its rank", () => {
    const firstStep = problem.steps[0]!;
    const score = scoreShortlister(
      [
        {
          problemId: problem.id,
          rankedSteps: [
            [
              { source: "move", artifactId: "move:wrong" },
              {
                source: firstStep.suggestion.source,
                artifactId: firstStep.suggestion.artifactId,
                ...(firstStep.suggestion.patternId === undefined
                  ? {}
                  : { patternId: firstStep.suggestion.patternId }),
              },
            ],
          ],
        },
      ],
      [problem],
      [1, 2],
    );
    expect(score).toMatchObject({
      totalSteps: problem.steps.length,
      scoredSteps: 1,
      missingSteps: problem.steps.length - 1,
      top1Matches: 0,
      top1Accuracy: 0,
      scoredAccuracy: 0,
    });
    expect(score.hitAtK[2]).toBe(1);
  });

  it("shortlists before teacher forcing each recorded HTTP step", async () => {
    let currentIndex = 0;
    const ordering: string[] = [];
    let httpSession: CorpusSession | undefined;
    const result = await evaluateShortlisterCorpus(
      {
        createSession: async () => {
          httpSession = await startCorpusSession(smallestProblem, services);
          return {
            prepareContext: async (selections) => {
              ordering.push("context");
              expect(selections).toEqual(smallestProblem.steps[currentIndex]!.selections);
              const node = await currentNode(httpSession!);
              const response = await httpSession!.post("suggestion-sets", {
                id: `suggestion-set:eval-${currentIndex}`,
                selections: selections.map((selection) => selectionDescriptor(node, selection)),
              });
              expect(response.status).toBe(201);
              const set = (await json(response)).suggestionSet as {
                suggestions: readonly {
                  id: string;
                  source: "move" | "result";
                  artifactId: string;
                  patternId?: string;
                }[];
              };
              const built = buildMoveShortlisterContext({
                id: `llm-call:eval-${currentIndex}`,
                node,
                suggestionSet: set,
                candidateIds: set.suggestions.map(({ id }) => id),
                trigger: "explicit-user",
                operators: smallestProblem.operators,
              });
              if (!built.ok || built.envelope.role !== "move-shortlister") {
                throw new Error(JSON.stringify(built));
              }
              expect(built.envelope.context).not.toHaveProperty("recordedSuggestion");
              const byId = new Map(
                set.suggestions.map((suggestion) => [suggestion.id, suggestion]),
              );
              return {
                context: built.envelope.context,
                resolveChoiceIds: (ids) =>
                  ids.flatMap((id) => {
                    const suggestion = byId.get(id);
                    return suggestion === undefined
                      ? []
                      : [
                          {
                            source: suggestion.source,
                            artifactId: suggestion.artifactId,
                            ...(suggestion.patternId === undefined
                              ? {}
                              : { patternId: suggestion.patternId }),
                          },
                        ];
                  }),
              };
            },
            teacherForce: async (step, index) => {
              ordering.push("teacher-force");
              expect(step).toBe(smallestProblem.steps[index]);
              await runCorpusStep(httpSession!, smallestProblem, step, index);
              currentIndex += 1;
            },
          };
        },
        shortlist: async (context) => {
          ordering.push("shortlist");
          expect(context.candidates.length).toBeGreaterThan(0);
          const candidate = context.candidates[0]!;
          return [candidate.id];
        },
      },
      [smallestProblem],
      [1],
    );
    expect(ordering).toEqual(
      Array.from({ length: smallestProblem.steps.length }, () => [
        "context",
        "shortlist",
        "teacher-force",
      ]).flat(),
    );
    expect(result.score).toMatchObject({
      totalSteps: smallestProblem.steps.length,
      scoredSteps: smallestProblem.steps.length,
      missingSteps: 0,
    });
  });

  it("rejects an agent trace that cannot be analyzed", () => {
    const result = scoreStatefulAgentTrace(problem, {
      session: { rootNodeId: "node:missing" as never },
      nodes: [],
      edges: [],
    });
    expect(result).toMatchObject({
      analyzed: false,
      initialStateMatches: false,
      solved: false,
      clean: false,
      passed: false,
    });
  });

  it("runs an injected agent adapter over HTTP and rejects a solved trace for another root", async () => {
    let recordedSession: CorpusSession | undefined;
    const adapter: StatefulAgentHttpAdapter = {
      createSession: async () => {
        recordedSession = await startCorpusSession(smallestProblem, services);
        return recordedSession;
      },
      run: async (_problem, session: CorpusSession) => {
        for (const [index, step] of smallestProblem.steps.entries()) {
          await runCorpusStep(session, smallestProblem, step, index);
        }
      },
    };
    const result = await evaluateStatefulAgentOverHttp(smallestProblem, adapter);
    expect(result).toMatchObject({
      analyzed: true,
      initialStateMatches: true,
      solved: true,
      clean: true,
      passed: true,
    });
    const history = (await (await recordedSession!.get("history")).json()) as Parameters<
      typeof scoreStatefulAgentTrace
    >[1];
    const otherProblem = BENCHMARK_CORPUS.find((candidate) => candidate.id !== smallestProblem.id)!;
    expect(scoreStatefulAgentTrace(otherProblem, history)).toMatchObject({
      analyzed: false,
      initialStateMatches: false,
      passed: false,
    });
  });
});
