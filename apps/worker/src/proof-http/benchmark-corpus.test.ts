import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { afterEach, describe, expect, it } from "vitest";
import {
  BENCHMARK_CORPUS,
  CLOSURE_OPERATOR_DECLARATIONS,
  CORE_LOGIC_RESULTS,
  ELEMENTARY_CORPUS,
  EXTENDED_CORPUS,
  LIBRARY_PACK_IDS,
  libraryPacksForOperators,
  starterLibraryPacks,
  type CorpusProblem,
} from "@proof/library";
import { createPresentation } from "@proof/language";
import { analyzeDiscoveryTree, prunedProof, type ProofEdge, type ProofNode } from "@proof/protocol";
import type { ProofHttpService } from ".";
import {
  json,
  runCorpusStep,
  startCorpusSession,
  type CorpusStepRecord,
} from "./corpus-harness.testing";

/**
 * N16 and N37 acceptance: every problem of the benchmark corpus (the elementary corpus and its
 * extension across logic, algebra, number theory, sets, order and a research-notation case) is
 * solved through the proof HTTP service by its scripted sequence of displayed suggestions. The
 * finished discovery tree must be solved (N17) without sorries or background inferences.
 *
 * The deterministic coverage record — per problem, the interactions each step needed, the rank of
 * the chosen suggestion among those displayed, and the kernel operations applied; per domain and
 * in total, the same counts; and which approved results the corpus exercises — is compared with
 * the checked-in golden `corpus-coverage.golden.json`. Run vitest with `-u` to accept a change.
 */

const services: ProofHttpService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

const N16_PACK_IDS = [
  "pack:elementary-logic",
  "pack:equality",
  "pack:order",
  "pack:arithmetic",
  "pack:sets",
];
const N37_DOMAINS = ["logic", "algebra", "number-theory", "sets", "order", "research-notation"];

type ProblemRecord = Readonly<{
  id: string;
  domain: string;
  packs: readonly string[];
  steps: readonly (CorpusStepRecord & Readonly<{ operation: string; transition: string }>)[];
}>;

const records = new Map<string, ProblemRecord>();

describe("benchmark corpus through the proof HTTP service", () => {
  it("has at least eight elementary problems covering every N16 starter pack", () => {
    expect(ELEMENTARY_CORPUS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(ELEMENTARY_CORPUS.flatMap((problem) => problem.packs))).toEqual(
      new Set(N16_PACK_IDS),
    );
  });

  it("extends the corpus across the N37 domains and covers every pack", () => {
    expect(new Set(BENCHMARK_CORPUS.map((problem) => problem.id)).size).toBe(
      BENCHMARK_CORPUS.length,
    );
    expect(BENCHMARK_CORPUS).toEqual([...ELEMENTARY_CORPUS, ...EXTENDED_CORPUS]);
    const domains = new Set(EXTENDED_CORPUS.map((problem) => problem.domain));
    expect([...domains].sort()).toEqual([...N37_DOMAINS].sort());
    N37_DOMAINS.forEach((domain) =>
      expect(
        EXTENDED_CORPUS.filter((problem) => problem.domain === domain).length,
      ).toBeGreaterThanOrEqual(3),
    );
    expect(new Set(BENCHMARK_CORPUS.flatMap((problem) => problem.packs))).toEqual(
      new Set(LIBRARY_PACK_IDS),
    );
  });

  it("presents the research-notation operator through its N02 metadata", () => {
    const research = EXTENDED_CORPUS.filter((problem) => problem.domain === "research-notation");
    research.forEach((problem) =>
      expect(problem.operators).toEqual(expect.arrayContaining([...CLOSURE_OPERATOR_DECLARATIONS])),
    );
    const presentation = createPresentation({ operators: research[0]!.operators });
    const statement = ["SubsetEqual", ["Closure", "A"], ["Closure", ["Closure", "B"]]] as const;
    const latex = presentation.latex(statement);
    expect(latex).toBe(
      String.raw`\operatorname{cl}\left(A\right) \subseteq \operatorname{cl}\left(\operatorname{cl}\left(B\right)\right)`,
    );
    expect(presentation.naturalLanguage(statement)).toContain("the closure of");
    expect(presentation.parseLatex(latex)).toMatchObject({ ok: true, expression: statement });
  });

  it.each(BENCHMARK_CORPUS.map((problem) => [problem.id, problem] as const))(
    "solves %s with displayed suggestions only",
    async (_id, problem) => {
      const active = libraryPacksForOperators(problem.operators).map((pack) => pack.id);
      problem.packs.forEach((pack) => expect(active).toContain(pack));

      const session = await startCorpusSession(problem, services);
      const stepRecords: CorpusStepRecord[] = [];
      for (const [index, step] of problem.steps.entries()) {
        stepRecords.push(await runCorpusStep(session, problem, step, index));
      }

      const final = await json<{ node: ProofNode }>(await session.get());
      expect(final.node.state.goals).toEqual([]);
      expect(final.node.state.obligations).toEqual([]);

      const history = await json<{
        session: { rootNodeId: string };
        nodes: ProofNode[];
        edges: { edge: ProofEdge }[];
      }>(await session.get("history"));
      expect(history.edges).toHaveLength(problem.steps.length);
      const analysis = analyzeDiscoveryTree({
        nodes: history.nodes,
        edges: history.edges,
        rootId: history.session.rootNodeId as ProofNode["id"],
      });
      expect(analysis).toMatchObject({
        ok: true,
        solved: true,
        solvedRelativeTo: { backgroundInferences: [], sorries: [] },
        assumptions: [],
      });
      if (!analysis.ok) throw new Error("The discovery tree could not be analyzed.");
      expect(analysis.route.steps).toHaveLength(problem.steps.length);
      expect(analysis.route.steps.every((step) => step.transitionClass !== "weakening")).toBe(true);
      expect(prunedProof(analysis)).toMatchObject({ ok: true });

      const edgeByCommand = new Map(
        history.edges.map(({ edge }) => [edge.commandId as string, edge]),
      );
      records.set(problem.id, {
        id: problem.id,
        domain: problem.domain,
        packs: problem.packs,
        steps: stepRecords.map((record, index) => {
          const edge = edgeByCommand.get(
            `command:${problem.id.slice("corpus:".length)}-${index + 1}`,
          );
          if (edge === undefined) throw new Error(`${problem.id} step ${index + 1} has no edge.`);
          return { ...record, operation: edge.operation.kind, transition: edge.transitionClass };
        }),
      });
    },
  );

  it("records deterministic coverage and interaction counts", async () => {
    expect([...records.keys()]).toEqual(BENCHMARK_CORPUS.map((problem) => problem.id));
    const summary = coverageSummary(BENCHMARK_CORPUS, records);
    const path = fileURLToPath(new URL("./corpus-coverage.golden.json", import.meta.url));
    const text = await format(JSON.stringify(summary), {
      ...(await resolveConfig(path)),
      parser: "json",
    });
    await expect(text).toMatchFileSnapshot(path);
  });
});

