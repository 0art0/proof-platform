import { expect } from "vitest";
import {
  BENCHMARK_CORPUS,
  corpusRootState,
  libraryResultSchema,
  type CorpusProblem,
  type LibraryResult,
} from "@proof/library";
import {
  createProofNodeSchema,
  type ProofArtifact,
  type ProofEdge,
  type ProofNode,
  type ProtocolEnvironment,
} from "@proof/protocol";
import { addLibraryArtifact, reviseBackground } from "./library-repository";
import { MemoryLibraryStore } from "./memory-library-store";
import { initializeProofSession } from "./proof-repository";
import { createProofHttpService, type ProofHttpService } from "./proof-http";
import { runCorpusStep, type CorpusSession } from "./proof-http/corpus-harness.testing";

/**
 * A test-only proof session with every non-AI artifact section populated, built over HTTP on a
 * `MemoryLibraryStore` (roadmap N27): the benchmark corpus solve of `corpus:contraposition`, an
 * interaction event, an inquiry command, a deleted sorry, a kept sorry, a backtrack with
 * information (its case split and interaction event), a semantic replay, and library additions
 * (admitted, rejected, admitted after a background revision).
 */

export const ARTIFACT_SESSION_ID = "session:artifact-source";
export const FIXED_NOW = () => new Date("2026-09-29T12:00:00.000Z");
const HUMAN = { id: "actor:web", kind: "human" } as const;
/** The recorded time of the n-th library write: additions and revisions are ordered in time. */
const at = (second: number) => `2026-09-29T11:00:0${second}.000Z`;

const background = {
  level: "undergraduate",
  summary: "Propositional logic.",
  assumptions: [],
  domains: ["logic"],
  maximumLevel: "undergraduate",
} as const;
const widened = { ...background, domains: ["logic", "analysis"], maximumLevel: "graduate" };

export type ArtifactScenario = Readonly<{
  store: MemoryLibraryStore;
  service: ProofHttpService;
  origin: string;
  sessionId: string;
  rootNodeId: string;
  get(path: string): Promise<Response>;
  post(path: string, body: unknown): Promise<Response>;
  /** `GET /proof-sessions/:id/export` of the scenario session, parsed. */
  exportArtifact(sessionId?: string): Promise<ProofArtifact>;
}>;

export function contrapositionProblem(): CorpusProblem {
  const problem = BENCHMARK_CORPUS.find(({ id }) => id === "corpus:contraposition");
  if (problem === undefined) throw new Error("corpus:contraposition is missing.");
  return problem;
}

export function libraryResult(
  id: string,
  classification: Readonly<{ domains: readonly string[]; level: string }>,
): LibraryResult {
  return libraryResultSchema.parse({
    kind: "result",
    id,
    name: "Excluded middle",
    description: "A test-only background result.",
    renderings: { latex: "p \\lor \\lnot p", naturalLanguage: "p or not p" },
    classification,
    provenance: { kind: "curated", source: "unit test" },
    approval: { status: "approved", reviewerId: "reviewer:test" },
    layer: "proof-time-background",
    related: [],
    priority: 1,
    parameters: [
      {
        id: "declaration:p",
        symbol: "p",
        sort: { kind: "proposition" },
        role: "universal-parameter",
      },
    ],
    statement: { expression: ["Or", "p", ["Not", "p"]] },
    premises: [],
    sideConditions: [],
    applicationDirections: ["backward"],
    patterns: [
      {
        id: "pattern:excluded-middle",
        expression: ["Or", "p", ["Not", "p"]],
        direction: "backward",
        requirement: { section: "goal", polarity: "any", role: "proposition" },
      },
    ],
  });
}