type Interactions = {
  problems: number;
  steps: number;
  selections: number;
  suggestionRequests: number;
  previewRequests: number;
  menuChoices: number;
  applies: number;
  /** Chosen suggestions not ranked first among those displayed. */
  chosenBelowFirst: number;
};

function emptyInteractions(): Interactions {
  return {
    problems: 0,
    steps: 0,
    selections: 0,
    suggestionRequests: 0,
    previewRequests: 0,
    menuChoices: 0,
    applies: 0,
    chosenBelowFirst: 0,
  };
}

function addProblem(total: Interactions, record: ProblemRecord): Interactions {
  total.problems += 1;
  for (const step of record.steps) {
    total.steps += 1;
    total.selections += step.selections;
    total.suggestionRequests += step.suggestionRequests;
    total.previewRequests += step.previewRequests;
    total.menuChoices += step.menuChoices;
    total.applies += step.applies;
    if (step.chosenRank > 1) total.chosenBelowFirst += 1;
  }
  return total;
}

function coverageSummary(
  corpus: readonly CorpusProblem[],
  byId: ReadonlyMap<string, ProblemRecord>,
) {
  const problems = corpus.map((problem) => byId.get(problem.id)!);
  const domains: Record<string, Interactions> = {};
  for (const record of problems) {
    addProblem((domains[record.domain] ??= emptyInteractions()), record);
  }
  const used = new Set(problems.flatMap((record) => record.steps.map((step) => step.suggestion)));
  const catalog = [
    ...CORE_LOGIC_RESULTS.map((result) => result.id as string),
    ...starterLibraryPacks().flatMap((pack) => pack.results.map((result) => result.id as string)),
  ];
  const sorted = (values: Iterable<string>) => [...values].sort();
  return {
    description:
      "Deterministic coverage of the benchmark corpus (roadmap N37). Every problem is solved " +
      "through the proof HTTP service by displayed suggestions and menu choices only; no " +
      "expression is typed and no model is called.",
    totals: problems.reduce(addProblem, emptyInteractions()),
    domains,
    results: {
      used: sorted(catalog.filter((id) => used.has(id))),
      unused: sorted(catalog.filter((id) => !used.has(id))),
    },
    moves: sorted([...used].filter((id) => id.startsWith("move:"))),
    operations: sorted(new Set(problems.flatMap((record) => record.steps.map((s) => s.operation)))),
    problems: problems.map((record) => ({
      id: record.id,
      domain: record.domain,
      packs: record.packs,
      interactions: addProblem(emptyInteractions(), record),
      steps: record.steps.map((step) => ({
        suggestion: step.suggestion,
        ...(step.pattern === undefined ? {} : { pattern: step.pattern }),
        rank: `${step.chosenRank}/${step.displayed}`,
        operation: step.operation,
        transition: step.transition,
        ...(step.menuChoices === 0 ? {} : { menuChoices: step.menuChoices }),
      })),
    })),
  };
}