/** Start an empty scenario session (root node and metadata only) with its HTTP service. */
export async function startArtifactService(
  services: ProofHttpService[],
  sessionId = ARTIFACT_SESSION_ID,
  store = new MemoryLibraryStore(),
): Promise<ArtifactScenario> {
  const problem = contrapositionProblem();
  const operators = problem.operators as NonNullable<ProtocolEnvironment["operators"]>;
  const rootNode = createProofNodeSchema({ operators }).parse({
    id: "node:contraposition-root",
    state: corpusRootState(problem, "state:contraposition-root"),
  });
  expect(
    await initializeProofSession(store, {
      sessionId,
      rootNode,
      operators,
      metadata: {
        problem: { title: problem.title, statement: problem.statement },
        background,
        libraryLayerIds: ["layer:global", "layer:proof-time-background"],
      },
    }),
  ).toMatchObject({ status: "committed" });
  const service = createProofHttpService(store, { library: store, now: FIXED_NOW });
  services.push(service);
  const { origin } = await service.listen();
  const sessionUrl = (id: string) => `${origin}/proof-sessions/${encodeURIComponent(id)}`;
  const post = (path: string, body: unknown) =>
    fetch(`${sessionUrl(sessionId)}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const get = (path: string) => fetch(`${sessionUrl(sessionId)}/${path}`);
  return {
    store,
    service,
    origin,
    sessionId,
    rootNodeId: rootNode.id,
    get,
    post,
    async exportArtifact(id = sessionId) {
      const response = await fetch(`${sessionUrl(id)}/export`);
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as ProofArtifact;
    },
  };
}

async function expectStatus(response: Promise<Response>, status: number): Promise<unknown> {
  const settled = await response;
  const body = (await settled.json()) as unknown;
  expect(settled.status, JSON.stringify(body)).toBe(status);
  return body;
}

async function currentNodeId(scenario: ArtifactScenario): Promise<string> {
  const body = (await (
    await fetch(`${scenario.origin}/proof-sessions/${encodeURIComponent(scenario.sessionId)}`)
  ).json()) as { session: { currentNodeId: string } };
  return body.session.currentNodeId;
}

async function backtrack(scenario: ArtifactScenario, targetNodeId: string): Promise<void> {
  const expectedCurrentNodeId = await currentNodeId(scenario);
  if (expectedCurrentNodeId === targetNodeId) return;
  await expectStatus(scenario.post("backtrack", { expectedCurrentNodeId, targetNodeId }), 200);
}

async function envelope(
  scenario: ArtifactScenario,
  commandId: string,
  command: unknown,
): Promise<unknown> {
  return expectStatus(
    scenario.post("protocol-commands", {
      commandId,
      actor: HUMAN,
      basis: { nodeId: await currentNodeId(scenario) },
      command,
    }),
    201,
  );
}

/** Build the full scenario described in the module comment. */
export async function buildArtifactScenario(
  services: ProofHttpService[],
  sessionId = ARTIFACT_SESSION_ID,
): Promise<ArtifactScenario> {
  const scenario = await startArtifactService(services, sessionId);
  const problem = contrapositionProblem();
  const root = scenario.rootNodeId;

  await expectStatus(
    scenario.post("interaction-events", {
      id: "interaction:requested-1",
      nodeId: root,
      kind: "suggestions-requested",
      suggestionSetId: "suggestion-set:contraposition-1",
    }),
    201,
  );

  // The benchmark corpus solve: displayed suggestions, previews and applies only.
  const corpusSession: CorpusSession = {
    sessionUrl: `${scenario.origin}/proof-sessions/${encodeURIComponent(sessionId)}`,
    post: scenario.post,
    get: (path) =>
      path === undefined
        ? fetch(`${scenario.origin}/proof-sessions/${encodeURIComponent(sessionId)}`)
        : scenario.get(path),
  };
  for (const [index, step] of problem.steps.entries()) {
    await runCorpusStep(corpusSession, problem, step, index);
  }
  const history = (await (await scenario.get("history")).json()) as {
    edges: { edge: ProofEdge }[];
    nodes: ProofNode[];
  };
  const first = history.edges.find(
    ({ edge }) => edge.commandId === "command:contraposition-1",
  )?.edge;
  if (first?.suggestionSetId === undefined || first.chosenSuggestionId === undefined) {
    throw new Error("The first corpus step has no displayed suggestion.");
  }
  const afterFirst = first.childNodeId;

  // An inquiry command anchored at the root, naming the displayed suggestion that was chosen.
  await expectStatus(
    scenario.post("inquiry-commands", {
      commandId: "inquiry:opening",
      nodeId: root,
      records: [
        {
          id: "question:main",
          kind: "question",
          question: {
            form: "establish",
            proposition: {
              kind: "target",
              nodeId: root,
              target: { kind: "goal", id: "goal:main" },
            },
          },
        },
        {
          id: "objective:main",
          kind: "objective",
          questionId: "question:main",
          necessity: "required",
          focus: { nodeId: root, target: { kind: "goal", id: "goal:main" } },
        },
        {
          id: "attempt:introduce",
          kind: "attempt",
          objectiveId: "objective:main",
          method: { kind: "move", moveId: "move:introduce-implication" },
          suggestion: {
            suggestionSetId: first.suggestionSetId,
            suggestionId: first.chosenSuggestionId,
          },
        },
      ],
    }),
    201,
  );

  // A sorry that is deleted again (a tombstone), and one that is kept.
  await backtrack(scenario, root);
  await envelope(scenario, "command:sorry-deleted", { kind: "sorry", target: "g1" });
  await envelope(scenario, "command:delete-sorry", { kind: "delete-previous-move" });
  await envelope(scenario, "command:sorry-kept", { kind: "sorry", target: "g1" });

  // Backtracking with information: a case split on p at the root, from the first step's node.
  await backtrack(scenario, afterFirst);
  await expectStatus(
    scenario.post("backtrack-with-information", {
      commandId: "command:cases-on-p",
      expectedCurrentNodeId: afterFirst,
      sourceNodeId: afterFirst,
      proposition: "p",
    }),
    201,
  );

  // Semantic replay of the first corpus step onto the root.
  await backtrack(scenario, root);
  await expectStatus(
    scenario.post("replay", {
      commandId: "command:replay-first",
      expectedCurrentNodeId: root,
      source: { fromNodeId: root, toNodeId: afterFirst },
    }),
    201,
  );

  // Library additions: admitted, rejected outside the background, then admitted after a revision.
  const addition = (id: string, second: number, artifact: LibraryResult) => ({
    id,
    sessionId,
    occurredAt: at(second),
    layer: artifact.layer,
    origin: { kind: "user", actorId: "user:reader" },
    artifact,
  });
  const graduate = { domains: ["analysis"], level: "graduate" };
  const foundational = { domains: ["logic"], level: "foundational" };
  expect(
    await addLibraryArtifact(
      scenario.store,
      addition("addition:1", 1, libraryResult("result:logic", foundational)),
    ),
  ).toMatchObject({ status: "recorded", admitted: true });
  expect(
    await addLibraryArtifact(
      scenario.store,
      addition("addition:2", 2, libraryResult("result:analysis", graduate)),
    ),
  ).toMatchObject({ status: "recorded", admitted: false });
  expect(
    await reviseBackground(scenario.store, sessionId, {
      id: "revision:widen",
      occurredAt: at(3),
      previous: background,
      revised: widened,
      reason: "The proof needs analysis.",
      actor: { kind: "user", id: "user:reader" },
    }),
  ).toMatchObject({ status: "recorded" });
  expect(
    await addLibraryArtifact(
      scenario.store,
      addition("addition:3", 4, libraryResult("result:analysis-2", graduate)),
    ),
  ).toMatchObject({ status: "recorded", admitted: true });
  return scenario;
}

/**
 * An artifact without its digest and provenance: the fields that legitimately differ between an
 * export and the re-export of its import (besides the rebased session-ID fields).
 */
export function comparableContent(artifact: ProofArtifact): Record<string, unknown> {
  const content: Record<string, unknown> = { ...artifact };
  delete content.digest;
  delete content.provenance;
  return content;
}
